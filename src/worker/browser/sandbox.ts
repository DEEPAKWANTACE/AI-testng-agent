import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";
import { defaultPort, resolveTarget } from "@/modules/discovery/network-policy";
import { startEgressProxy, type BlockedRequest, type EgressProxy } from "@/worker/discovery/egress-proxy";

/**
 * Sandboxed Chromium shared by the discovery crawler and the test executor:
 * - all traffic goes through the filtering egress proxy (SSRF protection, connect-time DNS checks);
 * - fresh, storage-less contexts with downloads, service workers and permissions blocked;
 * - main-frame navigations and redirects outside the authorized URL are answered locally
 *   (never fetched) via CDP Fetch interception.
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; QA-Agent/1.0; +authorized-testing)";
export const BLOCKED_HEADER = "x-qa-agent-blocked";
const BLOCKED_PAGE = Buffer.from("<!doctype html><title>Blocked</title><p>Blocked by QA Agent: outside the authorized URL.</p>").toString("base64");

/** The target itself is not allowed (private, metadata, unresolvable…). */
export class TargetBlockedError extends Error {}

/** A same-origin document or XHR/fetch response, as seen at the response stage. */
export type InterceptedResponse = { url: string; method: string; type: "document" | "api"; status: number; headers: Array<{ name: string; value: string }>; body: Buffer };
export type ReplacementResponse = { status: number; headers: Array<{ name: string; value: string }>; body: Buffer };

/**
 * Optional response hooks (mutation testing): `observe` sees same-origin responses, `mutate`
 * may replace one. Only responses are touched, never requests, so the server receives exactly
 * what the approved steps send.
 */
export type ResponseHooks = {
  observe?: (response: InterceptedResponse) => void;
  mutate?: (response: InterceptedResponse) => ReplacementResponse | null;
};
const MAX_HOOK_BODY = 1_000_000;

export type Sandbox = {
  browser: Browser;
  proxy: EgressProxy;
  blocked: BlockedRequest[];
  redirectsBlocked: Array<{ from: string; to: string }>;
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /** New page with navigation-scope enforcement installed (and optional response hooks). */
  newPage: (context: BrowserContext, hooks?: ResponseHooks) => Promise<Page>;
  close: () => Promise<void>;
};

export async function launchSandbox(options: { authorizedUrl: string; allowExternalAssets: boolean; userAgent?: string }): Promise<Sandbox> {
  const authorized = new URL(options.authorizedUrl);
  const port = defaultPort(authorized);
  const target = await resolveTarget(authorized.hostname, port);
  if (!target.ok) throw new TargetBlockedError(`Target blocked: ${target.detail}.`);

  const proxy = await startEgressProxy({ target: { hostname: authorized.hostname, port }, allowExternal: options.allowExternalAssets });
  const redirectsBlocked: Array<{ from: string; to: string }> = [];
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking"],
    });
  } catch (error) {
    await proxy.close();
    throw error;
  }

  const contexts = new Set<BrowserContext>();
  return {
    browser,
    proxy,
    blocked: proxy.blocked,
    redirectsBlocked,
    newContext: async (contextOptions = {}) => {
      const context = await browser.newContext({
        userAgent: options.userAgent ?? USER_AGENT,
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        permissions: [],
        javaScriptEnabled: true,
        ...contextOptions,
      });
      contexts.add(context);
      context.on("close", () => contexts.delete(context));
      return context;
    },
    newPage: async (context, hooks) => {
      const page = await context.newPage();
      // Popups and new windows are closed; dialogs dismissed.
      context.on("page", (popup) => {
        if (popup !== page) void popup.close().catch(() => {});
      });
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
      await enforceNavigationScope(page, options.authorizedUrl, {
        onBlockedNavigation: (url) => proxy.blocked.push({ target: url, reason: "out-of-scope", detail: "Navigation outside the authorized URL" }),
        onBlockedRedirect: (from, to) => redirectsBlocked.push({ from, to }),
        hooks,
      });
      return page;
    },
    close: async () => {
      for (const context of contexts) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await proxy.close();
    },
  };
}

