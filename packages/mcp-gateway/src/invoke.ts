import { toolCall, type AuditEvent, type Principal } from "@portal/identity";
import type { ActionOutcome, ActionResponse, ScreenResponse } from "@portal/protocol";
import type { Failure, Result } from "@portal/registry";
import { extractData, type ExtractedData } from "./extract";
import type { JsonObjectSchema, ToolDescriptor } from "./shim";
import type { ToolSurface } from "./surface";

/**
 * Running one tool call.
 *
 * Three things happen here that do not happen anywhere else, and each is the
 * reason the gateway exists rather than letting a model call PUP directly.
 *
 * **Arguments are checked against the schema the model was given.** That schema
 * is a request, not an enforcement — a model may send whatever it likes. An
 * undeclared field forwarded to a satellite is a parameter the registry never
 * showed the agent, and `tenantId` is the obvious one to worry about.
 *
 * **A write does not run unconfirmed.** A gateway that executed first and
 * reported needing confirmation afterwards would have already done the thing.
 *
 * **Every attempt is audited, including the refusals.** "Nothing happened" and
 * "an agent was stopped from doing this" look identical in a log that only
 * records successes, and the second is what a regulator asks about.
 */

export interface ToolTransport {
  fetchScreen(
    satelliteId: string,
    screenId: string,
    params: Readonly<Record<string, string>>,
    principal: Principal,
  ): Promise<Result<ScreenResponse>>;

  invokeAction(
    satelliteId: string,
    actionId: string,
    params: unknown,
    principal: Principal,
  ): Promise<Result<ActionResponse>>;
}

export interface InvokeDeps {
  readonly transport: ToolTransport;
  readonly onAudit: (event: AuditEvent) => void;
  /** Injected so the audit record has a real clock without this file owning one. */
  readonly now: () => number;
  readonly at: () => string;
  readonly newId: () => string;
  /** Set by whatever showed the user the confirmation card. */
  readonly confirmed?: boolean;
}

export type ToolFailureReason =
  | "unknown-tool"
  | "needs-confirmation"
  | "bad-arguments"
  | Failure["reason"];

export type ToolResult =
  | { readonly ok: true; readonly kind: "read"; readonly data: ExtractedData }
  | {
      readonly ok: true;
      readonly kind: "write";
      readonly outcome: ActionOutcome;
      readonly message?: string;
      readonly fieldErrors?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly reason: ToolFailureReason; readonly message: string };

export async function invokeTool(
  surface: ToolSurface,
  name: string,
  args: Readonly<Record<string, unknown>>,
  principal: Principal,
  deps: InvokeDeps,
): Promise<ToolResult> {
  const started = deps.now();
  const tool = surface.byName.get(name);

  const record = (
    satelliteId: string,
    status: "ok" | "denied" | "error",
    reason?: string,
  ): void => {
    deps.onAudit(
      toolCall({
        id: deps.newId(),
        at: deps.at(),
        principal,
        satelliteId,
        toolName: name,
        // One call, one id. The agent's own tool-call id arrives in M2's loop;
        // until then this is what a rendered fact would cite.
        toolCallId: deps.newId(),
        // Digested, never stored: the arguments are the regulated part.
        args,
        outcome: { status, ...(reason === undefined ? {} : { reason }) },
        latencyMs: Math.max(deps.now() - started, 0),
      }),
    );
  };

  if (tool === undefined) {
    // A tool this principal may not call is simply absent from their surface,
    // so it is indistinguishable from one that does not exist. Same
    // non-disclosure the screen route makes, for the same reason.
    record("unknown", "denied", "unknown-tool");
    return { ok: false, reason: "unknown-tool", message: `No tool named "${name}" is available.` };
  }

  const checked = checkArguments(tool.inputSchema, args, tool.kind);
  if (!checked.ok) {
    record(tool.satelliteId, "denied", "bad-arguments");
    return { ok: false, reason: "bad-arguments", message: checked.message };
  }

  if (tool.requiresConfirmation && deps.confirmed !== true) {
    record(tool.satelliteId, "denied", "needs-confirmation");
    return {
      ok: false,
      reason: "needs-confirmation",
      message: `"${tool.title}" changes data and needs to be confirmed before it runs.`,
    };
  }

  if (tool.kind === "read") {
    const result = await deps.transport.fetchScreen(
      tool.satelliteId,
      tool.targetId,
      checked.value as Record<string, string>,
      principal,
    );
    if (!result.ok) {
      // The reason, never the detail: upstream text may name internal paths,
      // and the proxy already withheld it once.
      record(tool.satelliteId, "error", result.reason);
      return { ok: false, reason: result.reason, message: failureMessage(tool, result) };
    }
    record(tool.satelliteId, "ok");
    return { ok: true, kind: "read", data: extractData(result.value.ui) };
  }

  const result = await deps.transport.invokeAction(
    tool.satelliteId,
    tool.targetId,
    checked.value,
    principal,
  );
  if (!result.ok) {
    record(tool.satelliteId, "error", result.reason);
    return { ok: false, reason: result.reason, message: failureMessage(tool, result) };
  }

  record(tool.satelliteId, "ok");
  const envelope = result.value;
  return {
    ok: true,
    kind: "write",
    outcome: envelope.outcome,
    ...(envelope.toast === undefined ? {} : { message: envelope.toast.message }),
    ...(envelope.fieldErrors === undefined ? {} : { fieldErrors: envelope.fieldErrors }),
  };
}

