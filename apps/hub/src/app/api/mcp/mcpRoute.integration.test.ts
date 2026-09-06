import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Who `/api/mcp` will answer, and who it will not.
 *
 * The endpoint had no test of any kind while it authenticated by browser cookie
 * — which is how it kept an unused `isAgentAllowedForTenant` import for the
 * whole life of the per-tenant kill switch, and how it would have been easy to
 * let a rejected bearer token quietly fall through to the development stub. Both
 * are decisions made before a single tool is listed, so neither is reachable
 * from the gateway's tests or from a satellite's.
 *
 * Integration tier: it binds a port for the JWKS and writes an audit file.
 */

const ISSUER_PATH = "/realms/portal";
const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/api/mcp`;

let keycloak: Server;
let satellite: Server;
let issuer: string;
let privateKey: KeyObject | CryptoKey;
let route: typeof import("./route");

const MANIFEST = {
  protocol: "1.1",
  satelliteId: "stub",
  displayName: "Stub",
  audience: ["internal"],
  screens: [{ id: "stub.list", title: "List", audience: ["internal"], blocks: [] }],
  actions: [],
};

async function token(over: { roles?: readonly string[]; tenant?: string } = {}): Promise<string> {
  return new SignJWT({
    preferred_username: "fin",
    tenant_id: over.tenant ?? "acme",
    realm_access: { roles: [...(over.roles ?? ["finance"])] },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("fin@acme.example")
    .setIssuer(issuer)
    .setAudience(RESOURCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** A JSON-RPC POST, with whatever credential (or none) the case is about. */
async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await route.POST(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  keycloak = createServer((req, res) => {
    if (req.url === `${ISSUER_PATH}/protocol/openid-connect/certs`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => keycloak.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(keycloak.address() as AddressInfo).port}${ISSUER_PATH}`;

  satellite = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/portal/manifest" ? MANIFEST : { protocol: "1.1", data: {} }));
  });
  await new Promise<void>((resolve) => satellite.listen(0, "127.0.0.1", resolve));
  const satellitePort = (satellite.address() as AddressInfo).port;

  const dir = mkdtempSync(join(tmpdir(), "portal-mcp-route-"));
  const registryPath = join(dir, "satellites.yaml");
  writeFileSync(
    registryPath,
    `- id: stub
  displayName: Stub
  baseUrl: http://127.0.0.1:${satellitePort}
  owner: test
  audience: [internal]
  timeoutMs: 5000
`,
  );

  // Set before the route is imported: `portal.ts` reads the registry path at
  // module scope. `PORTAL_ALLOW_DEV_SESSION` is deliberately left on for the
  // whole suite — the point of several cases below is that a bearer failure is
  // still a 401 with a stub identity sitting right there to fall back to.
  process.env["PORTAL_REGISTRY_PATH"] = registryPath;
  process.env["PORTAL_PRINCIPAL_SECRET"] = "test-secret";
  process.env["PORTAL_AUDIT_KEY"] = "test-audit-key";
  process.env["PORTAL_AUDIT_LOG"] = join(dir, "audit.jsonl");
  process.env["PORTAL_ALLOW_DEV_SESSION"] = "1";
  process.env["PORTAL_PUBLIC_ORIGIN"] = ORIGIN;
  process.env["PORTAL_OIDC_ISSUER"] = issuer;
  process.env["PORTAL_OIDC_CLIENT_ID"] = "portal-hub";
  process.env["PORTAL_OIDC_CLIENT_SECRET"] = "secret";
  delete process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
  delete process.env["PORTAL_AGENT_DISABLED_TENANTS"];

  route = await import("./route");
});

afterAll(async () => {
  await new Promise<void>((resolve) => keycloak.close(() => resolve()));
  await new Promise<void>((resolve) => satellite.close(() => resolve()));
});

describe("POST /api/mcp — the credential", () => {
  it("challenges an unauthenticated host and tells it where to look", async () => {
    process.env["PORTAL_ALLOW_DEV_SESSION"] = "0";
    try {
      const response = await post(INITIALIZE);
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
      );
    } finally {
      process.env["PORTAL_ALLOW_DEV_SESSION"] = "1";
    }
  });

  it("still answers the development stub where it is enabled", async () => {
    // The compose stack sets PORTAL_OIDC_ISSUER *and* leaves the stub on, and
    // the e2e suite drives this endpoint with no credential at all. Challenging
    // whenever OIDC happens to be configured would have broken that while
    // looking, from here, like a safer default.
    const response = await post(INITIALIZE);
    expect(response.status).toBe(200);
  });

  it("does not fall through to the development stub when a token is rejected", async () => {
    // The whole suite runs with PORTAL_ALLOW_DEV_SESSION=1, so a fall-through
    // would answer 200 as an all-roles principal. Presenting a bad credential
    // must never be a way to be treated as anonymous — that would make sending
    // garbage an upgrade.
    const response = await post(INITIALIZE, { authorization: "Bearer not-a-jwt" });
    expect(response.status).toBe(401);
    expect(response.text).toContain("invalid_token");
  });

  it("does not let an empty Bearer header be read as no credential", async () => {
    // `Authorization: Bearer ` is what a host sends when its token store is
    // empty and it interpolates the empty string. Parsing that to "no token" and
    // falling through would answer it with the dev stub's four roles — an empty
    // credential admitted as a full one, which is the exact inversion this
    // endpoint must never make.
    for (const header of ["Bearer ", "Bearer", "Basic dXNlcjpwYXNz"]) {
      const response = await post(INITIALIZE, { authorization: header });
      expect(response.status, `for ${JSON.stringify(header)}`).toBe(401);
    }
  });

  it("serves a host that presents a valid token", async () => {
    const response = await post(INITIALIZE, { authorization: `Bearer ${await token()}` });
    expect(response.status).toBe(200);
    expect(response.text).toContain("serverInfo");
  });

  it("accepts the scheme case-insensitively", async () => {
    const response = await post(INITIALIZE, { authorization: `bearer ${await token()}` });
    expect(response.status).toBe(200);
  });
});

describe("POST /api/mcp — the per-tenant kill switch", () => {
  it("closes the endpoint for a tenant that has withdrawn consent", async () => {
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = "acme";
    try {
      const response = await post(INITIALIZE, { authorization: `Bearer ${await token()}` });
      expect(response.status).toBe(403);
      expect(response.text).toContain("not enabled");
    } finally {
      delete process.env["PORTAL_AGENT_DISABLED_TENANTS"];
    }
  });

  it("leaves another tenant alone", async () => {
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = "globex";
    try {
      const response = await post(INITIALIZE, { authorization: `Bearer ${await token()}` });
      expect(response.status).toBe(200);
    } finally {
      delete process.env["PORTAL_AGENT_DISABLED_TENANTS"];
    }
  });
});
