import { errors, type Locator as PwLocator, type Page } from "playwright";
import {
  describeAction,
  resolveNavigation,
  stepParamsSchemas,
  type FillValue,
  type Locator,
  type StepKindName,
} from "@/modules/execution/steps";
import type { SnapshotCase } from "@/modules/test-suites/snapshot";
import { BLOCKED_HEADER } from "@/worker/browser/sandbox";

/**
 * Executes one test case's steps. Each step kind maps to a fixed Playwright call; there is no
 * code path that evaluates step content as JavaScript. Secret values are substituted only at
 * the moment of filling and scrubbed from anything recorded.
 */

export type StepOutcome = {
  position: number;
  kind: StepKindName | null;
  action: string;
  expected: string | null;
  actual: string | null;
  status: "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "ERROR";
  durationMs: number;
  error: string | null;
  screenshot: Buffer | null;
};

export type CaseOutcome = {
  status: "PASSED" | "FAILED" | "BLOCKED" | "ERROR" | "SKIPPED";
  steps: StepOutcome[];
  error: string | null;
  suspectedCause: string | null;
};

export type ExecuteOptions = {
  authorizedUrl: string;
  stepTimeoutMs: number;
  /** Resolves a secret name to its value (only called for FILL steps). */
  resolveSecret: (name: string) => Promise<string>;
  /** Polled between steps; false stops the case (cancellation, deadline). */
  shouldContinue: () => Promise<boolean>;
};

/** Infrastructure failures (browser crashed, etc.) — the run may be retried. */
export class InfrastructureError extends Error {}

