import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The two documents a host reads before it has any credential at all.
 *
 * Everything else in this feature is reachable only once OAuth has succeeded,
 * which makes these the pieces a mistake hides in longest: a wrong `resource`
 * silently audiences tokens to something the endpoint will reject, and a
 * missing `registration_endpoint` simply makes Claude Desktop refuse to
 * connect, with nothing on this side to notice it.
 *
 * Integration tier: it binds a port to stand in for Keycloak's discovery.
 */

const ORIGIN = "http://localhost:3000";

let keycloak: Server;
let issuer: string;
let prm: typeof import("./oauth-protected-resource/route");
let as: typeof import("./oauth-authorization-server/route");

beforeAll(async () => {
  keycloak = createServer((req, res) => {
    if (req.url === "/realms/portal/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          // Keycloak advertises its own registration endpoint; the shim must
          // replace it rather than pass it through, or a host would register
          // against the realm directly.
          registration_endpoint: `${issuer}/clients-registrations/openid-connect`,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => keycloak.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(keycloak.address() as AddressInfo).port}/realms/portal`;

  process.env["PORTAL_PUBLIC_ORIGIN"] = ORIGIN;
  process.env["PORTAL_OIDC_ISSUER"] = issuer;
  process.env["PORTAL_OIDC_CLIENT_ID"] = "portal-hub";
  process.env["PORTAL_OIDC_CLIENT_SECRET"] = "portal-hub-dev-secret";
  delete process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];

  prm = await import("./oauth-protected-resource/route");
  as = await import("./oauth-authorization-server/route");
});

afterAll(async () => {
  await new Promise<void>((resolve) => keycloak.close(() => resolve()));
});

describe("protected resource metadata", () => {
  it("names the MCP endpoint as the resource, matching the audience tokens must carry", async () => {
    const body = (await prm.GET().json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(`${ORIGIN}/api/mcp`);
    expect(body["bearer_methods_supported"]).toEqual(["header"]);
  });

  it("points at the hub rather than Keycloak, so the registration shim is seen", async () => {
    const body = (await prm.GET().json()) as { authorization_servers: string[] };
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });

  it("says nothing at all when there is no issuer configured", async () => {
    // Answering here while the authorization-server document 404s would send a
    // host one hop further before failing, and it would then report "this server
    // does not implement OAuth" — true of the wrong endpoint. A hub with no
    // issuer has no protected resource to describe.
    const saved = process.env["PORTAL_OIDC_CLIENT_ID"];
    delete process.env["PORTAL_OIDC_CLIENT_ID"];
    try {
      expect(prm.GET().status).toBe(404);
    } finally {
      if (saved !== undefined) process.env["PORTAL_OIDC_CLIENT_ID"] = saved;
    }
  });
});

describe("authorization server metadata", () => {
  it("republishes the realm's own authorize and token endpoints", async () => {
    const body = (await (await as.GET()).json()) as Record<string, string>;
    expect(body["authorization_endpoint"]).toBe(`${issuer}/protocol/openid-connect/auth`);
    expect(body["token_endpoint"]).toBe(`${issuer}/protocol/openid-connect/token`);
    expect(body["jwks_uri"]).toBe(`${issuer}/protocol/openid-connect/certs`);
  });

  it("replaces the registration endpoint with the hub's shim", async () => {
    const body = (await (await as.GET()).json()) as Record<string, string>;
    expect(body["registration_endpoint"]).toBe(`${ORIGIN}/api/oauth/register`);
    expect(JSON.stringify(body)).not.toContain("clients-registrations");
  });

  it("advertises the origin it was fetched from as the issuer, per RFC 8414", async () => {
    const body = (await (await as.GET()).json()) as Record<string, string>;
    expect(body["issuer"]).toBe(ORIGIN);
  });

  it("advertises S256 only, never the `plain` downgrade the realm also offers", async () => {
    const body = (await (await as.GET()).json()) as Record<string, string[]>;
    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
  });

  it("advertises only the scopes this flow can actually obtain", async () => {
    // Republishing the realm's list advertises `offline_access`; a client asks
    // for everything advertised; Keycloak then refuses the *token* request with
    // "Offline tokens not allowed for the user or client", because the seeded
    // users declare `realmRoles` explicitly and so lack the default role that
    // permits offline tokens. That failure lands after a successful login, and
    // it is what actually stopped Claude Desktop connecting.
    const body = (await (await as.GET()).json()) as Record<string, string[]>;
    expect(body["scopes_supported"]).toEqual(["openid", "profile", "email"]);
    expect(body["scopes_supported"]).not.toContain("offline_access");
  });

  it("advertises `none`, which is how the public client this leads to authenticates", async () => {
    // Keycloak does not list it among the realm's methods, and a host that picks
    // one from the list would find nothing it could use.
    const body = (await (await as.GET()).json()) as Record<string, string[]>;
    expect(body["token_endpoint_auth_methods_supported"]).toEqual(["none"]);
  });

});

describe("the registration shim", () => {
  it("hands every caller the same pre-registered public client", async () => {
    const register = await import("../oauth/register/route");
    const response = await register.POST(
      new Request(`${ORIGIN}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude Code",
          redirect_uris: ["http://localhost:33418/callback"],
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["client_id"]).toBe("portal-mcp");
    expect(body["token_endpoint_auth_method"]).toBe("none");
    // No secret is issued: one shipped to every caller would not be a secret.
    expect(body["client_secret"]).toBeUndefined();
    expect(body["redirect_uris"]).toEqual(["http://localhost:33418/callback"]);
    // Stated, not left to be inferred from the metadata — and never
    // `offline_access`, which these users cannot be granted.
    expect(body["scope"]).toBe("openid profile email");
  });

  it("refuses a request with no redirect_uris", async () => {
    const response = await registerWith({ client_name: "nope" });
    expect(response.status).toBe(400);
    expect((await response.json())["error"]).toBe("invalid_client_metadata");
  });

  it("refuses a callback the realm's client could never accept", async () => {
    // The seeded client registers loopback callbacks only. Saying yes to a
    // hosted connector's https callback and letting Keycloak refuse it later
    // moves the failure past a successful login, where the host cannot connect
    // it to the registration it just made.
    const response = await registerWith({
      client_name: "hosted connector",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(response.status).toBe(400);
    expect((await response.json())["error"]).toBe("invalid_redirect_uri");
  });

  it("refuses a host that merely starts with localhost", async () => {
    // The same trap as a trailing-wildcard redirect URI in Keycloak:
    // `localhost.attacker.example` begins with `localhost` and is not loopback.
    const response = await registerWith({
      redirect_uris: ["http://localhost.attacker.example/callback"],
    });
    expect(response.status).toBe(400);
    expect((await response.json())["error"]).toBe("invalid_redirect_uri");
  });

  it("accepts loopback on any port, which is what hosts actually bind", async () => {
    for (const uri of ["http://localhost:1/cb", "http://127.0.0.1:65535/callback?x=1"]) {
      const response = await registerWith({ redirect_uris: [uri] });
      expect(response.status, uri).toBe(201);
    }
  });
});

async function registerWith(body: Record<string, unknown>): Promise<Response> {
  const register = await import("../oauth/register/route");
  return register.POST(
    new Request(`${ORIGIN}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
