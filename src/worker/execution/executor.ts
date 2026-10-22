import { randomBytes, randomInt } from "node:crypto";
import { errors, type Locator as PwLocator, type Page, type Response } from "playwright";
import type { FailureClass } from "@/generated/prisma/enums";
import { checkContract, resolvePointer } from "@/modules/execution/contract";
import { evaluateComparison, ExpressionError, formatValue, parseComparison, parseDisplayedNumber, type Value } from "@/modules/execution/expression";
import {
  DEFAULT_MAX_DIFF_RATIO,
  DEFAULT_PIXEL_THRESHOLD,
  describeAction,
  resolveNavigation,
  stepParamsSchemas,
  type FillValue,
  type Locator,
  type StepKindName,
} from "@/modules/execution/steps";
import { classifyStepError, errorKindOf } from "@/modules/execution/verdict";
import type { SnapshotCase } from "@/modules/test-suites/snapshot";
import { BLOCKED_HEADER } from "@/worker/browser/sandbox";
import { compareImages } from "./visual";

/**
 * Executes one test case's steps. Each step kind maps to a fixed Playwright call; there is no
 * code path that evaluates step content as JavaScript. (API_GET runs one fixed, built-in fetch
 * function in the page with the validated URL as its only argument.) Secret values are
 * substituted only at the moment of filling and scrubbed from anything recorded.
 */

export type StepOutcome = {
  position: number;
  kind: StepKindName | null;
  action: string;
  expected: string | null;
  actual: string | null;
  status: "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "INCONCLUSIVE";
  failureClass: FailureClass | null;
  durationMs: number;
  error: string | null;
  screenshot: Buffer | null;
  /** ASSERT_VISUAL evidence: the capture, and a diff image when it didn't match. */
  visual?: VisualEvidence;
};

export type VisualEvidence = { name: string; capture: Buffer; baselineId: string | null; diff: Buffer | null; diffRatio: number | null };

export type CaseOutcome = {
  status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "SKIPPED";
  failureClass: FailureClass | null;
  steps: StepOutcome[];
  error: string | null;
  suspectedCause: string | null;
  /** Set by the runner after reproduction attempts. */
  reproduced?: boolean;
  flaky?: boolean;
  /** Same-origin pages and API calls the case reached (paths only; no query strings). */
  network?: NetworkHit[];
};

export type NetworkHit = { type: "page" | "api"; method: string; path: string; status: number };
const MAX_NETWORK_HITS = 200;

export type ExecuteOptions = {
  authorizedUrl: string;
  stepTimeoutMs: number;
  /** Resolves a secret name to its value (only called for FILL steps). */
  resolveSecret: (name: string) => Promise<string>;
  /** Polled between steps; false stops the case (cancellation, deadline). */
  shouldContinue: () => Promise<boolean>;
  /** The approved baseline for an ASSERT_VISUAL name in this case, if any. */
  approvedBaseline?: (name: string) => Promise<{ id: string; png: Buffer } | null>;
};

/** Infrastructure failures (browser crashed, etc.) — the run may be retried. */
export class InfrastructureError extends Error {}

/** A precondition (secret, test data) couldn't be satisfied; nothing about the app is known. */
export class PreconditionError extends Error {}

/** The step can't be carried out as written; says nothing about the application. */
export class StepDefinitionError extends Error {}

/** A visual check ran, but there's no approved baseline to compare with. */
export class NoBaselineError extends Error {}

