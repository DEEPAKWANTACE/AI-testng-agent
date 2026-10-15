import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";

/** Canonical form used to de-duplicate pages: no fragment, sorted query, no default port. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.searchParams.sort();
  url.username = "";
  url.password = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/**
 * Links that look like they change state are never followed: discovery only reads.
 * (Sign-out would also end the crawler's own session.)
 */
export const DEFAULT_EXCLUDE_PATTERN =
  /(^|[/_.-])(log-?out|sign-?out|logoff|delete|destroy|remove|unsubscribe|deactivate|reset)([/_.?=-]|$)/i;

const DOWNLOAD_EXTENSIONS = /\.(pdf|zip|gz|tgz|rar|7z|exe|dmg|msi|apk|iso|csv|xlsx?|docx?|pptx?|mp4|mov|avi|mp3|wav|jpe?g|png|gif|webp|svg|ico|woff2?|ttf)$/i;

export type SkipReason = "invalid" | "unsupported-scheme" | "out-of-scope" | "excluded" | "download";

export type CrawlTarget = { ok: true; url: string } | { ok: false; reason: SkipReason };

/** Decides whether a discovered href should be visited. */
export function evaluateLink(href: string, baseUrl: string, authorizedUrl: string): CrawlTarget {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "unsupported-scheme" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  if (!isWithinAuthorizedUrl(url.toString(), authorizedUrl)) return { ok: false, reason: "out-of-scope" };
  if (DEFAULT_EXCLUDE_PATTERN.test(url.pathname)) return { ok: false, reason: "excluded" };
  if (DOWNLOAD_EXTENSIONS.test(url.pathname)) return { ok: false, reason: "download" };
  return { ok: true, url: normalizeUrl(url.toString()) };
}
