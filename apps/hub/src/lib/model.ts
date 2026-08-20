/**
 * Which model answers, whether anything answers at all, and how to say so.
 *
 * Split from `agent.ts` for a reason the build measures rather than a
 * preference. `instrumentation.ts` is compiled for the edge runtime as well as
 * for node — Next emits an "Edge Instrumentation" entry unconditionally — so
 * importing this from there once dragged `agent.ts`, and through it
 * `node:crypto`, `node:fs`, `node:path` and the Anthropic SDK, into a bundle
 * that has none of them: ten "not supported in the Edge Runtime" errors added
 * to a build that had zero. The `NEXT_RUNTIME` guard inside `register` cannot
 * help, because modules are evaluated before it runs, and a dynamic
 * `await import()` does not help either, because the tracer follows it too.
 *
 * So everything here reads `process.env` and nothing else. The clients that
 * need a filesystem, a socket or a vendor SDK stay in `agent.ts`, which
 * re-exports this so no caller has to know where the line falls.
 *
 * **Strictly additive, and off unless switched on.** PLAN.md makes this a
 * property rather than a preference: the deterministic portal has to work with
 * the agent disabled, per tenant as well as globally, which is at once an
 * availability property, a compliance control and a cost control. So the
 * default is off, a missing key is off, and a tenant on the disabled list is
 * off — and none of those paths touch anything the screens use.
 */

import { AGENT_MODEL, OLLAMA_MODEL, OLLAMA_URL } from "@portal/agent";
import type { Principal } from "@portal/identity";

/** Tenants that have not agreed to AI processing, or have withdrawn it. */
function disabledTenants(): ReadonlySet<string> {
  return new Set(
    (process.env["PORTAL_AGENT_DISABLED_TENANTS"] ?? "")
      .split(",")
      .map((tenant) => tenant.trim())
      .filter((tenant) => tenant !== ""),
  );
}

/**
 * Whether this tenant has agreed to be served by an agent at all.
 *
 * Split from `isAgentEnabled` because the two questions had been one, and the
 * combined answer was wrong for the outward MCP endpoint. That endpoint needs
 * no `ANTHROPIC_API_KEY` — the model belongs to whoever is connecting — so
 * asking "is *our* agent configured" would have left it open to a tenant that
 * had withdrawn consent, which is the control's whole purpose. It is an
 * agent-facing surface either way, and consent governs the surface rather than
 * whose model reaches it.
 */
export function isAgentAllowedForTenant(principal: Principal): boolean {
  if (process.env["PORTAL_AGENT"] === "off") return false;
  return !disabledTenants().has(principal.tenantId);
}

/**
 * Whether *a* model is configured for the hub's own assistant.
 *
 * "Configured" is not "keyed". `PORTAL_MODEL_PROVIDER=ollama` needs no key of
 * ours — the model is on this machine — and asking only about
 * `ANTHROPIC_API_KEY` would have answered 404 "the assistant is not enabled"
 * to the very setup the local provider exists to make cheap. This has to agree
 * with `modelClient()` below: the two are the same question asked once for the
 * gate and once for the client, and a disagreement is either a dead assistant
 * or a throw inside the turn.
 */
function isModelConfigured(): boolean {
  if (isLocalProvider()) return true;
  // A key that is not there is not a misconfiguration to warn about — running
  // without an agent is a supported way to run this portal.
  return Boolean(process.env["ANTHROPIC_API_KEY"]);
}

export function isAgentEnabled(principal?: Principal): boolean {
  if (!isModelConfigured()) return false;
  if (principal !== undefined) return isAgentAllowedForTenant(principal);
  return process.env["PORTAL_AGENT"] !== "off";
}

