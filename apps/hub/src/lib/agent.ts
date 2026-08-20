import { randomUUID } from "node:crypto";
import type { Principal } from "@portal/identity";
import { anthropicClient, ollamaClient, type ModelClient } from "@portal/agent";
import {
  buildSurface,
  callSatelliteTool,
  invokeTool,
  listSatelliteTools,
  type InvokeDeps,
  type ToolResult,
  type ToolSurface,
  type ToolTransport,
} from "@portal/mcp-gateway";
import { visibleSatellites } from "@portal/registry";
import { auditKeyFor, recordAudit } from "./audit";
import { resolveModel } from "./model";
import { getPortal } from "./portal";

/**
 * The agent, as the hub sees it: the tool surface, the audited invoker, and
 * the client that carries a turn to a model.
 *
 * Whether an agent runs at all, and which model it would be, lives in
 * `./model` — everything there is a `process.env` read, which is what keeps it
 * importable from `instrumentation.ts` without pulling this file's filesystem
 * and vendor dependencies into the edge bundle. It is re-exported below so
 * that split is this file's problem and nobody else's.
 */

export {
  describeModel,
  isAgentAllowedForTenant,
  maxTurns,
  isAgentEnabled,
  resolveModel,
  type ResolvedModel,
} from "./model";

/**
 * What this principal's agent may call.
 *
 * Rebuilt per request from the live manifests rather than cached, so a
 * satellite that changed what it offers is reflected on the next question.
 * A satellite that cannot be reached contributes nothing and does not fail the
 * turn — the same scoped degradation the nav and the screens already have.
 */
export async function buildAgentSurface(principal: Principal): Promise<ToolSurface> {
  const portal = getPortal();
  const satellites = visibleSatellites(portal.registry, principal);

  const entries = await Promise.all(
    satellites.map(async (satellite) => {
      const manifest = await portal.clientFor(satellite).fetchManifest();
      if (!manifest.ok) return undefined;

      // Only for the satellites that declare one, which is deliberately most of
      // them not. A satellite with no `mcpUrl` costs nothing here — no
      // connection is opened and nothing waits on one.
      if (satellite.mcpUrl === undefined) {
        return { satellite, manifest: manifest.value };
      }

      const listed = await listSatelliteTools(satellite, principal, {
        principalSecret: portal.principalSecret,
        // The same patience the PUP client is given, from the same line of the
        // registry. A satellite that is slow on one surface is slow on both,
        // and the surface is rebuilt on every turn — an unbounded wait here is
        // one stopped satellite holding up every agent request in the hub.
        timeoutMs: satellite.timeoutMs,
      });
      if (listed.reason !== undefined) {
        // Loud, and only that. A satellite whose MCP server is down keeps every
        // tool the shim gives it, because those come from a manifest that was
        // fetched successfully — one surface being unreachable must not cost
        // the other. The same reasoning as the circuit breaker on screens.
        console.warn(`mcp: ${satellite.id} listed no tools — ${listed.reason}`);
      }
      return { satellite, manifest: manifest.value, mcpTools: listed.tools };
    }),
  );

  return buildSurface(
    entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    principal,
  );
}

export interface AgentInvoker {
  readonly invoke: (
    name: string,
    args: Record<string, unknown>,
    options: { readonly confirmed: boolean },
  ) => Promise<ToolResult>;
  /** Waits for this turn's audit writes. See `InvokerDeps.flush`. */
  readonly flush: () => Promise<void>;
}

export interface InvokerDeps {
  readonly deps: Omit<InvokeDeps, "confirmed">;
  /**
   * Waits for every audit write this turn started.
   *
   * The gateway's `onAudit` is synchronous and writing a file is not, so the
   * writes are collected here and awaited before a response goes out. A
   * response that left before its record was on disk would make the log
   * "mostly complete", which is the one thing an audit log may not be.
   */
  readonly flush: () => Promise<void>;
}

