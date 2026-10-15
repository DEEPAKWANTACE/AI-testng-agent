import { errors, type Page } from "playwright";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";
import { evaluateLink, normalizeUrl, type SkipReason } from "@/modules/discovery/crawl-url";
import { countElements, EMPTY_PAGE_ELEMENTS, type PageElements } from "@/modules/discovery/page-elements";
import { BLOCKED_HEADER, launchSandbox, TargetBlockedError, type Sandbox } from "@/worker/browser/sandbox";
import type { BlockedRequest } from "./egress-proxy";
import { extractPageElements } from "./extract";

export type CrawlCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector?: string | null;
  passwordSelector?: string | null;
  submitSelector?: string | null;
  successSelector?: string | null;
};

export type CrawlOptions = {
  authorizedUrl: string;
  startUrl: string;
  maxDepth: number;
  maxPages: number;
  pageTimeoutMs: number;
  runTimeoutMs: number;
  allowExternalAssets: boolean;
  credentials?: CrawlCredentials;
  /** Called after each page; persist results here. */
  onPage: (page: CrawledPage) => Promise<void>;
  /** Polled between pages; return false to stop (e.g. the run was cancelled). */
  shouldContinue: () => Promise<boolean>;
};

export type CrawledPage = {
  url: string;
  title: string | null;
  depth: number;
  statusCode: number | null;
  loadTimeMs: number;
  elements: PageElements;
  error: string | null;
  screenshot: Buffer | null;
};

export type CrawlStats = {
  pagesVisited: number;
  pagesFailed: number;
  totals: { links: number; forms: number; buttons: number; inputs: number; navigation: number };
  skippedLinks: Record<SkipReason | "depth-limit" | "duplicate", number>;
  redirectsBlocked: Array<{ from: string; to: string }>;
  blockedRequests: BlockedRequest[];
  stoppedBy: "completed" | "max-pages" | "time-limit" | "cancelled";
  authenticated: boolean;
};

/** Expected, user-facing failures (bad target, login failed…). */
export class CrawlError extends Error {}

const USER_AGENT = "Mozilla/5.0 (compatible; QA-Agent-Discovery/1.0; +authorized-testing)";
const SETTLE_MS = 2_000;

function message(error: unknown): string {
  if (error instanceof errors.TimeoutError) return "Timed out";
  return error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : "Unknown error";
}

async function signIn(page: Page, creds: CrawlCredentials, authorizedUrl: string, timeoutMs: number) {
  if (!isWithinAuthorizedUrl(creds.loginUrl, authorizedUrl)) throw new CrawlError("Login URL is outside the authorized URL.");
  try {
    await page.goto(creds.loginUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    const password = page.locator(creds.passwordSelector || 'input[type="password"]').first();
    // Default selectors are scoped to the form holding the password field, so other forms on
    // the page (e.g. a header search box) can't be filled or submitted by mistake.
    const loginForm = password.locator("xpath=ancestor::form[1]");
    const scope = (await loginForm.count()) > 0 ? loginForm : page.locator("body");
    const username = creds.usernameSelector
      ? page.locator(creds.usernameSelector).first()
      : scope
          .locator('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[type="text"], input:not([type])')
          .first();
    await username.fill(creds.username, { timeout: timeoutMs });
    await password.fill(creds.password, { timeout: timeoutMs });

    const submit = creds.submitSelector
      ? page.locator(creds.submitSelector).first()
      : scope.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    const navigated = page
      .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: Math.min(timeoutMs, 10_000) })
      .catch(() => null);
    if ((await submit.count()) > 0) await submit.click({ timeout: timeoutMs });
    else await password.press("Enter");
    await navigated;
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
  } catch (error) {
    // Never include credentials or field contents in the message.
    throw new CrawlError(`Login failed: ${message(error)}`);
  }

  const stillOnLogin = normalizeUrl(page.url()) === normalizeUrl(creds.loginUrl);
  const ok = creds.successSelector
    ? (await page.locator(creds.successSelector).count()) > 0
    : !stillOnLogin && (await page.locator('input[type="password"]').count()) === 0;
  if (!ok) throw new CrawlError("Login failed: the sign-in form was still shown after submitting. Check the credentials and selectors.");
}