/**
 * Which model answers, and why the default is the paid one.
 *
 * `PORTAL_MODEL_PROVIDER=ollama` points the agent at a model on this machine.
 * That exists because testing the assistant against a metered API turned a
 * regression suite into a bill, which is a poor incentive to test the agent at
 * all.
 *
 * The default stays Anthropic deliberately. PLAN.md picks `claude-opus-5`
 * because it is zero-data-retention eligible and regulated data reaches the
 * model through tool results — a compliance decision before a capability one.
 * A local model answers that question differently and nobody has reviewed it,
 * so it turns on by choice and never by omission.
 */
/**
 * Trimmed, because this arrives from a `.env` file compose reads verbatim and
 * `PORTAL_MODEL_PROVIDER=ollama ` with a trailing space is not a typo anyone
 * can see.
 */
function provider(): string {
  return (process.env["PORTAL_MODEL_PROVIDER"] ?? "").trim();
}

function isLocalProvider(): boolean {
  return provider() === "ollama";
}

/**
 * What the agent will actually talk to, and where.
 *
 * A union rather than one shape with an optional `baseUrl`, because the local
 * provider always has an address and the hosted one has no address to give.
 * Written as an optional field it typechecked only with a `!` at the single
 * place it is read — an assertion that the compiler would have had to be told
 * to trust exactly where it could have proved it instead.
 */
export type ResolvedModel =
  | { readonly provider: "anthropic"; readonly model: string }
  | { readonly provider: "ollama"; readonly model: string; readonly baseUrl: string };

/**
 * Empty is absent.
 *
 * Compose writes `VAR: ${VAR:-}` for every optional setting, so an unset
 * variable arrives as `""` rather than `undefined`, and `??` only catches
 * null. That once sent `model: ""` to Ollama, which rejected it in three
 * milliseconds while the hub reported only that the assistant "could not
 * complete that request".
 */
const set = (name: string): string | undefined => {
  // Trimmed, like the provider name above it. `PORTAL_ANTHROPIC_MODEL=` in a
  // compose file is how a passthrough looks when the host has not set it, and
  // some shells hand that through as whitespace rather than as empty — which
  // would otherwise reach the API as a model name of spaces and come back a
  // 404 nobody could read. A model name or a URL never means to carry padding.
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Resolves the model once, so nothing has to guess which one is answering.
 *
 * This exists because the answer was not obvious from the outside and I got it
 * wrong twice: the provider is chosen per `docker compose` invocation, an
 * omitted variable falls back to the paid API, and nothing said so. A hub that
 * silently bills is a hub whose configuration you learn from an invoice.
 *
 * `modelClient()` builds from this rather than reading the environment again,
 * which is the only arrangement where a startup log cannot drift from what
 * actually runs.
 */
export function resolveModel(): ResolvedModel {
  const chosen = provider();

  // A value nobody recognises used to fall through to the paid client, which
  // is the worst available answer: `PORTAL_MODEL_PROVIDER=ollma` asked for a
  // free model and quietly got a metered one, and the only evidence was the
  // invoice. This whole feature exists to stop testing costing money, so a
  // misspelling of it has to fail rather than bill.
  if (chosen !== "" && chosen !== "ollama" && chosen !== "anthropic") {
    throw new Error(
      `PORTAL_MODEL_PROVIDER="${chosen}" is not a provider. Use "ollama", or leave it unset for Anthropic.`,
    );
  }

  if (isLocalProvider()) {
    return {
      provider: "ollama",
      model: set("PORTAL_OLLAMA_MODEL") ?? OLLAMA_MODEL,
      baseUrl: set("PORTAL_OLLAMA_URL") ?? OLLAMA_URL,
    };
  }

  // Overridable for the same reason the local model is: which model a
  // deployment runs is a cost decision, and the gap between `claude-opus-5` and
  // `claude-haiku-4-5` is a factor of five on input and output both. Editing a
  // constant in `packages/agent` and rebuilding is not how that should be
  // spelled. `set` trims and treats blank as unset, so an unset passthrough in
  // a compose file resolves to the default rather than to "".
  return { provider: "anthropic", model: set("PORTAL_ANTHROPIC_MODEL") ?? AGENT_MODEL };
}

/**
 * A base URL with any credentials taken out of it.
 *
 * `PORTAL_OLLAMA_URL` is ordinarily a bare host and carries nothing secret,
 * but it is a URL a person writes, and `http://user:token@gpu-box:11434` is
 * how someone reaches a shared machine through a proxy. A startup line is
 * copied into issues and CI output, so it prints no part of a URL that a
 * reader would recognise as a password.
 */
function withoutCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. `ollamaClient` will fail on it and say so; printing it
    // verbatim is what shows the typo, and a string this malformed has no
    // userinfo for `URL` to have found.
    return url;
  }

  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * One line, at startup, saying what will answer and what it costs.
 *
 * It reports the gate rather than the configuration, which are not the same
 * question. `PORTAL_MODEL_PROVIDER` unset with no `ANTHROPIC_API_KEY` resolves
 * to the hosted model and serves nothing at all — `isAgentEnabled()` is false
 * and the route answers 404 — and that is the *default* compose stack, since
 * `docker-compose.yml` passes `${ANTHROPIC_API_KEY:-}` through. Describing the
 * resolution alone would have printed "every turn is billed" on the one
 * configuration that bills nothing and has no assistant, which is worse than
 * printing nothing: a line that answers the question wrongly stops it being
 * asked.
 *
 * So the off-states are asked of the same predicates the route is gated on,
 * and the model sentence is reached only when there is a model to reach.
 */