class AssertionFailure extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Expected ${expected}, got ${actual}`);
  }
}

/** A response the case can inspect: fetched by API_GET or made by the page itself. */
type CapturedResponse = { method: string; url: string; status: number; contentType: string; body: Promise<string | null> };

/** Per-execution state: values and responses captured by earlier steps. */
type CaseState = {
  vars: Map<string, Value>;
  responses: Map<string, CapturedResponse>;
  /** Same-origin XHR/fetch responses the page made, newest last. */
  observed: CapturedResponse[];
  usedSecrets: string[];
  /** Visual evidence of the step being executed. */
  visual: VisualEvidence | null;
};

const MAX_BODY_BYTES = 1_000_000;
const MAX_OBSERVED = 200;

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

const variable = (state: CaseState, name: string): Value => {
  const value = state.vars.get(name);
  if (value === undefined) throw new StepDefinitionError(`Variable ${name} has no value`);
  return value;
};

async function runStep(page: Page, kind: StepKindName, rawParams: unknown, options: ExecuteOptions, state: CaseState, timeout: number): Promise<string | null> {
  switch (kind) {
    case "NAVIGATE": {
      const { url } = stepParamsSchemas.NAVIGATE.parse(rawParams);
      const target = resolveNavigation(url, options.authorizedUrl);
      if (!target) throw new Error("Navigation target is outside the authorized URL");
      const response = await page.goto(target, { timeout, waitUntil: "domcontentloaded" });
      if (response?.headers()[BLOCKED_HEADER]) throw new Error("Navigation was redirected outside the authorized URL");
      return `${response?.status() ?? "-"} ${page.url()}`;
    }
    case "RELOAD": {
      stepParamsSchemas.RELOAD.parse(rawParams);
      const response = await page.reload({ timeout, waitUntil: "domcontentloaded" });
      if (response?.headers()[BLOCKED_HEADER]) throw new Error("Navigation was redirected outside the authorized URL");
      return `Reloaded: ${response?.status() ?? "-"} ${page.url()}`;
    }
    case "CLICK": {
      const { target } = stepParamsSchemas.CLICK.parse(rawParams);
      await locate(page, target).click({ timeout });
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
      return `Clicked; now at ${page.url()}`;
    }
    case "FILL": {
      const { target, value } = stepParamsSchemas.FILL.parse(rawParams);
      const { text, note } = await fillValue(value, options, state);
      await locate(page, target).fill(text, { timeout });
      return note;
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
      return runAssertion(page, rawParams, state, timeout);
    case "EXTRACT":
      return runExtract(page, rawParams, state, timeout);
    case "ASSERT_CALC": {
      const { expression, tolerance } = stepParamsSchemas.ASSERT_CALC.parse(rawParams);
      let result;
      try {
        result = evaluateComparison(parseComparison(expression), state.vars, tolerance);
      } catch (error) {
        if (error instanceof ExpressionError) throw new StepDefinitionError(error.message);
        throw error;
      }
      const evaluated = `${formatValue(result.left)} ${result.op} ${formatValue(result.right)}`;
      if (!result.ok) throw new AssertionFailure(expression, `${evaluated} is false`);
      return evaluated;
    }
    case "API_GET":
      return runApiGet(page, rawParams, options, state, timeout);
    case "ASSERT_RESPONSE":
      return runResponseCheck(page, rawParams, state, timeout);
    case "ASSERT_VISUAL":
      return runVisualCheck(page, rawParams, options, state, timeout);
  }
}

async function runVisualCheck(page: Page, rawParams: unknown, options: ExecuteOptions, state: CaseState, timeout: number): Promise<string> {
  const { name, target, mask, maxDiffRatio = DEFAULT_MAX_DIFF_RATIO, threshold = DEFAULT_PIXEL_THRESHOLD } = stepParamsSchemas.ASSERT_VISUAL.parse(rawParams);
  // Let the page settle: network quiet, fonts loaded (fixed built-in check, no step content).
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 3_000) }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready.then(() => true)).catch(() => {});
  const shot = { type: "png" as const, animations: "disabled" as const, caret: "hide" as const, scale: "css" as const, timeout, mask: (mask ?? []).map((m) => locate(page, m)), maskColor: "#FF00FF" };
  const capture = target ? await locate(page, target).first().screenshot(shot) : await page.screenshot(shot);

  const baseline = await options.approvedBaseline?.(name);
  state.visual = { name, capture, baselineId: baseline?.id ?? null, diff: null, diffRatio: null };
  if (!baseline) throw new NoBaselineError(`No approved baseline "${name}"; the capture was saved for review`);
  const result = compareImages(baseline.png, capture, { threshold, maxDiffRatio });
  if (result.match) {
    state.visual.diffRatio = result.diffRatio;
    return `Matches baseline "${name}" (${(result.diffRatio * 100).toFixed(3)}% of pixels differ)`;
  }
  if (result.reason === "size") {
    throw new AssertionFailure(`baseline "${name}" (${result.expected.width}×${result.expected.height})`, `capture is ${result.actual.width}×${result.actual.height}`);
  }
  state.visual.diff = result.diffPng;
  state.visual.diffRatio = result.diffRatio;
  throw new AssertionFailure(`baseline "${name}" within ${(maxDiffRatio * 100).toFixed(2)}%`, `${(result.diffRatio * 100).toFixed(3)}% of pixels differ (${result.diffPixels})`);
}

async function fillValue(value: FillValue, options: ExecuteOptions, state: CaseState): Promise<{ text: string; note: string }> {
  if ("literal" in value) return { text: value.literal, note: `Filled ${value.literal.length} characters` };
  if ("variable" in value) {
    const text = String(variable(state, value.variable));
    return { text, note: `Filled {${value.variable}} (${text.length} characters)` };
  }
  if ("unique" in value) {
    const tag = randomBytes(4).toString("hex");
    const generated: Value = value.unique === "email" ? `qa.${tag}@example.com` : value.unique === "number" ? randomInt(100_000, 1_000_000) : `qa-${tag}`;
    state.vars.set(value.saveAs, generated);
    return { text: String(generated), note: `Filled unique ${value.unique} {${value.saveAs}} = ${formatValue(generated)}` };
  }
  try {
    const secret = await options.resolveSecret(value.secret);
    state.usedSecrets.push(secret);
    return { text: secret, note: "Filled with secret value (hidden)" };
  } catch {
    throw new PreconditionError(`Secret ${value.secret} couldn't be resolved`);
  }
}