/**
 * Everything the gateway needs except the confirmation decision — which belongs
 * to whoever is asking, not to this factory. The agent loop supplies it per
 * call; the MCP route never supplies it at all.
 *
 * It does take the principal, and only for one reason: the digest key is
 * derived per tenant. The transport still hands the principal to each call
 * itself, so nothing else here is bound to an identity.
 */
export function agentInvokerDeps(principal: Principal): InvokerDeps {
  const portal = getPortal();
  const pending: Promise<void>[] = [];

  const transport: ToolTransport = {
    fetchScreen: (satelliteId, screenId, params, who) => {
      const satellite = portal.registry.find((entry) => entry.id === satelliteId);
      if (satellite === undefined) throw new Error(`no satellite ${satelliteId}`);
      return portal.clientFor(satellite).fetchScreen(screenId, params, who);
    },
    invokeAction: (satelliteId, actionId, params, who) => {
      const satellite = portal.registry.find((entry) => entry.id === satelliteId);
      if (satellite === undefined) throw new Error(`no satellite ${satelliteId}`);
      return portal.clientFor(satellite).invokeAction(actionId, params, who);
    },
  };

  // The first write that failed, held until `flush` can throw it. A rejection
  // is caught the moment the write starts rather than when `flush` gets to it:
  // between the two there is a model round trip, and a promise that rejects
  // with no handler attached takes the whole process down under Node's default
  // `--unhandled-rejections=throw`. Failing the request is the intent; failing
  // the container is not.
  let failure: unknown;

  return {
    deps: {
      transport,
      auditKey: auditKeyFor(principal),
      // The gateway builds a valid event for every call including the refusals.
      // This is where they land — started here, awaited in `flush`.
      onAudit: (event) => {
        pending.push(
          recordAudit(event).catch((error: unknown) => {
            failure ??= error;
          }),
        );
      },
      // One generic client for every satellite that hosts an MCP server. There
      // is no per-satellite branch here and there must never be one: "the hub
      // stays lightweight, with no custom code per solution" is the constraint
      // the whole architecture is built around, and a gateway that knew what
      // `orders.reconcile` meant would have broken it in the first file.
      callMcpTool: async (satelliteId, toolName, args, who) => {
        const satellite = portal.registry.find((entry) => entry.id === satelliteId);
        if (satellite === undefined || satellite.mcpUrl === undefined) {
          return { ok: false, kind: "unreachable", message: `no mcp server for ${satelliteId}` };
        }
        return callSatelliteTool(
          satellite,
          who,
          { principalSecret: portal.principalSecret, timeoutMs: satellite.timeoutMs },
          toolName,
          args,
        );
      },
      now: () => Date.now(),
      at: () => new Date().toISOString(),
      newId: () => randomUUID(),
    },
    flush: async () => {
      await Promise.all(pending);
      if (failure !== undefined) throw failure;
    },
  };
}

/**
 * The gateway, bound to one principal for one turn.
 *
 * Every call it makes is recorded under this tenant's key, including the ones
 * it refuses — "nothing happened" and "an agent was stopped from doing this"
 * are the same entry in a log that only records successes.
 */
export function agentInvoker(principal: Principal, surface: ToolSurface): AgentInvoker {
  const { deps, flush } = agentInvokerDeps(principal);

  return {
    flush,
    invoke: (name, args, options) =>
      invokeTool(surface, name, args, principal, { ...deps, confirmed: options.confirmed }),
  };
}

/**
 * The client this turn will talk to, built from the same resolution the
 * startup line reports — which is the only arrangement where a log cannot
 * describe a configuration the hub is not running.
 */
export function modelClient(): ModelClient {
  const resolved = resolveModel();

  if (resolved.provider === "ollama") {
    return ollamaClient({ baseUrl: resolved.baseUrl, model: resolved.model });
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to run the agent");
  return anthropicClient({ apiKey, model: resolved.model });
}
