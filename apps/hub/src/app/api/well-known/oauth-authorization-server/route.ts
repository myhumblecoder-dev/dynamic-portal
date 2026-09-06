import { MCP_SCOPES, publicOrigin } from "@/lib/mcpAuth";
import { getOidcConfig, oidcConfigured } from "@/lib/oidc";

/**
 * RFC 8414 authorization-server metadata, re-served with one field changed.
 *
 * Keycloak is the authorization server and stays the authorization server: the
 * `authorization_endpoint` and `token_endpoint` below are the realm's own, so
 * the browser goes straight there and the code is exchanged straight there.
 * The hub never sees a credential or an authorization code.
 *
 * The one substitution is `registration_endpoint`. Claude Desktop, Claude Code
 * and Copilot expect to register themselves (RFC 7591) and will not connect to
 * a server that offers nowhere to do it. The alternatives were to turn on
 * anonymous client registration in Keycloak — an unauthenticated endpoint that
 * mints realm clients, defended only by registration policies — or to point
 * that field at a hub route which hands every caller the same pre-registered
 * public client. The second exposes nothing, so it is what `/api/oauth/register`
 * does.
 *
 * The rest of the document is republished from the realm rather than written
 * out here, so a realm that moves, adds a response mode, or changes its signing
 * algorithms stays correctly described without anyone remembering this file.
 */

/** Fields worth forwarding. A allow-list, so a realm-specific extension never leaks by accident. */
const FORWARDED = [
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "userinfo_endpoint",
  "end_session_endpoint",
  "revocation_endpoint",
  "introspection_endpoint",
  "response_types_supported",
  "response_modes_supported",
  "id_token_signing_alg_values_supported",
] as const;
// `scopes_supported`, `grant_types_supported`,
// `token_endpoint_auth_methods_supported` and `code_challenge_methods_supported`
// are deliberately absent: they are narrowed below rather than republished,
// because this document describes one public PKCE client and not everything the
// realm is willing to do for every client it has.

/**
 * Put every endpoint back on the origin the *host* can reach.
 *
 * The hub discovers Keycloak through its internal origin, and Keycloak — with
 * `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` on — answers with backchannel URLs built
 * from the host it was asked on. So the realm's own document names
 * `http://keycloak:8080` for the token, JWKS and userinfo endpoints while the
 * frontchannel `authorization_endpoint` stays browser-facing.
 *
 * That split is right for the hub, which is inside the network, and wrong for
 * everyone this document is written for: an MCP host would send the user to the
 * right login page and then post the authorization code to a name that does not
 * resolve on its machine. The failure is at the last step of the flow, after a
 * successful login, which is the most expensive place to discover it.
 */
function publish(url: unknown, internalOrigin: string, publicOrigin: string): unknown {
  if (typeof url !== "string" || !url.startsWith(internalOrigin)) return url;
  return publicOrigin + url.slice(internalOrigin.length);
}

export async function GET(): Promise<Response> {
  if (!oidcConfigured()) {
    // Nothing truthful to say. A stub document naming endpoints that do not
    // exist would send a host into a flow that cannot complete, which is worse
    // than telling it this hub is not an OAuth resource today.
    return Response.json(
      { error: "oidc_not_configured" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await getOidcConfig()).serverMetadata() as unknown as Record<string, unknown>;
  } catch {
    // Keycloak may simply not be up yet — `getOidcConfig` deliberately does not
    // memoise a failure, so a host that retries gets a real document.
    return Response.json(
      { error: "authorization_server_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const internal = process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
  const issuerOrigin = new URL(process.env["PORTAL_OIDC_ISSUER"] ?? publicOrigin()).origin;
  const internalOrigin = internal !== undefined && internal !== "" ? new URL(internal).origin : undefined;

  const forwarded: Record<string, unknown> = {};
  for (const key of FORWARDED) {
    const value = metadata[key];
    if (value === undefined) continue;
    forwarded[key] =
      internalOrigin === undefined ? value : publish(value, internalOrigin, issuerOrigin);
  }

  return Response.json(
    {
      // The origin this document was fetched from, as RFC 8414 §3.3 requires.
      //
      // It is deliberately not Keycloak's issuer, and that is a real trade-off
      // rather than a free choice. Tokens are minted by Keycloak and carry its
      // `iss`, which the hub checks against `PORTAL_OIDC_ISSUER` itself. A host
      // that only redeems the code and presents the access token — which is what
      // MCP hosts do, the token being opaque to them — never compares the two.
      // A host that additionally requests `openid` and validates the returned
      // `id_token`'s `iss` against this field would reject it after a successful
      // login. Naming Keycloak here instead would fix that and break RFC 8414's
      // rule, sending conformant clients to Keycloak's own metadata where the
      // registration shim below does not exist — which is the failure this whole
      // document exists to avoid. Proxying the token endpoint through the hub is
      // the change that removes the trade-off; it is not made here.
      issuer: publicOrigin(),
      ...forwarded,
      registration_endpoint: `${publicOrigin()}/api/oauth/register`,
      // Only the scopes this flow needs, not everything the realm offers.
      //
      // Republishing Keycloak's list advertises `offline_access`, a client that
      // reads this document asks for every scope in it, and Keycloak then
      // refuses the *token* request — "Offline tokens not allowed for the user
      // or client" — because the seeded users declare `realmRoles` explicitly
      // and so do not carry the default role that permits offline tokens. The
      // login succeeds and the code exchange fails, which is the worst place in
      // the flow to put a misconfiguration. Ordinary refresh tokens are
      // unaffected: those come with the authorization-code grant and have
      // nothing to do with the `offline_access` scope.
      scopes_supported: MCP_SCOPES,
      // The client this document leads to is public, and Keycloak does not list
      // `none` among the realm's advertised methods even though that is exactly
      // how a public client authenticates. A host that picks its auth method
      // from this list would otherwise find nothing it can use.
      token_endpoint_auth_methods_supported: ["none"],
      // S256 only. The realm also advertises `plain`, which OAuth 2.1 forbids
      // and which would leave the code interceptable — there is no reason to
      // offer a downgrade to a client that is being told to register fresh.
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    },
    { headers: { "cache-control": "no-store" } },
  );
}
