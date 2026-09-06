import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  McpAuthError,
  bearerToken,
  challengeHeader,
  mcpResource,
  presentsCredential,
  resourceMetadataUrl,
} from "./mcpAuth";

/**
 * The parts of the bearer path that need no issuer.
 *
 * Header parsing and the challenge string are pure, and they are where the two
 * subtlest mistakes live — an empty `Bearer` treated as no credential, and a
 * description that breaks out of its own quoted header value. Verification
 * itself needs a JWKS over a socket and lives in `mcpAuth.integration.test.ts`,
 * because the unit tier is pure logic and this file has to stay in it.
 */

const saved = process.env["PORTAL_PUBLIC_ORIGIN"];

beforeAll(() => {
  process.env["PORTAL_PUBLIC_ORIGIN"] = "https://portal.example";
});

afterAll(() => {
  if (saved === undefined) delete process.env["PORTAL_PUBLIC_ORIGIN"];
  else process.env["PORTAL_PUBLIC_ORIGIN"] = saved;
});

function withHeader(value?: string): Request {
  return new Request("https://portal.example/api/mcp", {
    method: "POST",
    ...(value !== undefined ? { headers: { authorization: value } } : {}),
  });
}

describe("bearerToken", () => {
  it("accepts a lowercase scheme, as RFC 7235 requires", () => {
    expect(bearerToken(withHeader("bearer abc"))).toBe("abc");
    expect(bearerToken(withHeader("Bearer abc"))).toBe("abc");
    expect(bearerToken(withHeader("BEARER abc"))).toBe("abc");
  });

  it("is undefined when there is no header, and when the scheme is not bearer", () => {
    expect(bearerToken(withHeader())).toBeUndefined();
    expect(bearerToken(withHeader("Basic abc"))).toBeUndefined();
  });
});

describe("presentsCredential", () => {
  it("counts an empty Bearer as a credential, so it cannot be treated as anonymous", () => {
    // `Authorization: Bearer ` is what a host sends when its token store is empty
    // and it interpolates the empty string. Reading that as "no credential" sends
    // the request down the cookie path and, where the stub is on, answers it with
    // a full-roles identity.
    expect(bearerToken(withHeader("Bearer "))).toBeUndefined();
    expect(presentsCredential(withHeader("Bearer "))).toBe(true);
    expect(presentsCredential(withHeader("Bearer"))).toBe(true);
  });

  it("counts a scheme this endpoint does not accept", () => {
    // Presenting something unusable must not be a route to being treated as
    // though nothing was presented.
    expect(presentsCredential(withHeader("Basic dXNlcjpwYXNz"))).toBe(true);
  });

  it("is false only when no Authorization header was sent at all", () => {
    expect(presentsCredential(withHeader())).toBe(false);
  });
});

describe("McpAuthError", () => {
  it("pairs each code with the status RFC 6750 gives it", () => {
    expect(new McpAuthError("invalid_token", "x").status).toBe(401);
    expect(new McpAuthError("insufficient_scope", "x").status).toBe(403);
    expect(new McpAuthError("invalid_request", "x").status).toBe(400);
  });
});

describe("the challenge", () => {
  it("names the resource metadata document so a host can start discovery", () => {
    const header = challengeHeader("invalid_token", "nope");
    expect(header).toContain('Bearer error="invalid_token"');
    expect(header).toContain(`resource_metadata="${resourceMetadataUrl()}"`);
  });

  it("does not let a description break out of the quoted header value", () => {
    expect(challengeHeader("invalid_token", 'he said "hi"')).toContain(
      "error_description=\"he said 'hi'\"",
    );
  });
});

describe("the resource identifier", () => {
  it("is the MCP endpoint on the configured public origin", () => {
    // One definition, read by the metadata document, the challenge, and the
    // audience check. Two spellings is how a token minted elsewhere gets in.
    expect(mcpResource()).toBe("https://portal.example/api/mcp");
    expect(resourceMetadataUrl()).toBe(
      "https://portal.example/.well-known/oauth-protected-resource/api/mcp",
    );
  });
});
