import type { ExecutableStep, Locator } from "@/modules/execution/steps";
import type { FormElement } from "@/modules/discovery/page-elements";
import type { GeneratedCase } from "./schema";
import { INVENTORY_FEATURES, type InventoryEndpoint } from "./inventory-context";
import type { FeatureContext, GenerationContext } from "./prompt";

/**
 * Rule-based generator used when no LLM is configured (LLM_PROVIDER=heuristic). It derives
 * executable cases from what discovery recorded. It deliberately never submits POST forms
 * with data (that could place orders or change state); those are covered by validation
 * (NEGATIVE) and field (BOUNDARY) checks instead.
 */

const PROTECTED = /(account|profile|orders?|settings|admin|dashboard|billing)/i;
const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;
const clip = (value: string, max: number) => value.trim().slice(0, max);

function fieldLocator(field: FormElement["fields"][number]): Locator | null {
  if (field.label) return { by: "label", value: clip(field.label, 200), exact: true };
  if (field.name) return { by: "css", value: `[name="${field.name.replace(/["\\]/g, "")}"]` };
  if (field.placeholder) return { by: "placeholder", value: clip(field.placeholder, 200) };
  return null;
}

function submitLocator(form: FormElement): Locator {
  const label = form.submitLabels[0];
  return label ? { by: "role", role: "button", name: clip(label, 200), exact: true } : { by: "css", value: '[type="submit"]' };
}

function sampleValue(field: FormElement["fields"][number]): string {
  switch (field.type) {
    case "email": return "qa.tester@example.test";
    case "number": return "1";
    case "tel": return "+1 555 0100";
    case "url": return "https://example.test";
    case "date": return "2030-01-15";
    default: return "QA test";
  }
}

function loginSteps(context: GenerationContext): ExecutableStep[] | null {
  const login = context.login;
  if (!login) return null;
  return [
    { kind: "NAVIGATE", description: "Open the sign-in page", params: { url: login.path } },
    { kind: "FILL", description: "Enter the test account's username", params: { target: { by: "css", value: login.usernameSelector }, value: { secret: login.usernameSecret } } },
    { kind: "FILL", description: "Enter the test account's password", params: { target: { by: "css", value: 'input[type="password"]' }, value: { secret: login.passwordSecret } } },
    { kind: "CLICK", description: "Submit the sign-in form", params: { target: { by: "css", value: 'form:has(input[type="password"]) [type="submit"]' } } },
    { kind: "WAIT", description: "Wait until signed in", expected: "The sign-in form is gone", params: { for: "hidden", target: { by: "css", value: 'input[type="password"]' } } },
  ];
}

function headingCheck(page: FeatureContext["pages"][number]): ExecutableStep {
  const heading = page.elements.headings[0];
  return heading
    ? { kind: "ASSERT", description: `The "${clip(heading, 80)}" heading is shown`, params: { check: "visible", target: { by: "role", role: "heading", name: clip(heading, 200) } } }
    : { kind: "ASSERT", description: "The page title is shown", params: { check: "titleContains", expected: clip(page.title ?? "", 200) || " " } };
}

