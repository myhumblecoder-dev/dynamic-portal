import { tenantAuditKey } from "@portal/identity";
import type { Principal } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import { buildSurface, type ToolSurface } from "@portal/mcp-gateway";
import { beforeEach, describe, expect, it } from "vitest";
import { callMcpTool } from "./call";
import { mcpTools, serverInstructions } from "./tools";

/** Any key will do here; what matters is that one is required. */
const AUDIT_KEY = tenantAuditKey("test-root-key", "acme");

const principal: Principal = {
  sub: "staff@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
};

function surfaceFor(over: Record<string, unknown> = {}): ToolSurface {
  const satellite = SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    baseUrl: "http://localhost:4001",
    owner: "team",
    rbacScopes: ["orders.read"],
    tools: {
      "orders.approve": { agentVisible: true, rbacScopes: ["orders.write"] },
      "orders.refresh": { agentVisible: true, requiresConfirmation: false },
    },
    ...over,
  });

  const manifest = ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Order Management",
    screens: [{ id: "orders.list", title: "Orders", description: "All orders." }],
    actions: [
      {
        id: "orders.approve",
        title: "Approve order",
        params: [{ name: "id", type: "string", required: true }],
      },
      { id: "orders.refresh", title: "Refresh", params: [] },
    ],
  });

  return buildSurface([{ satellite, manifest }], principal);
}

/** Which satellite calls the gateway actually made, if any. */
let invoked: string[];

/**
 * A real gateway over a stubbed transport.
 *
 * The gateway is not mocked — entitlement, argument checking and the
 * confirmation gate all run for real, because those are the things a shell
 * around them can accidentally bypass. Only the socket is replaced.
 */
function stubbedDeps() {
  return {
    transport: {
      fetchScreen: async () => {
        invoked.push("fetchScreen");
        return {
          ok: true as const,
          value: {
            protocol: "1.1",
            screen: { id: "orders.list", title: "Orders" },
            ui: {
              type: "Page",
              children: [{ type: "StatTile", props: { label: "Pending", value: "2" } }],
            },
          },
        };
      },
      invokeAction: async () => {
        invoked.push("invokeAction");
        return {
          ok: true as const,
          value: {
            protocol: "1.1" as const,
            outcome: "ok" as const,
            toast: { level: "success" as const, message: "Refreshed." },
          },
        };
      },
    },
    auditKey: AUDIT_KEY,
    onAudit: () => {},
    now: () => 0,
    at: () => "2026-08-17T00:00:00.000Z",
    newId: () => "id",
  };
}

beforeEach(() => {
  invoked = [];
});

describe("what an MCP host is offered", () => {
  it("lists the reads with a read-only hint", () => {
    const tools = mcpTools(surfaceFor());
    const read = tools.find((tool) => tool.name === "orders__orders_list");
    expect(read?.annotations.readOnlyHint).toBe(true);
    expect(read?.annotations.destructiveHint).toBe(false);
    expect(read?.annotations.title).toBe("Orders");
  });

  it("lists an ungoverned write, marked destructive", () => {
    const refresh = mcpTools(surfaceFor()).find((tool) => tool.name === "orders__orders_refresh");
    expect(refresh?.annotations.destructiveHint).toBe(true);
    expect(refresh?.annotations.readOnlyHint).toBe(false);
  });

  it("does not list a write that needs a human to approve it", () => {
    // Not because the host is untrusted, but because the confirmation is a
    // person being shown what is about to happen in a screen the hub renders.
    // A host cannot render that, and a listed tool that always refuses looks
    // like a capability and is a dead end.
    expect(mcpTools(surfaceFor()).map((tool) => tool.name)).not.toContain(
      "orders__orders_approve",
    );
  });

  it("carries the gateway's schema through unchanged", () => {
    // The catalog is projected once, in the gateway. A second projection here
    // would be a second thing to keep in step.
    const refresh = mcpTools(surfaceFor()).find((tool) => tool.name === "orders__orders_refresh");
    expect(refresh?.inputSchema.additionalProperties).toBe(false);
  });

  it("shows an entitled principal nothing they could not reach in the portal", () => {
    const satellite = SatelliteSchema.parse({
      id: "orders",
      displayName: "Orders",
      baseUrl: "http://localhost:4001",
      owner: "team",
      rbacScopes: ["orders.read"],
    });
    const manifest = ManifestSchema.parse({
      protocol: "1.1",
      satelliteId: "orders",
      displayName: "Orders",
      screens: [{ id: "orders.list", title: "Orders" }],
      actions: [],
    });
    const narrow = buildSurface([{ satellite, manifest }], { ...principal, scopes: [] });
    expect(mcpTools(narrow)).toEqual([]);
  });
});

/**
 * The property that makes the outward endpoint safe to point a host at.
 *
 * A staff member connecting Claude Code authenticates through the same Keycloak
 * login as the portal, and their access token's realm roles become the
 * `Principal`'s roles. If the surface did not narrow on them, the endpoint would
 * be a way to escape the role gating the screens apply — the same account, the
 * same registry policy, a wider answer, because the credential arrived over a
 * different wire.
 *
 * Nothing in this file exercised that: the fixture principal above carries no
 * `roles` at all, so every case here ran un-role-gated.
 */