/**
 * Pauses main-frame document requests and responses (CDP Fetch domain):
 * - request stage: navigations outside the authorized URL are answered locally;
 * - response stage: redirects whose Location leaves the authorized URL are answered locally,
 *   so the target is never requested. (Playwright's route() doesn't see redirect hops.)
 * Blocked navigations are answered (not failed) so Chromium doesn't later commit an error
 * page that would interrupt the next navigation.
 */
export async function enforceNavigationScope(
  page: Page,
  authorizedUrl: string,
  handlers: { onBlockedNavigation: (url: string) => void; onBlockedRedirect: (from: string, to: string) => void; hooks?: ResponseHooks },
) {
  const origin = new URL(authorizedUrl).origin;
  const hooks = handlers.hooks?.observe || handlers.hooks?.mutate ? handlers.hooks : undefined;
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const mainFrameId = frameTree.frame.id;

  cdp.on("Fetch.requestPaused", async (event) => {
    const { requestId, request, frameId, responseStatusCode, responseHeaders } = event;
    const answerBlocked = () =>
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: BLOCKED_HEADER, value: "navigation-scope" },
        ],
        body: BLOCKED_PAGE,
      });
    try {
      const isDocument = event.resourceType === "Document";
      // XHR/fetch responses are only paused when hooks are installed.
      if (!isDocument) {
        if (responseStatusCode === undefined) await cdp.send("Fetch.continueRequest", { requestId });
        else if (!(await applyHooks(event))) await cdp.send("Fetch.continueResponse", { requestId });
        return;
      }
      if (frameId !== mainFrameId) {
        await (responseStatusCode === undefined ? cdp.send("Fetch.continueRequest", { requestId }) : cdp.send("Fetch.continueResponse", { requestId }));
        return;
      }
      if (responseStatusCode === undefined) {
        if (!isWithinAuthorizedUrl(request.url, authorizedUrl)) {
          handlers.onBlockedNavigation(request.url);
          await answerBlocked();
        } else {
          await cdp.send("Fetch.continueRequest", { requestId });
        }
        return;
      }
      const location = responseHeaders?.find((h) => h.name.toLowerCase() === "location")?.value;
      if (responseStatusCode >= 300 && responseStatusCode < 400 && location) {
        const target = new URL(location, request.url).toString();
        if (!isWithinAuthorizedUrl(target, authorizedUrl)) {
          handlers.onBlockedRedirect(request.url, target);
          await answerBlocked();
          return;
        }
      }
      if (await applyHooks(event)) return;
      await cdp.send("Fetch.continueResponse", { requestId });
    } catch {
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });

  /** Runs the hooks on a same-origin, non-redirect response; true if it was answered here. */
  async function applyHooks(event: { requestId: string; request: { url: string; method: string }; resourceType: string; responseStatusCode?: number; responseHeaders?: Array<{ name: string; value: string }> }): Promise<boolean> {
    if (!hooks || event.responseStatusCode === undefined || (event.responseStatusCode >= 300 && event.responseStatusCode < 400)) return false;
    let url: URL;
    try {
      url = new URL(event.request.url);
    } catch {
      return false;
    }
    if (url.origin !== origin) return false;
    const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", { requestId: event.requestId }).catch(() => ({ body: null, base64Encoded: false }) as { body: string | null; base64Encoded: boolean });
    if (body === null) return false;
    const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
    if (bytes.length > MAX_HOOK_BODY) return false;
    const response: InterceptedResponse = { url: url.toString(), method: event.request.method, type: event.resourceType === "Document" ? "document" : "api", status: event.responseStatusCode, headers: event.responseHeaders ?? [], body: bytes };
    hooks.observe?.(response);
    const replacement = hooks.mutate?.(response);
    if (!replacement) return false;
    await cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: replacement.status, responseHeaders: replacement.headers, body: replacement.body.toString("base64") });
    return true;
  }

  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
      { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
      ...(hooks
        ? [
            { urlPattern: "*", resourceType: "XHR" as const, requestStage: "Response" as const },
            { urlPattern: "*", resourceType: "Fetch" as const, requestStage: "Response" as const },
          ]
        : []),
    ],
  });
}
