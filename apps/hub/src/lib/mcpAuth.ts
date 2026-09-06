import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Principal } from "@portal/identity";
import { principalFromClaims, type OidcClaims } from "./oidc";

/**
 * The hub as an OAuth 2.0 resource server, for the outward MCP endpoint.
 *
 * The screens authenticate with a cookie, which is the right credential for a
 * browser and the wrong one for Claude Desktop, Claude Code, or an IDE agent —
 * none of which has one, and none of which should be handed one. Those hosts
 * speak OAuth: they discover this resource, send the user through the very same
 * Keycloak login the portal uses, and come back with a bearer access token.
 *
 * What this module does *not* do is decide anything. It verifies a signature
 * and hands the claims to `principalFromClaims` — the same mapper the cookie
 * login uses, filtering the same four roles and refusing the same tenantless
 * token. From there the request is indistinguishable from a browser's: the same
 * `entitle()` filters the same surface. The difference is the wire, not the
 * policy, and that is only true because this file resolves an identity rather
 * than an entitlement.
 */

/** OAuth 2.0 error codes this resource server emits (RFC 6750 §3.1). */
export type McpAuthErrorCode = "invalid_request" | "invalid_token" | "insufficient_scope";

/**
 * The status RFC 6750 §3.1 pairs with each code.
 *
 * `invalid_token` rather than `invalid_request` is what an absent credential
 * gets, which is worth stating because the intuitive choice is the wrong one: a
 * host is meant to read the 401, follow `resource_metadata`, and go and
 * authenticate. `invalid_request` is a 400 — a malformed request, not a missing
 * credential — and a host that treats it as such will report the server broken
 * instead of starting the flow. The MCP SDK's own bearer middleware answers a
 * missing header with `invalid_token` for the same reason.
 */
const STATUS: Record<McpAuthErrorCode, number> = {
  invalid_request: 400,
  invalid_token: 401,
  insufficient_scope: 403,
};

export class McpAuthError extends Error {
  readonly code: McpAuthErrorCode;
  readonly status: number;

  constructor(code: McpAuthErrorCode, message: string) {
    super(message);
    this.name = "McpAuthError";
    this.code = code;
    this.status = STATUS[code];
  }
}

/**
 * The public origin this hub is reached at.
 *
 * Discovery documents and the `WWW-Authenticate` challenge must name URLs the
 * *host* can fetch, not whatever internal address served the request, so this
 * is configuration rather than a header read. `Host` would be attacker-supplied
 * and this value ends up inside a token audience check.
 */
export function publicOrigin(): string {
  return process.env["PORTAL_PUBLIC_ORIGIN"] ?? "http://localhost:3000";
}

/**
 * The RFC 8707 resource identifier for the MCP endpoint.
 *
 * One definition, three readers: the protected-resource metadata document, the
 * `resource_metadata` hint in the challenge, and the audience this module
 * requires of a token. Two spellings of "which resource is this" is how a token
 * minted for something else starts being accepted here.
 */
export function mcpResource(): string {
  return `${publicOrigin()}/api/mcp`;
}

/**
 * The scopes an MCP host should ask for, and the only ones this flow needs.
 *
 * `openid` for the exchange, `profile`/`email` for a subject the audit log can
 * name. Deliberately *not* the realm's full list: that includes `offline_access`,
 * and a client asking for every advertised scope gets its token request refused
 * because the seeded users declare `realmRoles` explicitly and so lack the
 * default role permitting offline tokens. Published here and echoed by the
 * registration shim so both say one thing.
 */
export const MCP_SCOPES = ["openid", "profile", "email"] as const;