describe("roles scope the surface, not just the screens", () => {
  /** `orders.approve` is registry-gated to finance, as it is in config/satellites.yaml. */
  function roleGatedSurface(roles: readonly string[] | undefined): ToolSurface {
    const satellite = SatelliteSchema.parse({
      id: "orders",
      displayName: "Orders",
      baseUrl: "http://localhost:4001",
      owner: "team",
      tools: {
        "orders.approve": { agentVisible: true, requiresConfirmation: false, roles: ["finance"] },
        "orders.refresh": { agentVisible: true, requiresConfirmation: false },
      },
    });
    const manifest = ManifestSchema.parse({
      protocol: "1.1",
      satelliteId: "orders",
      displayName: "Orders",
      screens: [],
      actions: [
        { id: "orders.approve", title: "Approve order", params: [] },
        { id: "orders.refresh", title: "Refresh", params: [] },
      ],
    });
    return buildSurface(
      [{ satellite, manifest }],
      { ...principal, ...(roles !== undefined ? { roles: roles as never } : {}) },
    );
  }

  it("offers a finance-gated tool to finance", () => {
    const names = mcpTools(roleGatedSurface(["finance"])).map((tool) => tool.name);
    expect(names).toContain("orders__orders_approve");
  });

  it("hides it from engineering — the same endpoint, the same code, a different role", () => {
    const names = mcpTools(roleGatedSurface(["engineering"])).map((tool) => tool.name);
    expect(names).not.toContain("orders__orders_approve");
    // The un-gated tool is still there, so this is narrowing rather than a
    // surface that failed to build.
    expect(names).toContain("orders__orders_refresh");
  });

  it("refuses to call it by name for a role that cannot see it", async () => {
    const result = await callMcpTool(
      roleGatedSurface(["engineering"]),
      "orders__orders_approve",
      {},
      { ...principal, roles: ["engineering"] },
      stubbedDeps(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no tool named/i);
    // Absence, not refusal — and nothing reached the satellite.
    expect(invoked).toEqual([]);
  });

  it("hides it from a principal holding no roles at all", () => {
    const names = mcpTools(roleGatedSurface(undefined)).map((tool) => tool.name);
    expect(names).not.toContain("orders__orders_approve");
  });
});

describe("the instructions a host reads first", () => {
  it("names the governed writes and where to perform them", () => {
    // An agent that cannot see the tool will otherwise tell the user the thing
    // is impossible, when it is merely elsewhere.
    const instructions = serverInstructions(surfaceFor());
    expect(instructions).toContain("Approve order");
    expect(instructions).toMatch(/portal/i);
  });

  it("says nothing about governed writes when there are none", () => {
    const satellite = SatelliteSchema.parse({
      id: "orders",
      displayName: "Orders",
      baseUrl: "http://localhost:4001",
      owner: "team",
      rbacScopes: ["orders.read"],
    });
    const manifest = ManifestSchema.parse({
      protocol: "1.1",
      satelliteId: "orders",
      displayName: "Orders",
      screens: [{ id: "orders.list", title: "Orders" }],
      actions: [],
    });
    const instructions = serverInstructions(buildSurface([{ satellite, manifest }], principal));
    expect(instructions).not.toMatch(/not callable here/i);
  });
});

describe("calling a tool", () => {
  it("returns a read's data as text a host can render", async () => {
    const result = await callMcpTool(
      surfaceFor(),
      "orders__orders_list",
      {},
      principal,
      stubbedDeps(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Pending");
  });

  it("refuses a governed write by name, not only by omission", async () => {
    // Being absent from the listing is not enough: a host that guessed the name
    // would otherwise walk straight through the gate the listing respects.
    const result = await callMcpTool(
      surfaceFor(),
      "orders__orders_approve",
      { id: "ord-1" },
      principal,
      stubbedDeps(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/approved by a person in the portal/i);
    expect(invoked).toEqual([]);
  });

  it("refuses a tool that does not exist, without saying whether it might", async () => {
    const result = await callMcpTool(surfaceFor(), "orders__nope", {}, principal, stubbedDeps());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no tool named/i);
  });

  it("runs an ungoverned write and reports its outcome", async () => {
    const result = await callMcpTool(
      surfaceFor(),
      "orders__orders_refresh",
      {},
      principal,
      stubbedDeps(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Refreshed.");
    expect(invoked).toEqual(["invokeAction"]);
  });

  it("reports a bad argument as an error rather than forwarding it", async () => {
    const result = await callMcpTool(
      surfaceFor(),
      "orders__orders_refresh",
      { tenantId: "globex" },
      principal,
      stubbedDeps(),
    );
    expect(result.isError).toBe(true);
    expect(invoked).toEqual([]);
  });
});
