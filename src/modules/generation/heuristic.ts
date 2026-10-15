import type { ExecutableStep, Locator } from "@/modules/execution/steps";
import type { FormElement } from "@/modules/discovery/page-elements";
import type { GeneratedCase } from "./schema";
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
  return cases;
}