export function heuristicGenerate(context: GenerationContext): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  const requirements = context.requirements ? [clip(context.requirements.split("\n")[0], 200)] : [];
  const login = loginSteps(context);
  // Forms repeated on many pages (e.g. a header search box) are tested once, not per feature.
  const seenForms = new Set<string>();

  for (const feature of context.features) {
    const entry = feature.pages.slice().sort((a, b) => pathOf(a.url).length - pathOf(b.url).length)[0];
    if (!entry) continue;
    const path = pathOf(entry.url);
    const isProtected = PROTECTED.test(path) || PROTECTED.test(feature.name);
    const prefix = isProtected && login ? login : [];
    const prereqs = isProtected && login ? ["A test account exists and its credentials are stored as secret references"] : ["The application is reachable"];
    const coverage = { requirements: requirements.length ? requirements : [`${feature.name} is available`] };

    const open: ExecutableStep[] = [
      ...prefix,
      { kind: "NAVIGATE", description: `Open ${feature.name}`, params: { url: path } },
      headingCheck(entry),
    ];
    cases.push({
      title: `${feature.name} opens and shows its content`,
      feature: feature.name,
      category: isProtected && login ? "END_TO_END" : "POSITIVE",
      priority: isProtected ? "HIGH" : "MEDIUM",
      prerequisites: prereqs,
      steps: open,
      expectedResult: `The ${feature.name} page loads and shows its main heading.`,
      coverage,
    });
    cases.push({
      title: `Regression: ${feature.name} smoke check`,
      feature: feature.name,
      category: "REGRESSION",
      priority: "MEDIUM",
      prerequisites: prereqs,
      steps: open,
      expectedResult: `${feature.name} still loads as in previous releases.`,
      coverage: { requirements: [`${feature.name} keeps working across releases`] },
    });

    if (isProtected) {
      cases.push({
        title: `Signed-out users can't open ${feature.name}`,
        feature: feature.name,
        category: "PERMISSION",
        priority: "CRITICAL",
        prerequisites: ["The browser is not signed in"],
        steps: [
          { kind: "NAVIGATE", description: `Open ${feature.name} without signing in`, params: { url: path } },
          { kind: "ASSERT", description: "The user is sent to the sign-in page", expected: "URL contains login", params: { check: "urlContains", expected: "login" } },
        ],
        expectedResult: "Unauthenticated users are redirected to sign in instead of seeing the page.",
        coverage: { requirements: [`${feature.name} requires authentication`] },
      });
    }

    for (const page of feature.pages) {
      for (const form of page.elements.forms) {
        const formKey = `${form.method} ${form.action} ${form.fields.map((f) => f.name).join(",")}`;
        if (seenForms.has(formKey) || form.fields.length === 0) continue;
        seenForms.add(formKey);
        const formName = form.name ?? form.submitLabels[0] ?? "form";
        const pagePath = pathOf(page.url);
        const visit: ExecutableStep[] = [...prefix, { kind: "NAVIGATE", description: `Open ${pagePath}`, params: { url: pagePath } }];
        const firstText = form.fields.find((f) => ["text", "search", "email", "textarea"].includes(f.type) && fieldLocator(f));

        if (form.method === "GET" && firstText) {
          const target = fieldLocator(firstText)!;
          cases.push({
            title: `${formName}: searching submits the query`,
            feature: feature.name,
            category: "POSITIVE",
            priority: "MEDIUM",
            prerequisites: prereqs,
            steps: [
              ...visit,
              { kind: "FILL", description: `Enter a search term in ${firstText.label ?? firstText.name}`, params: { target, value: { literal: "shoes" } } },
              { kind: "CLICK", description: `Submit ${formName}`, params: { target: submitLocator(form) } },
              { kind: "ASSERT", description: "The query appears in the URL", params: { check: "urlContains", expected: `${firstText.name ?? "q"}=` } },
            ],
            expectedResult: "Results page opens for the query.",
            coverage,
          });
          cases.push({
            title: `${formName}: very long input is handled`,
            feature: feature.name,
            category: "BOUNDARY",
            priority: "LOW",
            prerequisites: prereqs,
            steps: [
              ...visit,
              { kind: "FILL", description: "Enter a 500-character value", params: { target, value: { literal: "x".repeat(500) } } },
              { kind: "CLICK", description: `Submit ${formName}`, params: { target: submitLocator(form) } },
              { kind: "ASSERT", description: "The application responds without crashing", params: { check: "visible", target: { by: "css", value: "body" } } },
            ],
            expectedResult: "Long input is accepted or rejected gracefully; no error page.",
            coverage,
          });
        }

        if (form.method === "POST") {
          const required = form.fields.filter((f) => f.required && f.type !== "hidden");
          if (required.length > 0) {
            cases.push({
              title: `${formName}: required fields can't be left empty`,
              feature: feature.name,
              category: "NEGATIVE",
              priority: "HIGH",
              prerequisites: prereqs,
              steps: [
                ...visit,
                // Fields may be pre-filled (values are never recorded by discovery), so clear them first.
                ...required.flatMap((field): ExecutableStep[] => {
                  const target = fieldLocator(field);
                  return target && field.tag !== "select" ? [{ kind: "FILL", description: `Clear ${field.label ?? field.name}`, params: { target, value: { literal: "" } } }] : [];
                }),
                { kind: "CLICK", description: `Submit ${formName} without filling required fields`, params: { target: submitLocator(form) } },
                { kind: "ASSERT", description: "The form is not submitted", expected: "Still on the same page", params: { check: "urlContains", expected: pagePath.split("?")[0] } },
              ],
              expectedResult: `Submission is blocked until ${required.map((f) => f.label ?? f.name).join(", ")} are filled.`,
              coverage,
            });
          }
          if (firstText) {
            const value = "A".repeat(255);
            cases.push({
              title: `${formName}: ${firstText.label ?? firstText.name} accepts 255 characters`,
              feature: feature.name,
              category: "BOUNDARY",
              priority: "LOW",
              prerequisites: prereqs,
              steps: [
                ...visit,
                { kind: "FILL", description: `Enter 255 characters into ${firstText.label ?? firstText.name}`, params: { target: fieldLocator(firstText)!, value: { literal: value } } },
                { kind: "ASSERT", description: "The full value is kept", params: { check: "valueEquals", target: fieldLocator(firstText)!, expected: value } },
              ],
              expectedResult: "The field accepts a 255-character value without truncating it.",
              coverage,
            });
          }
          for (const field of form.fields.filter((f) => f.type !== "hidden").slice(0, 1)) {
            const target = fieldLocator(field);
            if (!target) continue;
            cases.push({
              title: `${formName}: ${field.label ?? field.name} can be filled`,
              feature: feature.name,
              category: "POSITIVE",
              priority: "MEDIUM",
              prerequisites: prereqs,
              steps: [
                ...visit,
                { kind: "FILL", description: `Enter a valid value in ${field.label ?? field.name}`, params: { target, value: { literal: sampleValue(field) } } },
                { kind: "ASSERT", description: "The value is shown in the field", params: { check: "valueEquals", target, expected: sampleValue(field) } },
              ],
              expectedResult: "The field accepts a valid value.",
              coverage,
            });
          }
        }
      }
    }

    // Navigation: walk the main menu from this feature's entry page.
    const menu = entry.elements.navigation.find((n) => /main|header|primary/i.test(n.label)) ?? entry.elements.navigation[0];
    if (menu && path === "/") {
      // Signed-out walk: protected sections redirect to sign-in (covered by PERMISSION cases).
      const links = menu.links
        .filter((l) => l.text && !/sign ?out|log ?out/i.test(l.text) && !PROTECTED.test(new URL(l.href).pathname) && !PROTECTED.test(l.text))
        .slice(1, 4);
      if (links.length) {
        cases.push({
          title: "Main navigation reaches each section",
          feature: feature.name,
          category: "END_TO_END",
          priority: "HIGH",
          prerequisites: ["The application is reachable"],
          steps: [
            { kind: "NAVIGATE", description: "Open the home page", params: { url: "/" } },
            ...links.flatMap((link): ExecutableStep[] => [
              { kind: "CLICK", description: `Click "${clip(link.text, 80)}" in the menu`, params: { target: { by: "role", role: "link", name: clip(link.text, 200), exact: true } } },
              { kind: "ASSERT", description: `The ${clip(link.text, 80)} page opens`, params: { check: "urlContains", expected: new URL(link.href).pathname } },
            ]),
          ],
          expectedResult: "Every main menu link opens its section.",
          coverage: { requirements: ["Users can navigate between sections"] },
        });
      }
    }
  }
  return [...cases, ...inventoryCases(context)];
}