export async function crawl(options: CrawlOptions): Promise<CrawlStats> {
  const deadline = Date.now() + options.runTimeoutMs;

  // Refuses targets that resolve to blocked addresses before starting a browser.
  let sandbox: Sandbox;
  try {
    sandbox = await launchSandbox({ authorizedUrl: options.authorizedUrl, allowExternalAssets: options.allowExternalAssets, userAgent: USER_AGENT });
  } catch (error) {
    throw error instanceof TargetBlockedError ? new CrawlError(error.message) : error;
  }
  if (!isWithinAuthorizedUrl(options.startUrl, options.authorizedUrl)) {
    await sandbox.close();
    throw new CrawlError("Start URL is outside the authorized URL.");
  }

  const stats: CrawlStats = {
    pagesVisited: 0,
    pagesFailed: 0,
    totals: { links: 0, forms: 0, buttons: 0, inputs: 0, navigation: 0 },
    skippedLinks: { invalid: 0, "unsupported-scheme": 0, "out-of-scope": 0, excluded: 0, download: 0, "depth-limit": 0, duplicate: 0 },
    redirectsBlocked: sandbox.redirectsBlocked,
    blockedRequests: sandbox.blocked,
    stoppedBy: "completed",
    authenticated: false,
  };

  // Hard stop: closing the browser aborts any in-flight navigation at the deadline.
  // The deadline counts from the start of the crawl, including browser launch.
  const killTimer = setTimeout(() => {
    stats.stoppedBy = "time-limit";
    void sandbox.browser.close().catch(() => {});
  }, Math.max(0, deadline - Date.now()));

  try {
    const context = await sandbox.newContext();
    context.setDefaultTimeout(options.pageTimeoutMs);
    // Navigation scope (incl. same-host redirects outside the authorized path) is enforced by
    // the sandbox before any redirect is followed; cross-host traffic by its egress proxy.
    const page = await sandbox.newPage(context);

    if (options.credentials) {
      await signIn(page, options.credentials, options.authorizedUrl, options.pageTimeoutMs);
      stats.authenticated = true;
    }

    const queue: Array<{ url: string; depth: number }> = [{ url: normalizeUrl(options.startUrl), depth: 0 }];
    const seen = new Set(queue.map((item) => item.url));
    const loginUrl = options.credentials ? normalizeUrl(options.credentials.loginUrl) : null;

    while (queue.length > 0) {
      if (Date.now() >= deadline) {
        stats.stoppedBy = "time-limit";
        break;
      }
      if (stats.pagesVisited >= options.maxPages) {
        stats.stoppedBy = "max-pages";
        break;
      }
      if (!(await options.shouldContinue())) {
        stats.stoppedBy = "cancelled";
        break;
      }

      const { url, depth } = queue.shift()!;
      const started = Date.now();
      const timeout = Math.max(1_000, Math.min(options.pageTimeoutMs, deadline - Date.now()));
      let statusCode: number | null = null;
      let error: string | null = null;
      let finalUrl = url;

      try {
        const response = await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
        // Blocked by the navigation scope policy (already recorded as evidence): not a page.
        if (response?.headers()[BLOCKED_HEADER]) continue;
        statusCode = response?.status() ?? null;
        await page.waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, timeout) }).catch(() => {});
        finalUrl = normalizeUrl(page.url());
      } catch (cause) {
        error = message(cause);
      }

      if (!error && finalUrl !== url) {
        // Redirected: only keep the page if it landed in scope and isn't already known.
        if (!isWithinAuthorizedUrl(finalUrl, options.authorizedUrl)) {
          stats.redirectsBlocked.push({ from: url, to: finalUrl });
          continue;
        }
        if (seen.has(finalUrl)) {
          stats.skippedLinks.duplicate++;
          continue;
        }
        seen.add(finalUrl);
      }

      let elements = EMPTY_PAGE_ELEMENTS;
      let title: string | null = null;
      let screenshot: Buffer | null = null;
      if (!error && page.url().startsWith("http")) {
        try {
          title = (await page.title()).slice(0, 300) || null;
          elements = await extractPageElements(page);
          screenshot = await page.screenshot({ type: "png", timeout: Math.min(5_000, timeout) });
        } catch (cause) {
          error = `Could not read page: ${message(cause)}`;
        }
      }

      stats.pagesVisited++;
      if (error) stats.pagesFailed++;
      const counts = countElements(elements);
      for (const key of Object.keys(stats.totals) as Array<keyof typeof counts>) stats.totals[key] += counts[key];

      await options.onPage({ url: finalUrl, title, depth, statusCode, loadTimeMs: Date.now() - started, elements, error, screenshot });

      // Queue in-scope links for the next level.
      for (const link of elements.links) {
        const decision = evaluateLink(link.href, finalUrl, options.authorizedUrl);
        if (!decision.ok) {
          stats.skippedLinks[decision.reason]++;
          continue;
        }
        if (seen.has(decision.url) || decision.url === loginUrl) {
          stats.skippedLinks.duplicate++;
          continue;
        }
        if (depth + 1 > options.maxDepth) {
          stats.skippedLinks["depth-limit"]++;
          continue;
        }
        seen.add(decision.url);
        queue.push({ url: decision.url, depth: depth + 1 });
      }
    }
  } catch (error) {
    if (stats.stoppedBy === "time-limit") return stats;
    throw error;
  } finally {
    clearTimeout(killTimer);
    // Running out of time is reported however the loop ended (e.g. the last page timed out).
    if (stats.stoppedBy === "completed" && Date.now() >= deadline) stats.stoppedBy = "time-limit";
    await sandbox.close();
  }
  return stats;
}
