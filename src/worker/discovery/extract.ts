import type { Page } from "playwright";
import { pageElementsSchema, type PageElements } from "@/modules/discovery/page-elements";

/**
 * Runs inside the page. Kept as a plain JS string so no transpiler helpers leak into the
 * browser. Records structure only — never field values. The result is re-validated with Zod
 * on the Node side, since page content is untrusted.
 */
const EXTRACT_SCRIPT = String.raw`(() => {
  const clip = (value, max = 200) => (value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.type === "hidden") return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
  };
  const labelFor = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (clip(text)) return clip(text);
    }
    // A label's own text, without the text of controls inside it (e.g. <option>s).
    const ownText = (label) => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll("input, select, textarea, button").forEach((node) => node.remove());
      return clip(copy.textContent);
    };
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && ownText(label)) return ownText(label);
    }
    const wrapping = el.closest("label");
    if (wrapping && ownText(wrapping)) return ownText(wrapping);
    return null;
  };
  const field = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: clip(el.tagName === "INPUT" ? el.type || "text" : el.tagName.toLowerCase(), 40),
    name: el.getAttribute("name") ? clip(el.getAttribute("name")) : null,
    label: labelFor(el),
    placeholder: el.getAttribute("placeholder") ? clip(el.getAttribute("placeholder")) : null,
    required: Boolean(el.required),
  });
  const isField = (el) => !(el.tagName === "INPUT" && ["submit", "button", "reset", "image"].includes(el.type));
  const buttonText = (el) => clip(el.getAttribute("aria-label") || el.innerText || el.value || el.title || "");

  const navRoots = [...document.querySelectorAll('nav, [role="navigation"]')].filter(visible).slice(0, 10);
  const navigation = navRoots.map((nav, i) => ({
    label: clip(nav.getAttribute("aria-label") || (nav.closest("header") ? "Header" : nav.closest("footer") ? "Footer" : "Navigation " + (i + 1))),
    links: [...nav.querySelectorAll("a[href]")].filter(visible).slice(0, 100).map((a) => ({ href: a.href.slice(0, 2048), text: clip(a.innerText || a.getAttribute("aria-label")) })),
  }));

  const links = [...document.querySelectorAll("a[href], area[href]")].filter(visible).slice(0, 300).map((a) => ({
    href: a.href.slice(0, 2048),
    text: clip(a.innerText || a.getAttribute("aria-label") || a.title),
    inNavigation: Boolean(a.closest('nav, [role="navigation"]')),
  }));

  const forms = [...document.forms].filter(visible).slice(0, 50).map((form) => {
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    return {
      name: clip(form.getAttribute("name") || form.getAttribute("aria-label") || form.id) || null,
      action: form.getAttribute("action") === null ? null : form.action.slice(0, 2048),
      method: ["GET", "POST", "DIALOG"].includes(method) ? method : "GET",
      fields: [...form.querySelectorAll("input, select, textarea")].filter(isField).filter(visible).slice(0, 100).map(field),
      submitLabels: [...form.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"]')].slice(0, 10).map(buttonText).filter(Boolean),
    };
  });

  const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
    .filter(visible)
    .slice(0, 200)
    .map((el) => ({ text: buttonText(el), type: clip(el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit" : el.getAttribute("role") || "button"), 40), inForm: Boolean(el.closest("form")) }));

  const inputs = [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => !el.closest("form") && isField(el) && visible(el))
    .slice(0, 200)
    .map(field);

  const headings = [...document.querySelectorAll("h1, h2")].filter(visible).slice(0, 20).map((h) => clip(h.innerText)).filter(Boolean);

  return { headings, links, navigation, forms, buttons, inputs };
})()`;

export async function extractPageElements(page: Page): Promise<PageElements> {
  const raw = await page.evaluate(EXTRACT_SCRIPT);
  return pageElementsSchema.parse(raw);
}
