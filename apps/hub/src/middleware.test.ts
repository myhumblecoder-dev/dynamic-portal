import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { middleware } from "./middleware";

/**
 * What is reachable without a session.
 *
 * The list used to be "the auth routes and health", which was right until OAuth
 * discovery arrived: `/.well-known/` is the only unauthenticated path on this
 * hub that is not under `/api/`, so it fell through to the redirect at the
 * bottom. A host asking how to authenticate would have been handed an HTML
 * sign-in page, and the failure is invisible from the hub's side — the host
 * simply reports that the server does not implement OAuth.
 */

const saved = {
  issuer: process.env["PORTAL_OIDC_ISSUER"],
  devSession: process.env["PORTAL_ALLOW_DEV_SESSION"],
};

beforeEach(() => {
  // The gate only engages when OIDC is the live provider and the dev stub is
  // off. Vitest runs under NODE_ENV=test, so the stub's other trigger
  // (NODE_ENV=development) is already absent and needs no meddling.
  process.env["PORTAL_OIDC_ISSUER"] = "http://localhost:8080/realms/portal";
  process.env["PORTAL_ALLOW_DEV_SESSION"] = "0";
});

afterEach(() => {
  if (saved.issuer === undefined) delete process.env["PORTAL_OIDC_ISSUER"];
  else process.env["PORTAL_OIDC_ISSUER"] = saved.issuer;
  if (saved.devSession === undefined) delete process.env["PORTAL_ALLOW_DEV_SESSION"];
  else process.env["PORTAL_ALLOW_DEV_SESSION"] = saved.devSession;
});

function visit(pathname: string): { status: number; location: string | null } {
  const response = middleware(new NextRequest(new URL(`http://localhost:3000${pathname}`)));
  return { status: response.status, location: response.headers.get("location") };
}

describe("middleware", () => {
  it("lets OAuth discovery through with no session", () => {
    expect(visit("/.well-known/oauth-protected-resource/api/mcp").location).toBeNull();
    expect(visit("/.well-known/oauth-protected-resource").location).toBeNull();
    expect(visit("/.well-known/oauth-authorization-server").location).toBeNull();
  });

  it("still lets the auth routes and health through", () => {
    expect(visit("/api/auth/login").location).toBeNull();
    expect(visit("/healthz").location).toBeNull();
  });

  it("leaves API routes to answer their own 401", () => {
    // Including /api/mcp, which needs to return a WWW-Authenticate challenge
    // rather than a redirect an MCP host cannot follow.
    expect(visit("/api/mcp").location).toBeNull();
  });

  it("still redirects a document navigation with no session", () => {
    expect(visit("/orders").location).toContain("/api/auth/login");
  });
});