export function describeModel(): string {
  // Asked before resolving: the kill switch means no model is consulted, so a
  // misspelt provider alongside it is not an error worth reporting here.
  if (process.env["PORTAL_AGENT"] === "off") return "assistant: off (PORTAL_AGENT=off)";

  const resolved = resolveModel();

  // The only way this is false past the switch above: the hosted provider with
  // no key. `isModelConfigured()` is unconditionally true for the local one.
  if (!isAgentEnabled()) {
    return "assistant: off (no ANTHROPIC_API_KEY — set one, or PORTAL_MODEL_PROVIDER=ollama for a local model)";
  }

  const line =
    resolved.provider === "ollama"
      ? `assistant: ${resolved.model} on ${withoutCredentials(resolved.baseUrl)} (local, no API cost)`
      : `assistant: ${resolved.model} via the Anthropic API (metered — every turn is billed)`;

  // Counted, never named. The consent list is tenant identifiers, and a
  // startup log is the wrong place to publish who a customer is; the fact that
  // the line does not describe every tenant is what a reader needs.
  const optedOut = disabledTenants().size;
  if (optedOut === 0) return line;
  return `${line}; off for ${optedOut} tenant${optedOut === 1 ? "" : "s"} (PORTAL_AGENT_DISABLED_TENANTS)`;
}

/**
 * How many turns one question may take.
 *
 * The cap exists so a model that will not stop is a bill rather than a bug
 * report, and 8 was tuned against `claude-opus-5`. It is not a constant of
 * nature: composing the home screen means reading three satellites and then
 * calling `render_screen`, and a smaller model that calls one tool per turn —
 * or needs a second attempt after grounding refuses a figure — runs out doing
 * exactly the right thing. Measured on `claude-haiku-4-5`, that beat succeeded
 * roughly one run in four, always with "did not reach an answer within the
 * turns allowed" after ten seconds.
 *
 * So it moves with the model, in config, next to the model. Unset keeps the
 * default; a value that is not a positive whole number is ignored rather than
 * obeyed, because a cap of `NaN` is no cap at all.
 */
export function maxTurns(): number | undefined {
  const raw = set("PORTAL_AGENT_MAX_TURNS");
  if (raw === undefined) return undefined;

  const turns = Number(raw);
  return Number.isInteger(turns) && turns > 0 ? turns : undefined;
}