/** Where a host should look to learn how to authenticate (RFC 9728). */
export function resourceMetadataUrl(): string {
  return `${publicOrigin()}/.well-known/oauth-protected-resource/api/mcp`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required to verify an MCP bearer token`);
  }
  return value;
}

/**
 * The issuer's JWKS endpoint, on the origin *this process* can reach.
 *
 * Same split as `bridgedFetch` in `lib/oidc.ts`: in Docker the browser reaches
 * Keycloak at `localhost:8080` — which must stay the issuer, because it is what
 * lands in the token's `iss` and what the browser was redirected to — while the
 * hub container reaches it at `keycloak:8080`. Only the fetch target moves; the
 * `iss` check below still compares against the public issuer, so bridging the
 * origin never widens what is accepted.
 */
function jwksUrl(): URL {
  const issuer = new URL(required("PORTAL_OIDC_ISSUER"));
  const url = new URL(`${issuer.pathname.replace(/\/$/, "")}/protocol/openid-connect/certs`, issuer);
  const internal = process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
  if (internal !== undefined && internal !== "") {
    return new URL(url.pathname + url.search, new URL(internal).origin);
  }
  return url;
}

/**
 * The key set, resolved once.
 *
 * `createRemoteJWKSet` caches and re-fetches on an unknown `kid` by itself, so
 * memoising the set is what gives key rotation for free — memoising a *key*
 * would not. Keyed by URL so a test that repoints the issuer is not served the
 * previous realm's keys.
 */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = jwksUrl();
  const cached = keySets.get(url.href);
  if (cached !== undefined) return cached;
  const created = createRemoteJWKSet(url);
  keySets.set(url.href, created);
  return created;
}

/** Drop every cached key set. Exported for tests, which move the issuer between cases. */
export function resetJwksCache(): void {
  keySets.clear();
}

/**
 * Whether the caller presented a credential at all.
 *
 * Deliberately "is there an Authorization header", not "is there a usable bearer
 * token": those are different questions and only this one may decide whether the
 * bearer path runs. `Authorization: Bearer ` with an empty value — what a host
 * sends when its token store is empty and it interpolates the empty string —
 * yields no token, and if that counted as *no credential* the request would fall
 * through to the cookie and then to the development stub, answering an empty
 * credential with a full-roles identity. A `Basic` header is refused here for
 * the same reason: presenting something this endpoint does not accept must never
 * be a way to be treated as though nothing was presented.
 */
export function presentsCredential(request: Request): boolean {
  return request.headers.get("authorization") !== null;
}

/** The bearer token from an Authorization header, or undefined when there is none. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  // RFC 7235 makes the scheme case-insensitive, which the satellites already
  // honour (`/^bearer /i` in each of the three languages). A host that sends
  // `bearer` must not be told its credential is missing.
  const match = /^bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The realm roles carried by a verified access token.
 *
 * Keycloak nests them under `realm_access.roles`. Unlike the login callback —
 * which decodes the access token without re-verifying it, because it arrived in
 * an exchange openid-client had just validated — these claims come from a token
 * whose signature *this* function's caller checked. `principalFromClaims` still
 * filters them down to the four roles this system understands.
 */
function realmRoles(payload: JWTPayload): string[] {
  const realmAccess = payload["realm_access"];
  if (typeof realmAccess !== "object" || realmAccess === null) return [];
  const roles = (realmAccess as { roles?: unknown }).roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}

/**
 * Verify a bearer token and map it to the same `Principal` the cookie yields.
 *
 * Throws `McpAuthError` for anything a host can act on. Every rejection is the
 * same shape deliberately: a caller learns that its token was not accepted and
 * not which of the checks it failed.
 */
export async function principalFromBearer(request: Request): Promise<Principal> {
  const token = bearerToken(request);
  if (token === undefined) {
    throw new McpAuthError(
      "invalid_token",
      "Expected an Authorization header of the form 'Bearer <token>'.",
    );
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks(), {
      issuer: required("PORTAL_OIDC_ISSUER"),
      // The token must have been minted *for this endpoint*. Keycloak does not
      // honour the RFC 8707 `resource` parameter, so the realm carries an
      // audience mapper putting this exact value in `aud`; without the check a
      // token issued for any other client in the realm would open the portal.
      audience: mcpResource(),
    }));
  } catch {
    // Signature, issuer, audience and expiry collapse into one message on
    // purpose. Telling a caller *which* check failed tells it how to get closer.
    throw new McpAuthError("invalid_token", "The access token is not valid for this resource.");
  }

  // `jwtVerify` rejects an *expired* token but accepts one with no `exp` at all.
  // A credential that never expires is not one this endpoint should hold, and
  // the MCP SDK's own bearer middleware refuses it for the same reason.
  if (typeof payload.exp !== "number") {
    throw new McpAuthError("invalid_token", "The access token has no expiry.");
  }

  try {
    return principalFromClaims(payload as OidcClaims, realmRoles(payload));
  } catch {
    // A verified token that cannot become a principal — no subject, or no
    // `tenant_id` — is a realm misconfiguration, but it reaches the host as a
    // rejected credential either way. Failing closed here is what keeps the
    // tenantless-principal refusal in `principalFromClaims` meaningful.
    throw new McpAuthError("invalid_token", "The access token carries no usable portal identity.");
  }
}

/**
 * The `WWW-Authenticate` value for a rejected or absent credential.
 *
 * Shaped exactly like the MCP SDK's own `requireBearerAuth` builds it, because
 * hosts parse this string to find `resource_metadata` and start discovery. The
 * SDK's middleware is Express-only, so the header is rebuilt here rather than
 * reused — the format is the contract, not the code.
 */
export function challengeHeader(code: McpAuthErrorCode, description: string): string {
  return (
    `Bearer error="${code}", error_description="${description.replace(/"/g, "'")}", ` +
    `resource_metadata="${resourceMetadataUrl()}"`
  );
}
