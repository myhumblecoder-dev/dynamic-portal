import { NextResponse, type NextRequest } from "next/server";

/**
 * Authentication *presence* only — not authorization.
 *
 * A browser page request with no session, when OIDC is the active provider, is
 * bounced to login. Everything else is left alone: the authorization decision
 * (audience, roles, scopes) stays at the chokepoints (`authorize`), which run in
 * the Node runtime with the registry and the session key. Middleware runs on the
 * edge runtime, where the session cookie cannot be decrypted (node:crypto is
 * unavailable), so this deliberately only checks that a cookie is *present* —
 * a tampered one is rejected later by `currentPrincipal`, which falls through to
 * a 401 rather than a partial identity.
 *
 * The cookie name is inlined rather than imported from `lib/session` on purpose:
 * that module imports `node:crypto`, and importing it here would break the edge
 * bundle. Kept in sync with `SESSION_COOKIE` by this comment.
 */
const SESSION_COOKIE = "portal_session";

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // The auth routes and health must always be reachable without a session — as
  // must OAuth discovery. `/.well-known/` is the one unauthenticated path that
  // is not under `/api/`, so without naming it here the branch at the bottom
  // would redirect it to the login page: a host asking how to authenticate
  // would be handed an HTML sign-in form, and the flow would fail before it
  // began.
  if (
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/healthz"
  ) {
    return NextResponse.next();
  }

  // When the dev stub is enabled or OIDC is not configured, `currentPrincipal`
  // handles identity itself (stub, or a fail-closed 401) — do not gate here.
  const devSession =
    process.env["PORTAL_ALLOW_DEV_SESSION"] === "1" || process.env["NODE_ENV"] === "development";
  const oidcConfigured = process.env["PORTAL_OIDC_ISSUER"] !== undefined;
  if (devSession || !oidcConfigured) {
    return NextResponse.next();
  }

  if (request.cookies.get(SESSION_COOKIE) !== undefined) {
    return NextResponse.next();
  }

  // API routes answer their own JSON 401; only document navigations redirect.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/api/auth/login", request.url));
}

export const config = {
  // Everything except Next internals and static assets. Fine-grained filtering
  // (auth routes, api, health) happens in the function above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