function failureMessage(tool: ToolDescriptor, failure: Failure): string {
  switch (failure.reason) {
    case "unavailable":
      return `${tool.satelliteId} is not responding; nothing was changed.`;
    case "timeout":
      return `${tool.satelliteId} did not answer in time.`;
    case "not-found":
      return `${tool.satelliteId} has no such record.`;
    case "forbidden":
      return `${tool.satelliteId} declined this request for this account.`;
    case "invalid-response":
      return `${tool.satelliteId} answered in a way the portal cannot use.`;
    case "upstream-error":
      return `${tool.satelliteId} reported an error.`;
  }
}

export type Checked =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Enforces the schema the model was handed.
 *
 * Reads and writes are deliberately asymmetric on *type*, and identical on
 * everything else. A screen param is stringified into a query either way, so
 * `7` and `"7"` are the same request and rejecting the number costs a retry for
 * nothing. A write's types reach the satellite as JSON, where `2` and `"2"` are
 * different values and the schema said which one it wants.
 *
 * Undeclared fields are refused in both. Coercion applies to the type of a
 * declared parameter, never to whether it was declared at all.
 */
export function checkArguments(
  schema: JsonObjectSchema,
  args: Readonly<Record<string, unknown>>,
  kind: "read" | "write",
  /**
   * What the caller thinks it is calling. "Tool" is the agent's word for it; a
   * partner reading the public API has never heard of one, and telling them a
   * query string is not a parameter of "this tool" publishes internal
   * vocabulary in the one place the whole façade exists to keep it out of.
   */
  subject: string = "tool",
): Checked {
  const out: Record<string, unknown> = {};

  // `hasOwn` rather than `in` throughout: both objects are plain, so `in` walks
  // `Object.prototype` and an argument named `constructor` or `toString` would
  // pass the undeclared-field check by matching a method nobody declared.
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) {
      return { ok: false, message: `"${key}" is not a parameter of this ${subject}.` };
    }
  }

  for (const name of schema.required) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      return { ok: false, message: `"${name}" is required.` };
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(args, name)) continue;
    const value = args[name];
    if (value === undefined) continue;

    if (kind === "read") {
      if (typeof value === "object" || typeof value === "function") {
        return { ok: false, message: `"${name}" must be a simple value.` };
      }
      out[name] = String(value);
      continue;
    }

    if (property.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `"${name}" must be a number.` };
      }
    } else if (typeof value !== property.type) {
      return { ok: false, message: `"${name}" must be a ${property.type}.` };
    }

    if (property.enum !== undefined && !property.enum.includes(value as string)) {
      return {
        ok: false,
        message: `"${name}" must be one of: ${property.enum.join(", ")}.`,
      };
    }

    out[name] = value;
  }

  return { ok: true, value: out };
}
