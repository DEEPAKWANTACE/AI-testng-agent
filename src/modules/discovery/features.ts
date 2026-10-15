import { normalizeUrl } from "./crawl-url";
import { countElements, type PageElements } from "./page-elements";

export type CrawledPageSummary = { url: string; title: string | null; elements: PageElements };

export type DerivedFeature = {
  key: string;
  name: string;
  url: string;
  description: string;
  pageUrls: string[];
};

function sectionKey(pageUrl: string, authorizedUrl: string): string {
  const prefix = new URL(authorizedUrl).pathname.replace(/\/+$/, "");
  const path = new URL(pageUrl).pathname.slice(prefix.length);
  return path.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

function humanizeSegment(segment: string): string {
  const words = decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Home";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Groups crawled pages into features by top-level section (/products/*, /cart, …).
 * Names come from the site's own navigation labels when available, so they match what users
 * see; otherwise the path segment is humanised.
 */
export function deriveFeatures(pages: CrawledPageSummary[], authorizedUrl: string): DerivedFeature[] {
  // Navigation labels keyed by the section they point to.
  const navLabels = new Map<string, string>();
  for (const page of pages) {
    for (const menu of page.elements.navigation) {
      for (const link of menu.links) {
        try {
          const key = sectionKey(new URL(link.href, page.url).toString(), authorizedUrl);
          const label = link.text.trim();
          if (label && label.length <= 60 && !navLabels.has(key)) navLabels.set(key, label);
        } catch {
          // ignore unparsable hrefs
        }
      }
    }
  }

  const groups = new Map<string, CrawledPageSummary[]>();
  for (const page of pages) {
    const key = sectionKey(page.url, authorizedUrl);
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }

  const usedNames = new Set<string>();
  return [...groups.entries()]
    .map(([key, group]) => {
      // The shallowest page is the section's entry point.
      const sorted = [...group].sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length);
      const totals = group.reduce(
        (acc, page) => {
          const c = countElements(page.elements);
          return { forms: acc.forms + c.forms, inputs: acc.inputs + c.inputs, buttons: acc.buttons + c.buttons };
        },
        { forms: 0, inputs: 0, buttons: 0 },
      );
      let name = navLabels.get(key) ?? humanizeSegment(key);
      // Feature names are unique per application.
      for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${navLabels.get(key) ?? humanizeSegment(key)} ${i}`;
      usedNames.add(name.toLowerCase());

      return {
        key,
        name,
        url: normalizeUrl(sorted[0].url),
        description: [plural(group.length, "page"), plural(totals.forms, "form"), plural(totals.inputs, "input"), plural(totals.buttons, "button")].join(" · "),
        pageUrls: group.map((page) => normalizeUrl(page.url)),
      };
    })
    .sort((a, b) => (a.key === "" ? -1 : b.key === "" ? 1 : a.name.localeCompare(b.name)));
}