class AssertionFailure extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Expected ${expected}, got ${actual}`);
  }
}

const clip = (value: string, max = 500) => value.replace(/\s+/g, " ").trim().slice(0, max);

function locate(page: Page, locator: Locator): PwLocator {
  switch (locator.by) {
    case "css": return page.locator(locator.value);
    case "role": return page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
    case "label": return page.getByLabel(locator.value, { exact: locator.exact });
    case "text": return page.getByText(locator.value, { exact: locator.exact });
    case "placeholder": return page.getByPlaceholder(locator.value);
    case "testId": return page.getByTestId(locator.value);
  }
}

function isInfrastructure(error: unknown): boolean {
  const text = String(error);
  return /Target page, context or browser has been closed|Browser has been closed|browserContext\.newPage|Protocol error|net::ERR_PROXY_CONNECTION_FAILED|ECONNREFUSED 127\.0\.0\.1/.test(text);
}

function suspectedCause(error: unknown): string {
  if (error instanceof AssertionFailure) return "The application's behaviour differs from the expected result.";
  if (error instanceof errors.TimeoutError) return "The element wasn't found or didn't become ready in time — the selector may be outdated or the page may have changed.";
  const text = String(error);
  if (/strict mode violation/.test(text)) return "The locator matches more than one element.";
  if (/outside the authorized URL/.test(text)) return "The step tried to leave the authorized URL.";
  return "The step raised an error.";
}

async function runStep(page: Page, kind: StepKindName, rawParams: unknown, options: ExecuteOptions, timeout: number): Promise<string | null> {
  switch (kind) {
    case "NAVIGATE": {
      const { url } = stepParamsSchemas.NAVIGATE.parse(rawParams);
      const target = resolveNavigation(url, options.authorizedUrl);
      if (!target) throw new Error("Navigation target is outside the authorized URL");
      const response = await page.goto(target, { timeout, waitUntil: "domcontentloaded" });
      if (response?.headers()[BLOCKED_HEADER]) throw new Error("Navigation was redirected outside the authorized URL");
      return `${response?.status() ?? "-"} ${page.url()}`;
    }
    case "CLICK": {
      const { target } = stepParamsSchemas.CLICK.parse(rawParams);
      await locate(page, target).click({ timeout });
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
      return `Clicked; now at ${page.url()}`;
    }
    case "FILL": {
      const { target, value } = stepParamsSchemas.FILL.parse(rawParams);
      const text = await fillValue(value, options);
      await locate(page, target).fill(text, { timeout });
      return "secret" in value ? "Filled with secret value (hidden)" : `Filled ${value.literal.length} characters`;
    }
    case "SELECT": {
      const { target, option } = stepParamsSchemas.SELECT.parse(rawParams);
      const selected = await locate(page, target).selectOption({ label: option }, { timeout }).catch(() => locate(page, target).selectOption(option, { timeout }));
      return `Selected ${selected.join(", ")}`;
    }
    case "WAIT": {
      const wait = stepParamsSchemas.WAIT.parse(rawParams);
      if (wait.for === "time") {
        await page.waitForTimeout(Math.min(wait.ms!, timeout));
        return `Waited ${wait.ms}ms`;
      }
      if (wait.for === "url") {
        await page.waitForURL((url) => url.toString().includes(wait.urlContains!), { timeout });
        return page.url();
      }
      await locate(page, wait.target!).first().waitFor({ state: wait.for, timeout });
      return `Element ${wait.for}`;
    }
    case "ASSERT":
      return runAssertion(page, rawParams, timeout);
  }
}

async function fillValue(value: FillValue, options: ExecuteOptions): Promise<string> {
  return "secret" in value ? options.resolveSecret(value.secret) : value.literal;
}

async function runAssertion(page: Page, rawParams: unknown, timeout: number): Promise<string> {
  const a = stepParamsSchemas.ASSERT.parse(rawParams);
  const expected = a.expected === undefined ? "" : String(a.expected);
  const target = a.target ? locate(page, a.target) : null;
  // Poll until the condition holds or the step times out, like a web-first assertion.
  const deadline = Date.now() + timeout;
  let actual = "";
  for (;;) {
    let ok = false;
    switch (a.check) {
      case "visible":
        ok = await target!.first().isVisible();
        actual = ok ? "visible" : (await target!.count()) ? "present but hidden" : "not found";
        break;
      case "hidden":
        ok = !(await target!.first().isVisible());
        actual = ok ? "hidden" : "visible";
        break;
      case "textContains":
      case "textEquals": {
        const text = (await target!.count()) ? clip(await target!.first().innerText({ timeout: 1_000 }).catch(() => "")) : "(element not found)";
        actual = text;
        ok = a.check === "textEquals" ? text === expected : text.includes(expected);
        break;
      }
      case "valueEquals":
        actual = (await target!.count()) ? clip(await target!.first().inputValue({ timeout: 1_000 }).catch(() => ""), 1000) : "(element not found)";
        ok = actual === expected;
        break;
      case "urlContains":
        actual = page.url();
        ok = actual.includes(expected);
        break;
      case "titleContains":
        actual = clip(await page.title());
        ok = actual.includes(expected);
        break;
      case "count":
        actual = String(await target!.count());
        ok = actual === expected;
        break;
    }
    if (ok) return actual;
    if (Date.now() >= deadline) throw new AssertionFailure(`${a.check}${expected ? ` "${clip(expected, 200)}"` : ""}`, actual || "(nothing)");
    await page.waitForTimeout(150);
  }
}

/** Replaces any secret value that leaked into recorded text. */
export function scrubSecrets(text: string | null, secrets: string[]): string | null {
  if (!text) return text;
  return secrets.filter((s) => s.length >= 3).reduce((acc, secret) => acc.split(secret).join("••••••"), text);
}

export async function executeCase(page: Page, testCase: SnapshotCase, options: ExecuteOptions): Promise<CaseOutcome> {
  const steps: StepOutcome[] = [];
  const usedSecrets: string[] = [];
  const opts: ExecuteOptions = {
    ...options,
    resolveSecret: async (name) => {
      const value = await options.resolveSecret(name);
      usedSecrets.push(value);
      return value;
    },
  };

  // Cases with descriptive (non-executable) steps are not run at all.
  if (testCase.steps.some((s) => s.kind === null)) {
    return {
      status: "BLOCKED",
      error: "This case has manual steps without executable actions.",
      suspectedCause: null,
      steps: testCase.steps.map((s) => ({ position: s.position, kind: s.kind as StepKindName | null, action: s.action, expected: s.expectedResult, actual: null, status: "BLOCKED", durationMs: 0, error: null, screenshot: null })),
    };
  }

  let failure: { status: "FAILED" | "ERROR"; error: string; cause: string } | null = null;
  let stopped = false;
  for (const step of testCase.steps) {
    const kind = step.kind as StepKindName;
    const base = { position: step.position, kind, action: `${step.action} — ${describeAction(kind, step.params)}`, expected: step.expectedResult };
    if (failure || stopped || !(await options.shouldContinue())) {
      stopped = stopped || !failure;
      steps.push({ ...base, actual: null, status: "SKIPPED", durationMs: 0, error: null, screenshot: null });
      continue;
    }
    const started = Date.now();
    try {
      const actual = await runStep(page, kind, step.params, opts, options.stepTimeoutMs);
      const screenshot = await page.screenshot({ type: "png", timeout: 5_000 }).catch(() => null);
      steps.push({ ...base, actual: scrubSecrets(actual, usedSecrets), status: "PASSED", durationMs: Date.now() - started, error: null, screenshot });
    } catch (error) {
      if (isInfrastructure(error)) throw new InfrastructureError(String(error).split("\n")[0]);
      const screenshot = await page.screenshot({ type: "png", timeout: 5_000 }).catch(() => null);
      const isAssertion = error instanceof AssertionFailure;
      const message = scrubSecrets(
        error instanceof errors.TimeoutError ? `Timed out after ${options.stepTimeoutMs}ms: ${String(error.message).split("\n")[0]}` : String((error as Error).message ?? error).split("\n")[0],
        usedSecrets,
      )!.slice(0, 1000);
      steps.push({
        ...base,
        actual: isAssertion ? scrubSecrets((error as AssertionFailure).actual, usedSecrets) : null,
        expected: isAssertion ? (error as AssertionFailure).expected : base.expected,
        status: "FAILED",
        durationMs: Date.now() - started,
        error: message,
        screenshot,
      });
      failure = { status: "FAILED", error: `Step ${step.position + 1}: ${message}`, cause: suspectedCause(error) };
    }
  }

  if (failure) return { status: failure.status, steps, error: failure.error, suspectedCause: failure.cause };
  if (stopped) return { status: "SKIPPED", steps, error: "Stopped before the case finished (cancelled or out of time).", suspectedCause: null };
  return { status: "PASSED", steps, error: null, suspectedCause: null };
}
