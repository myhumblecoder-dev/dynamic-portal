import { mcpResource, publicOrigin } from "@/lib/mcpAuth";
import { oidcConfigured } from "@/lib/oidc";

/**
 * RFC 9728 protected-resource metadata: how to authenticate to `/api/mcp`.
 *
 * Reached at `/.well-known/oauth-protected-resource/api/mcp` — and at the bare
 * `/.well-known/oauth-protected-resource` — through rewrites in
 * `next.config.ts`, because Next's router will not serve a dot-prefixed
 * directory. The MCP client probes the path-aware form first and falls back to
 * the root one, so both map here and both answer the same document: there is
 * one protected resource on this hub.
 *
 * Public and unauthenticated by design. It names an endpoint and an issuer,
 * which is exactly what a host that has not authenticated yet needs to know,
 * and nothing that is not already discoverable from Keycloak itself.
 */
export function GET(): Response {
  if (!oidcConfigured()) {
    // Gated for the same reason the authorization-server document is. Answering
    // here and 404ing there sends a host one hop further before it fails, and it
    // then reports "this server does not implement OAuth" — a true sentence
    // about the wrong endpoint. A hub with no issuer configured genuinely has no
    // protected resource to describe.
    return Response.json(
      { error: "oidc_not_configured" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      resource: mcpResource(),
      // The hub, not Keycloak. The hub re-serves the realm's authorization
      // metadata with one field changed (see the sibling route), and a host
      // that went straight to Keycloak would never see that change.
      authorization_servers: [publicOrigin()],
      bearer_methods_supported: ["header"],
      resource_name: "Dynamic Portal",
      resource_documentation: `${publicOrigin()}/`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
