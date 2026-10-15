/**
 * True when `url` is inside the application's authorized scope: same origin, and under the
 * authorized path prefix on a path-segment boundary (so /app does not authorize /application).
 */
export function isWithinAuthorizedUrl(url: string, authorizedUrl: string): boolean {
  let target: URL;
  let scope: URL;
  try {
    target = new URL(url);
    scope = new URL(authorizedUrl);
  } catch {
    return false;
  }
  if (target.origin !== scope.origin || target.username || target.password) return false;
  const prefix = scope.pathname.replace(/\/+$/, "");
  return prefix === "" || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}
