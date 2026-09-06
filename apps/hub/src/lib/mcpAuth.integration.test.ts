import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpAuthError, mcpResource, principalFromBearer, resetJwksCache } from "./mcpAuth";

/**
 * The bearer path, against a real JWKS over a real socket.
 *
 * A stubbed verifier would let every one of these pass while the endpoint was
 * open: the assertions that matter here are the *rejections*, and a fake
 * `jwtVerify` is exactly the thing that cannot fail to reject. So the suite
 * mints tokens with `jose` and serves the public key from an ephemeral HTTP
 * server, which is what Keycloak is to this module.
 */

const ISSUER_PATH = "/realms/portal";
const RESOURCE = "http://localhost:3000/api/mcp";

let server: Server;
let issuer: string;
let privateKey: KeyObject | CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  server = createServer((req, res) => {
    if (req.url === `${ISSUER_PATH}/protocol/openid-connect/certs`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ISSUER_PATH}`;

  process.env["PORTAL_OIDC_ISSUER"] = issuer;
  process.env["PORTAL_PUBLIC_ORIGIN"] = "http://localhost:3000";
  delete process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => resetJwksCache());

interface TokenOptions {
  readonly sub?: string;
  readonly tenant_id?: unknown;
  readonly roles?: readonly string[];
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresIn?: string | null;
  readonly key?: KeyObject | CryptoKey;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    preferred_username: "fin",
    email: "fin@acme.example",
    realm_access: { roles: [...(options.roles ?? ["finance"])] },
  };
  if (options.tenant_id !== null) claims["tenant_id"] = options.tenant_id ?? "acme";

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(options.sub ?? "ac977b5e-1234")
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? RESOURCE)
    .setIssuedAt();
  if (options.expiresIn !== null) jwt = jwt.setExpirationTime(options.expiresIn ?? "5m");
  return jwt.sign(options.key ?? privateKey);
}

function request(header?: string): Request {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    ...(header !== undefined ? { headers: { authorization: header } } : {}),
  });
}

describe("principalFromBearer", () => {
  it("maps a valid token into the same Principal the cookie login would", async () => {
    const principal = await principalFromBearer(request(`Bearer ${await token()}`));
    expect(principal.sub).toBe("ac977b5e-1234");
    expect(principal.tenantId).toBe("acme");
    expect(principal.audience).toBe("internal");
    expect(principal.roles).toEqual(["finance"]);
    // Scopes stay the fixed internal set, exactly as the cookie path grants them.
    expect(principal.scopes).toContain("orders.read");
  });

  it("carries the token's roles, so the MCP surface mirrors the portal's", async () => {
    const eng = await principalFromBearer(
      request(`Bearer ${await token({ roles: ["engineering"] })}`),
    );
    expect(eng.roles).toEqual(["engineering"]);
  });

  it("filters Keycloak built-in roles out", async () => {
    const principal = await principalFromBearer(
      request(`Bearer ${await token({ roles: ["offline_access", "finance", "default-roles-portal"] })}`),
    );
    expect(principal.roles).toEqual(["finance"]);
  });

  it("refuses a token with no tenant_id rather than inventing a tenant", async () => {
    await expect(
      principalFromBearer(request(`Bearer ${await token({ tenant_id: null })}`)),
    ).rejects.toBeInstanceOf(McpAuthError);
  });

  it("refuses a token minted for a different audience", async () => {
    await expect(
      principalFromBearer(request(`Bearer ${await token({ audience: "http://localhost:3000/other" })}`)),
    ).rejects.toMatchObject({ code: "invalid_token", status: 401 });
  });

  it("refuses a token from a different issuer", async () => {
    await expect(
      principalFromBearer(request(`Bearer ${await token({ issuer: "http://elsewhere.example/realms/x" })}`)),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses an expired token", async () => {
    await expect(
      principalFromBearer(request(`Bearer ${await token({ expiresIn: "-1m" })}`)),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses a token with no expiry at all", async () => {
    await expect(
      principalFromBearer(request(`Bearer ${await token({ expiresIn: null })}`)),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses a token signed by a key the issuer does not publish", async () => {
    const foreign = await generateKeyPair("RS256", { extractable: true });
    await expect(
      principalFromBearer(request(`Bearer ${await token({ key: foreign.privateKey })}`)),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses an absent credential with a 401 a host will act on", async () => {
    // Not `invalid_request`/400, which reads as "your request is malformed" and
    // stops a host rather than sending it to authenticate.
    await expect(principalFromBearer(request())).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });
});

describe("the resource identifier", () => {
  it("audiences tokens to the same resource the metadata advertises", () => {
    // The audience `principalFromBearer` requires above and the `resource` the
    // metadata document publishes have to be one value, or hosts obtain tokens
    // this endpoint will not accept.
    expect(mcpResource()).toBe(RESOURCE);
  });
});
