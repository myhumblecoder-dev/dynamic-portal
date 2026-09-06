import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The authorization-server document must name endpoints the *host* can reach.
 *
 * Keycloak runs with `KC_HOSTNAME_BACKCHANNEL_DYNAMIC`, so it builds backchannel
 * URLs from whatever host it was asked on. The hub asks over the internal origin
 * — that is the whole point of `PORTAL_OIDC_INTERNAL_ORIGIN` — and gets back a
 * document whose `token_endpoint` and `jwks_uri` are internal names, while the
 * frontchannel `authorization_endpoint` stays browser-facing.
 *
 * Republishing that unchanged sends an MCP host to the right login page and then
 * to a hostname that does not resolve on its machine, so the flow dies at the
 * code exchange — after the user has already logged in successfully. It cost a
 * live `docker compose up` to see; this file is why it will not cost that again.
 *
 * Its own file because `getOidcConfig` memoises the discovered configuration for
 * the life of the module, and this case needs a different one from its
 * neighbours'.
 *
 * Integration tier: it binds a port.
 */

let keycloak: Server;
let port: number;
/** Browser-facing, as `KC_HOSTNAME` is. */
let issuer: string;
/** What the hub reaches Keycloak at — a different name for the same server. */
let internalOrigin: string;

beforeAll(async () => {
  keycloak = createServer((req, res) => {
    if (req.url?.endsWith("/.well-known/openid-configuration") === true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          // Frontchannel: browser-facing, exactly as Keycloak reports it.
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          // Backchannel: named for the origin the hub asked on. This is the trap.
          token_endpoint: `${internalOrigin}/realms/portal/protocol/openid-connect/token`,
          jwks_uri: `${internalOrigin}/realms/portal/protocol/openid-connect/certs`,
          userinfo_endpoint: `${internalOrigin}/realms/portal/protocol/openid-connect/userinfo`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["plain", "S256"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => keycloak.listen(0, "127.0.0.1", resolve));
  port = (keycloak.address() as AddressInfo).port;

  // Two names for one reachable server, mirroring localhost:8080 vs keycloak:8080.
  issuer = `http://localhost:${port}/realms/portal`;
  internalOrigin = `http://127.0.0.1:${port}`;

  process.env["PORTAL_PUBLIC_ORIGIN"] = "http://localhost:3000";
  process.env["PORTAL_OIDC_ISSUER"] = issuer;
  process.env["PORTAL_OIDC_INTERNAL_ORIGIN"] = internalOrigin;
  process.env["PORTAL_OIDC_CLIENT_ID"] = "portal-hub";
  process.env["PORTAL_OIDC_CLIENT_SECRET"] = "portal-hub-dev-secret";
});

afterAll(async () => {
  delete process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
  await new Promise<void>((resolve) => keycloak.close(() => resolve()));
});

describe("authorization server metadata, behind an internal origin", () => {
  it("moves the backchannel endpoints onto the browser-facing origin", async () => {
    const route = await import("./oauth-authorization-server/route");
    const body = (await (await route.GET()).json()) as Record<string, string>;

    expect(body["token_endpoint"]).toBe(`http://localhost:${port}/realms/portal/protocol/openid-connect/token`);
    expect(body["jwks_uri"]).toBe(`http://localhost:${port}/realms/portal/protocol/openid-connect/certs`);
    // The frontchannel endpoint was already right and must not be disturbed.
    expect(body["authorization_endpoint"]).toBe(`${issuer}/protocol/openid-connect/auth`);
    // Nothing anywhere in the document still names the internal origin.
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });
});