async function runAssertion(page: Page, rawParams: unknown, state: CaseState, timeout: number): Promise<string> {
  const a = stepParamsSchemas.ASSERT.parse(rawParams);
  const expected = a.expectedVariable !== undefined ? String(variable(state, a.expectedVariable)) : a.expected === undefined ? "" : String(a.expected);
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

async function runExtract(page: Page, rawParams: unknown, state: CaseState, timeout: number): Promise<string> {
  const { name, from, as, decimal } = stepParamsSchemas.EXTRACT.parse(rawParams);
  let raw: unknown;
  if (from.source === "element") {
    const element = locate(page, from.target).first();
    await element.waitFor({ state: "attached", timeout });
    raw = from.property === "value" ? await element.inputValue({ timeout }) : clip(await element.innerText({ timeout }), 1000);
  } else if (from.source === "response") {
    const response = state.responses.get(from.response);
    if (!response) throw new StepDefinitionError(`Response ${from.response} wasn't captured`);
    const json = parseJson(await response.body);
    if (json === undefined) throw new StepDefinitionError(`Response ${from.response} isn't JSON`);
    raw = resolvePointer(json, from.pointer);
    if (raw === undefined) throw new StepDefinitionError(`Response ${from.response} has no value at ${from.pointer || "/"}`);
  } else {
    const url = new URL(page.url());
    raw = from.part === "path" ? url.pathname : from.param ? url.searchParams.get(from.param) : url.search;
    if (raw === null) throw new StepDefinitionError(`The URL has no "${from.param}" parameter`);
  }

  let value: Value;
  if (as === "number") {
    const parsed = typeof raw === "number" ? raw : parseDisplayedNumber(String(raw), decimal);
    if (parsed === null) throw new StepDefinitionError(`"${clip(String(raw), 100)}" doesn't contain a number`);
    value = parsed;
  } else {
    value = typeof raw === "string" ? raw : JSON.stringify(raw ?? null).slice(0, 1000);
  }
  state.vars.set(name, value);
  return `{${name}} = ${formatValue(value)}`;
}

function parseJson(body: string | null): unknown {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The only script API_GET runs in the page: a fixed GET with the validated URL as data. */
async function pageFetch([url, timeoutMs, maxBytes]: [string, number, number]) {
  try {
    const response = await fetch(url, { method: "GET", credentials: "same-origin", redirect: "follow", headers: { accept: "application/json, */*;q=0.5" }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return { ok: true as const, status: response.status, url: response.url, contentType: response.headers.get("content-type") ?? "", body: body.slice(0, maxBytes) };
  } catch (error) {
    return { ok: false as const, error: String(error) };
  }
}

async function runApiGet(page: Page, rawParams: unknown, options: ExecuteOptions, state: CaseState, timeout: number): Promise<string> {
  const { url, saveAs } = stepParamsSchemas.API_GET.parse(rawParams);
  const target = resolveNavigation(url, options.authorizedUrl);
  if (!target) throw new Error("Request target is outside the authorized URL");
  let pageOrigin: string | null = null;
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {}
  if (pageOrigin !== new URL(target).origin) throw new StepDefinitionError("API_GET needs the page to be on the application first (add a NAVIGATE step before it)");

  const result = await page.evaluate(pageFetch, [target, timeout, MAX_BODY_BYTES] as [string, number, number]);
  if (!result.ok) {
    if (/TimeoutError|aborted/i.test(result.error)) throw new errors.TimeoutError(`GET ${url} didn't respond within ${timeout}ms`);
    throw new Error(`GET ${url} failed: net::ERR_CONNECTION_FAILED (${clip(result.error, 200)})`);
  }
  if (!resolveNavigation(result.url, options.authorizedUrl)) throw new Error("The request was redirected outside the authorized URL");
  state.responses.set(saveAs, { method: "GET", url: result.url, status: result.status, contentType: result.contentType, body: Promise.resolve(result.body) });
  return `GET ${new URL(result.url).pathname} → ${result.status} (${result.contentType || "no content type"}) as {${saveAs}}`;
}

async function runResponseCheck(page: Page, rawParams: unknown, state: CaseState, timeout: number): Promise<string> {
  const check = stepParamsSchemas.ASSERT_RESPONSE.parse(rawParams);
  let response: CapturedResponse | undefined;
  if (check.response) {
    response = state.responses.get(check.response);
    if (!response) throw new StepDefinitionError(`Response ${check.response} wasn't captured`);
  } else {
    const { method, urlContains } = check.match!;
    const deadline = Date.now() + timeout;
    for (;;) {
      response = [...state.observed].reverse().find((r) => (!method || r.method === method) && r.url.includes(urlContains));
      if (response || Date.now() >= deadline) break;
      await page.waitForTimeout(100);
    }
    if (!response) throw new errors.TimeoutError(`No ${method ?? ""} request containing "${urlContains}" was observed within ${timeout}ms`.replace("  ", " "));
    if (check.saveAs) state.responses.set(check.saveAs, response);
  }

  const problems: string[] = [];
  const expectations: string[] = [];
  if (check.status !== undefined) {
    const [min, max] = typeof check.status === "number" ? [check.status, check.status] : [check.status.min, check.status.max];
    expectations.push(min === max ? `status ${min}` : `status ${min}–${max}`);
    if (response.status < min || response.status > max) problems.push(`status ${response.status}`);
  }
  if (check.contentType) {
    expectations.push(`content type ${check.contentType}`);
    if (!response.contentType.toLowerCase().includes(check.contentType.toLowerCase())) problems.push(`content type "${response.contentType || "none"}"`);
  }
  if (check.contract || check.equals) {
    const json = parseJson(await response.body);
    if (json === undefined) {
      problems.push("body isn't JSON");
    } else {
      if (check.contract) {
        expectations.push("contract");
        problems.push(...checkContract(json, check.contract, 10));
      }
      for (const { pointer, value } of check.equals ?? []) {
        expectations.push(`${pointer || "/"} = ${JSON.stringify(value)}`);
        const actual = resolvePointer(json, pointer);
        if (actual !== value) problems.push(`${pointer || "/"} is ${actual === undefined ? "missing" : clip(JSON.stringify(actual), 100)}`);
      }
    }
  }
  const where = `${response.method} ${new URL(response.url).pathname}`;
  if (problems.length) throw new AssertionFailure(`${where}: ${expectations.join(", ")}`, problems.join("; "));
  return `${where} → ${response.status}: ${expectations.join(", ")} OK`;
}

/** Replaces any secret value that leaked into recorded text. */
export function scrubSecrets(text: string | null, secrets: string[]): string | null {
  if (!text) return text;
  return secrets.filter((s) => s.length >= 3).reduce((acc, secret) => acc.split(secret).join("••••••"), text);
}

/** Records the page's own same-origin XHR/fetch responses for ASSERT_RESPONSE `match` checks. */
function observeResponses(page: Page, authorizedUrl: string, state: CaseState) {
  const origin = new URL(authorizedUrl).origin;
  page.on("response", (response: Response) => {
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== origin || state.observed.length >= MAX_OBSERVED) return;
    const body = response
      .body()
      .then((buffer) => (buffer.length > MAX_BODY_BYTES ? null : buffer.toString("utf8")))
      .catch(() => null);
    state.observed.push({ method: request.method(), url: url.toString(), status: response.status(), contentType: response.headers()["content-type"] ?? "", body });
  });
}

export async function executeCase(page: Page, testCase: SnapshotCase, options: ExecuteOptions): Promise<CaseOutcome> {
  const steps: StepOutcome[] = [];
  const state: CaseState = { vars: new Map(), responses: new Map(), observed: [], usedSecrets: [], visual: null };

  // Cases with descriptive (non-executable) steps are not run at all.
  if (testCase.steps.some((s) => s.kind === null)) {
    return {
      status: "BLOCKED",
      failureClass: "TEST_DEFINITION",
      error: "This case has manual steps without executable actions.",
      suspectedCause: null,
      steps: testCase.steps.map((s) => ({ position: s.position, kind: s.kind as StepKindName | null, action: s.action, expected: s.expectedResult, actual: null, status: "BLOCKED", failureClass: null, durationMs: 0, error: null, screenshot: null })),
    };
  }

  // The last main-document HTTP status: a 5xx turns a missing element into application evidence.
  let documentStatus: number | null = null;
  page.on("response", (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && !response.headers()[BLOCKED_HEADER]) documentStatus = response.status();
  });
  observeResponses(page, options.authorizedUrl, state);
  const network = new Map<string, NetworkHit>();
  const origin = new URL(options.authorizedUrl).origin;
  page.on("response", (response) => {
    const request = response.request();
    const type = request.isNavigationRequest() && response.frame() === page.mainFrame() ? "page" : ["xhr", "fetch"].includes(request.resourceType()) ? "api" : null;
    if (!type || response.headers()[BLOCKED_HEADER]) return;
    try {
      const url = new URL(response.url());
      if (url.origin !== origin) return;
      const hit: NetworkHit = { type, method: request.method(), path: url.pathname, status: response.status() };
      const key = `${hit.type} ${hit.method} ${hit.path} ${hit.status}`;
      if (!network.has(key) && network.size < MAX_NETWORK_HITS) network.set(key, hit);
    } catch {}
  });

  let failure: { status: "FAILED" | "INCONCLUSIVE" | "BLOCKED"; failureClass: FailureClass; error: string; cause: string } | null = null;
  let stopped = false;
  for (const step of testCase.steps) {
    const kind = step.kind as StepKindName;
    const base = { position: step.position, kind, action: `${step.action} — ${describeAction(kind, step.params)}`, expected: step.expectedResult };
    if (failure || stopped || !(await options.shouldContinue())) {
      stopped = stopped || !failure;
      steps.push({ ...base, actual: null, status: "SKIPPED", failureClass: null, durationMs: 0, error: null, screenshot: null });
      continue;
    }
    const started = Date.now();
    state.visual = null;
    try {
      const actual = await runStep(page, kind, step.params, options, state, options.stepTimeoutMs);
      const screenshot = await page.screenshot({ type: "png", timeout: 5_000 }).catch(() => null);
      steps.push({ ...base, actual: scrubSecrets(actual, state.usedSecrets), status: "PASSED", failureClass: null, durationMs: Date.now() - started, error: null, screenshot, visual: state.visual ?? undefined });
    } catch (error) {
      if (isInfrastructure(error)) throw new InfrastructureError(String(error).split("\n")[0]);
      const screenshot = await page.screenshot({ type: "png", timeout: 5_000 }).catch(() => null);
      const isAssertion = error instanceof AssertionFailure;
      const verdict = classifyStepError(
        errorKindOf(error, kind, {
          assertion: isAssertion,
          timeout: error instanceof errors.TimeoutError,
          precondition: error instanceof PreconditionError,
          definition: error instanceof StepDefinitionError,
          noBaseline: error instanceof NoBaselineError,
        }),
        { documentStatus },
      );
      const message = scrubSecrets(
        error instanceof errors.TimeoutError ? `Timed out after ${options.stepTimeoutMs}ms: ${String(error.message).split("\n")[0]}` : String((error as Error).message ?? error).split("\n")[0],
        state.usedSecrets,
      )!.slice(0, 1000);
      steps.push({
        ...base,
        actual: isAssertion ? scrubSecrets((error as AssertionFailure).actual, state.usedSecrets) : null,
        expected: isAssertion ? (error as AssertionFailure).expected : base.expected,
        status: verdict.status,
        failureClass: verdict.failureClass,
        durationMs: Date.now() - started,
        error: message,
        screenshot,
        visual: state.visual ?? undefined,
      });
      failure = { status: verdict.status, failureClass: verdict.failureClass, error: `Step ${step.position + 1}: ${message}`, cause: verdict.cause };
    }
  }

  // API_GET goes through the page's fetch, so it's already among the observed hits.
  const hits = [...network.values()];
  if (failure) return { status: failure.status, failureClass: failure.failureClass, steps, error: failure.error, suspectedCause: failure.cause, network: hits };
  if (stopped) return { status: "SKIPPED", failureClass: null, steps, error: "Stopped before the case finished (cancelled or out of time).", suspectedCause: null, network: hits };
  return { status: "PASSED", failureClass: null, steps, error: null, suspectedCause: null, network: hits };
}