/**
 * Cases grounded in the inventory. Only facts a source states are turned into checks: a
 * documented 2xx response and its schema, a documented 401/403 for signed-out callers, a
 * documented 400/422 for out-of-range parameters, a route a source marks as protected.
 * Only GET requests are made, and only to endpoints without path parameters, so generated
 * cases never change data. Prose requirements and workflows aren't turned into checks here
 * (that needs judgement), only by an LLM provider, and only as reviewable proposals.
 */
export function inventoryCases(context: GenerationContext): GeneratedCase[] {
  const inventory = context.inventory;
  if (!inventory) return [];
  const cases: GeneratedCase[] = [];
  const login = loginSteps(context);
  const landing = new URL(context.application.authorizedUrl).pathname || "/";
  const open: ExecutableStep = { kind: "NAVIGATE", description: "Open the application", params: { url: landing } };
  const statusOf = (endpoint: InventoryEndpoint, test: (code: number) => boolean) =>
    Object.keys(endpoint.responses).map(Number).filter((code) => Number.isInteger(code) && test(code)).sort((a, b) => a - b)[0];

  for (const endpoint of inventory.endpoints) {
    if (endpoint.method !== "GET" || endpoint.path.includes(":")) continue;
    const ok = statusOf(endpoint, (c) => c >= 200 && c < 300);
    const contract = ok !== undefined ? endpoint.responses[String(ok)]?.contract ?? null : null;
    const needsLogin = endpoint.protected === true;
    const prefix = needsLogin ? login : [];
    const required = endpoint.parameters.filter((p) => p.required && p.in !== "header" && p.in !== "cookie");

    if (ok !== undefined && prefix && required.length === 0) {
      cases.push({
        title: `${endpoint.key} returns ${ok}${contract ? " matching its documented schema" : ""}`.slice(0, 200),
        feature: INVENTORY_FEATURES.api,
        category: "POSITIVE",
        priority: "HIGH",
        prerequisites: needsLogin ? ["A test account exists and its credentials are stored as secret references"] : ["The application is reachable"],
        steps: [
          ...prefix,
          open,
          { kind: "API_GET", description: `Request ${endpoint.key}`, params: { url: endpoint.path, saveAs: "response" } },
          {
            kind: "ASSERT_RESPONSE",
            description: contract ? "The response has the documented status and schema" : "The response has the documented status",
            params: { response: "response", status: ok, ...(contract ? { contentType: "json", contract } : {}) },
          },
        ],
        expectedResult: `${endpoint.key} responds with ${ok}${contract ? " and a body matching the API specification" : ""}.`,
        coverage: { requirements: [endpoint.key], notes: "Derived from the API specification" },
      });
    }

    const denied = statusOf(endpoint, (c) => c === 401 || c === 403);
    if (needsLogin && denied !== undefined && required.length === 0) {
      cases.push({
        title: `${endpoint.key} refuses signed-out requests`.slice(0, 200),
        feature: INVENTORY_FEATURES.access,
        category: "PERMISSION",
        priority: "CRITICAL",
        prerequisites: ["The browser is not signed in"],
        steps: [
          open,
          { kind: "API_GET", description: `Request ${endpoint.key} without signing in`, params: { url: endpoint.path, saveAs: "response" } },
          { kind: "ASSERT_RESPONSE", description: "Access is refused", expected: "401 or 403", params: { response: "response", status: { min: 401, max: 403 } } },
        ],
        expectedResult: "Unauthenticated callers are refused with 401 or 403, as documented.",
        coverage: { requirements: [endpoint.key, `${endpoint.key} requires authentication`], notes: "Derived from the API specification" },
      });
    }

    // Boundaries of documented query parameters: at the limit is accepted, past it is refused.
    const rejects = statusOf(endpoint, (c) => c === 400 || c === 422);
    if (ok === undefined || (needsLogin && !login)) continue;
    for (const param of endpoint.parameters.filter((p) => p.in === "query" && p.schema).slice(0, 3)) {
      const schema = param.schema!;
      const bounds: Array<{ value: string; accepted: boolean; label: string }> = [];
      if ((schema.type === "integer" || schema.type === "number") && schema.maximum !== undefined) {
        bounds.push({ value: String(schema.maximum), accepted: true, label: `${param.name}=${schema.maximum} (maximum)` });
        if (rejects !== undefined) bounds.push({ value: String(schema.type === "integer" ? schema.maximum + 1 : schema.maximum + 0.5), accepted: false, label: `${param.name} above its maximum` });
      }
      if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined) {
        bounds.push({ value: String(schema.minimum), accepted: true, label: `${param.name}=${schema.minimum} (minimum)` });
        if (rejects !== undefined) bounds.push({ value: String(schema.type === "integer" ? schema.minimum - 1 : schema.minimum - 0.5), accepted: false, label: `${param.name} below its minimum` });
      }
      if (schema.type === "string" && schema.maxLength !== undefined && schema.maxLength <= 500) {
        bounds.push({ value: "a".repeat(schema.maxLength), accepted: true, label: `${param.name} at its maximum length (${schema.maxLength})` });
        if (rejects !== undefined) bounds.push({ value: "a".repeat(schema.maxLength + 1), accepted: false, label: `${param.name} past its maximum length` });
      }
      for (const bound of bounds) {
        const url = `${endpoint.path}?${new URLSearchParams({ [param.name]: bound.value })}`;
        if (url.length > 2048) continue;
        cases.push({
          title: `${endpoint.key}: ${bound.label} is ${bound.accepted ? "accepted" : "refused"}`.slice(0, 200),
          feature: INVENTORY_FEATURES.api,
          category: bound.accepted ? "BOUNDARY" : "NEGATIVE",
          priority: "MEDIUM",
          prerequisites: needsLogin ? ["A test account exists and its credentials are stored as secret references"] : ["The application is reachable"],
          steps: [
            ...(needsLogin ? login! : []),
            open,
            { kind: "API_GET", description: `Request with ${bound.label}`, params: { url, saveAs: "response" } },
            { kind: "ASSERT_RESPONSE", description: bound.accepted ? "The request is accepted" : "The request is refused as invalid", params: { response: "response", status: bound.accepted ? ok : { min: 400, max: 422 } } },
          ],
          expectedResult: bound.accepted ? `A value at the documented limit is accepted (${ok}).` : "A value past the documented limit is refused with a 4xx validation error.",
          coverage: { requirements: [endpoint.key, `${endpoint.key} ${param.name} limits`], notes: "Derived from the API specification" },
        });
      }
    }
  }

  // Routes a source marks as protected: signed-out visitors end up at the sign-in page.
  const loginPath = context.login?.path;
  if (login && loginPath) {
    for (const route of inventory.routes.filter((r) => r.protected === true && !r.key.includes(":") && r.key !== loginPath).slice(0, 15)) {
      cases.push({
        title: `Signed-out visitors can't open ${route.key}`.slice(0, 200),
        feature: INVENTORY_FEATURES.access,
        category: "PERMISSION",
        priority: "CRITICAL",
        prerequisites: ["The browser is not signed in"],
        steps: [
          { kind: "NAVIGATE", description: `Open ${route.key} without signing in`, params: { url: route.key } },
          { kind: "ASSERT", description: "The visitor is sent to sign in", expected: `URL contains ${loginPath}`, params: { check: "urlContains", expected: loginPath } },
        ],
        expectedResult: "The protected page isn't shown to signed-out visitors; they're redirected to sign in.",
        coverage: { requirements: [route.key, `${route.key} requires authentication`], notes: "The source marks this route as protected" },
      });
    }
  }
  return cases;
}
