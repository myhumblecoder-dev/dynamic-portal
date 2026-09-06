/**
 * RFC 7591 client registration, answered without registering anything.
 *
 * Every caller gets the same public client — the one seeded in the realm as
 * `portal-mcp`. Nothing is stored, no secret is issued, and Keycloak's own
 * registration endpoint is never exposed.
 *
 * This is a deliberate narrowing of what registration means, not an
 * implementation of it. A host asks for a client so it can start an
 * authorization-code flow; it does not care that the client is its own, and
 * this hub has no reason to let an unauthenticated caller create realm clients
 * in order to give it one. What still holds is everything registration is
 * *for*: the flow is PKCE-only, the client is public, and the redirect URI the
 * host will actually use is the one Keycloak enforces against `portal-mcp` —
 * echoing it below tells the host what it asked for, it does not authorize it.
 */

import { MCP_SCOPES } from "@/lib/mcpAuth";

/** The realm's seeded public client. Kept in sync with `docker/keycloak/realm-portal.json`. */
const MCP_CLIENT_ID = process.env["PORTAL_MCP_CLIENT_ID"] ?? "portal-mcp";

function invalid(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Whether `portal-mcp` would actually accept this callback.
 *
 * The realm registers the loopback form (`http://localhost/*`,
 * `http://127.0.0.1/*`), so a host asking for anything else — claude.ai's hosted
 * connector callback, say — cannot complete the flow. Registering it anyway and
 * saying nothing moves the failure to the far side of a successful login, where
 * Keycloak answers "Invalid parameter: redirect_uri" on a page the host cannot
 * trace back to the registration it just made. Refusing here costs the host one
 * legible error instead.
 *
 * Kept deliberately in step with the realm rather than derived from it: this
 * endpoint has no admin credentials and should not acquire any to answer a
 * question an unauthenticated caller asked.
 */
function isLoopback(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // Scheme and hostname both checked, and the hostname compared whole. A
  // `startsWith` here would be the same mistake a trailing-wildcard redirect URI
  // is in Keycloak: `localhost.attacker.example` begins with `localhost`.
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid("invalid_client_metadata", "The registration request body is not JSON.");
  }

  if (typeof body !== "object" || body === null) {
    return invalid("invalid_client_metadata", "The registration request body is not a JSON object.");
  }

  const requested = (body as { redirect_uris?: unknown }).redirect_uris;
  const redirectUris =
    Array.isArray(requested) && requested.every((uri): uri is string => typeof uri === "string")
      ? requested
      : [];

  if (redirectUris.length === 0) {
    return invalid(
      "invalid_client_metadata",
      "redirect_uris is required and must be a non-empty array of strings.",
    );
  }

  const unusable = redirectUris.filter((uri) => !isLoopback(uri));
  if (unusable.length > 0) {
    return invalid(
      "invalid_redirect_uri",
      `This server registers loopback callbacks only (http://localhost or http://127.0.0.1, any port). ` +
        `Cannot register: ${unusable.join(", ")}`,
    );
  }

  return Response.json(
    {
      client_id: MCP_CLIENT_ID,
      // No `client_secret`: a public client authenticating with PKCE. Returning
      // one would invite the host to store it, and a secret shipped to every
      // caller is not a secret.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: redirectUris,
      // Stated rather than left to the client to infer from the metadata's
      // `scopes_supported`. A client that asks for a scope this realm will not
      // grant these users — `offline_access` is the one — gets a *token*
      // request refused after a successful login.
      scope: MCP_SCOPES.join(" "),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
