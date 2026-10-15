import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: send visitors without a session cookie to the sign-in page.
 * The real check (session lookup in the database, then project permissions) runs in the
 * data access layer for every page and Server Action.
 */
const SESSION_COOKIE = "qa_session";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login" || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
