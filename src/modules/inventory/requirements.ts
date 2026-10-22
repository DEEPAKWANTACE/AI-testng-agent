import { createHash } from "node:crypto";
import { normalizeRole, safeKey, safeTitle, type ExtractedItem } from "./types";

/**
 * Requirements documents (plain text or Markdown) → requirements with acceptance criteria and
 * business rules, user roles, and Gherkin-style workflows. Recognised conventions:
 *
 *   REQ-12: Customers can apply one coupon per order.      (an id, then the requirement)
 *     - Discount is 10% of the subtotal                     (indented / bulleted: criteria)
 *   ## Checkout / As a customer, I want …                  (headings and user stories, no id)
 *   Scenario: Apply a coupon / Given … When … Then …        (workflows)
 *   Roles: admin, customer                                  (explicit role list)
 */

export const MAX_REQUIREMENTS_BYTES = 500_000;

const REQ_LINE = /^\s*(?:[-*+]\s+)?\**\[?([A-Z][A-Z0-9]{1,9}-\d{1,6})\]?\**\s*[:.)\-–—]\s*(.+)$/;
const STORY = /\bas an?\s+([a-z][\w -]{1,40}?)\s*,\s*I\s+(?:want|need|can|should)\b/i;
const ROLE_RULE = /\b(?:only|just)\s+(?:an?\s+|the\s+)?([a-z][\w-]{1,30}?)s?\s+(?:can|may|are allowed to|is allowed to)\b/i;
const ROLE_LIST = /^\s*(?:user\s+)?roles?\s*:\s*(.+)$/i;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const SCENARIO = /^\s*(?:Scenario(?: Outline)?|Workflow)\s*:\s*(.+)$/i;
const GHERKIN = /^\s*(Given|When|Then|And|But)\s+(.+)$/i;
/** A criterion that states something checkable with numbers or limits. */
const RULE_HINT = /\d|%|\b(?:at least|at most|maximum|minimum|must not|cannot|only|between|exceed|limit)\b/i;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "item";
const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);

export function analyzeRequirements(text: string, ref = "requirements"): ExtractedItem[] {
  if (Buffer.byteLength(text) > MAX_REQUIREMENTS_BYTES) throw new Error("The requirements document is larger than 500 KB.");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const items: ExtractedItem[] = [];
  const roles = new Map<string, string>();
  let current: { item: ExtractedItem; criteria: string[] } | null = null;
  let scenario: { item: ExtractedItem; steps: Array<{ keyword: string; text: string }> } | null = null;
  let heading: string | null = null;

  const flush = () => {
    if (current) {
      const criteria = current.criteria.slice(0, 30);
      current.item.details = { ...(current.item.details ?? {}), criteria, rules: criteria.filter((c) => RULE_HINT.test(c)), section: heading };
      items.push(current.item);
    }
    current = null;
  };
  const flushScenario = () => {
    if (scenario && scenario.steps.length) {
      scenario.item.details = { steps: scenario.steps.slice(0, 40), section: heading };
      items.push(scenario.item);
    }
    scenario = null;
  };
  const noteRoles = (line: string, n: number) => {
    for (const match of [STORY.exec(line), ROLE_RULE.exec(line)]) {
      const role = match ? normalizeRole(match[1]) : null;
      if (role && !roles.has(role)) roles.set(role, `${ref}:${n}`);
    }
    const list = ROLE_LIST.exec(line);
    if (list) {
      for (const part of list[1].split(/[,;/]| and /)) {
        const role = normalizeRole(part);
        if (role && !roles.has(role)) roles.set(role, `${ref}:${n}`);
      }
    }
  };

  lines.forEach((line, index) => {
    const n = index + 1;
    if (!line.trim()) return;
    noteRoles(line, n);

    const scenarioMatch = SCENARIO.exec(line);
    if (scenarioMatch) {
      flush();
      flushScenario();
      const title = safeTitle(scenarioMatch[1]);
      scenario = { item: { kind: "WORKFLOW", key: safeKey(slug(title)), title, ref: `${ref}:${n}`, confidence: "HIGH" }, steps: [] };
      return;
    }
    const step = GHERKIN.exec(line);
    if (scenario && step) {
      scenario.steps.push({ keyword: step[1][0].toUpperCase() + step[1].slice(1).toLowerCase(), text: safeTitle(step[2]) });
      return;
    }
    flushScenario();

    const req = REQ_LINE.exec(line);
    if (req) {
      flush();
      current = { item: { kind: "REQUIREMENT", key: req[1], title: safeTitle(req[2]), ref: `${ref}:${n}`, confidence: "HIGH" }, criteria: [] };
      return;
    }
    const head = HEADING.exec(line);
    if (head) {
      flush();
      heading = safeTitle(head[1]);
      return;
    }
    const story = STORY.exec(line);
    if (story) {
      flush();
      const title = safeTitle(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
      current = { item: { kind: "REQUIREMENT", key: `STORY-${shortHash(title)}`, title, ref: `${ref}:${n}`, confidence: "MEDIUM", details: { story: true } }, criteria: [] };
      return;
    }
    const bullet = BULLET.exec(line);
    if (current && (bullet || /^\s{2,}\S/.test(line))) {
      current.criteria.push(safeTitle(bullet ? bullet[1] : line));
    }
  });
  flush();
  flushScenario();

  // Pronouns caught by the patterns aren't roles.
  for (const notRole of ["i", "we", "it", "you", "they"]) roles.delete(notRole);
  for (const [role, where] of roles) items.push({ kind: "ROLE", key: role, title: role, ref: where, confidence: "MEDIUM" });

  // The same id twice keeps the first occurrence and merges criteria.
  const seen = new Map<string, ExtractedItem>();
  for (const item of items) {
    const id = `${item.kind}:${item.key}`;
    const prior = seen.get(id);
    if (!prior) seen.set(id, item);
    else if (item.kind === "REQUIREMENT") {
      const a = (prior.details?.criteria as string[]) ?? [];
      const b = (item.details?.criteria as string[]) ?? [];
      prior.details = { ...prior.details, criteria: [...a, ...b].slice(0, 30) };
    }
  }
  return [...seen.values()];
}
