import { flatToKeyed, keyedToNested } from "@portal/catalog";
import { conversationBudget, runAgent, trimConversation, type Message } from "@portal/agent";
import { signConversation, verifyConversation } from "@portal/identity";
import { visibleSatellites } from "@portal/registry";
import type { AgentApiResult } from "@/lib/agentApi";
import {
  agentInvoker,
  buildAgentSurface,
  isAgentEnabled,
  maxTurns,
  modelClient,
} from "@/lib/agent";
import { auditConfig } from "@/lib/audit";
import { MAX_PAYLOAD_BYTES, readBounded } from "@/lib/http";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * One turn of the agent.
 *
 * Stateless, deliberately. The conversation arrives with the request and leaves
 * with the response, so a confirmation that a user takes ten minutes over
 * survives a container restart, and two hub replicas need share nothing.
 *
 * A screen is returned already lowered into the nested tree the renderer takes,
 * so the browser receives exactly the shape a satellite would have sent. The
 * agent path and the deterministic path meet here and are indistinguishable
 * downstream, which is what makes the renderer worth having had first.
 */

/** Drops a trailing assistant turn that still has tool calls nobody answered. */
function dropTrailingUnanswered(messages: readonly Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [...messages];
  return last.content.some((block) => block.type === "tool_use")
    ? messages.slice(0, -1)
    : [...messages];
}

function json(result: AgentApiResult, status: number): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return json({ ok: false, message: "You are not signed in." }, 401);
  }

  if (!isAgentEnabled(principal)) {
    // Not an error. Running without an agent is a supported way to run this
    // portal, and a tenant may have declined AI processing entirely.
    return json({ ok: false, message: "The assistant is not enabled for this account." }, 404);
  }

  /**
   * Counted before it is buffered, like every other route that takes a body.
   *
   * This one was the exception, and the conversation is the worst place to have
   * made it: the history arrives as client input on every turn, and the
   * signature that decides whether to trust it can only be checked *after* the
   * parse. So the cost of an arbitrarily large body was paid before the hub had
   * any reason to believe the body was its own.
   *
   * The same 256 KB every other route uses. Reusing the constant beats a second
   * number that would drift from it — but note what the cap applies to. Every
   * other route bounds a single submission. This one bounds a conversation,
   * which accumulates: a turn measures around 5 KB against a live stack, so the
   * ceiling is not "forty times the real thing" but roughly forty turns of it,
   * and fewer when a tool returns a few hundred rows.
   *
   * That is why the trim below exists. A cap on something that only grows is a
   * cliff unless something keeps the growth inside it, and raising the number
   * would only move the cliff further out.
   */
  const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) {
    return json(
      {
        ok: false,
        message: "This conversation has grown too large to continue. Start a new one.",
      },
      413,
    );
  }

  let parsed: unknown;
  try {
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  /**
   * An object, specifically — the same guard the action route and the public
   * façade apply after their own `readBounded`.
   *
   * `JSON.parse("null")` is a *successful* parse that yields `null`, so the
   * catch above never sees it and `body.history` throws a line later where
   * nothing catches. An uncaught throw here is a 500 whose body is not the JSON
   * envelope every caller parses, so the browser reports "could not reach the
   * assistant" for a request the hub understood perfectly well and should
   * simply have refused.
   */
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }
  const body = parsed as {
    history?: unknown;
    signature?: unknown;
    ask?: unknown;
    approvals?: unknown;
    declinePending?: unknown;
  };

  let rootKey: string;
  try {
    rootKey = auditConfig().rootKey;
  } catch {
    // A missing root secret is a misconfigured stack, not a bad request. It has
    // to be caught here rather than left to escape the handler: an uncaught
    // throw is a 500 whose body is not the JSON envelope every caller parses,
    // so the browser reports "could not reach the assistant" for a server that
    // answered perfectly well.
    return json({ ok: false, message: "The assistant could not complete that request." }, 502);
  }

  /**
   * Signing and verifying both live in `@portal/identity`, which is where the
   * key derivation and the sealed shape can be held together and tested. The
   * shape matters as much as the key: derived per tenant, a signature over the
   * messages alone verifies for every colleague in that tenant.
   */
  const sign = (messages: readonly Message[]) => signConversation(principal, messages, rootKey);

  /**
   * Trimmed before it is signed, so the hub never issues a conversation it will
   * refuse.
   *
   * The history only ever grows and the body it returns in is capped, which
   * without this leaves the hub handing out a signed conversation and rejecting
   * that same conversation on the next turn — a session wiped mid-sentence for
   * a user who did nothing wrong. Raising the cap would only move the cliff;
   * the fix is to stop walking off it. The signature covers what actually left,
   * so a trimmed history verifies exactly as an untrimmed one does.
   */
  const issue = (messages: readonly Message[]) => {
    const kept = trimConversation(messages, conversationBudget(MAX_PAYLOAD_BYTES));
    return { messages: kept, signature: sign(kept) };
  };

  /**
   * The conversation is the hub's state, and between turns it lives in the
   * browser. Everything grounding believes about what a tool returned is
   * rebuilt from these blocks, so an unsigned history let a client fabricate a
   * `tool_result` and receive a screen of invented figures wearing a provenance
   * citation.
   *
   * `history` and `ask` are separate fields rather than one array on purpose.
   * The hub signs what it issued; the user then adds to it. Folding the new
   * message into the same array would mean verifying a signature over something
   * the hub never signed, which cannot work — a mistake worth naming because
   * the first version of this did exactly that and would have rejected every
   * second turn.
   */
  const history = Array.isArray(body.history) ? (body.history as Message[]) : [];
  const ask = typeof body.ask === "string" ? body.ask.trim() : "";

  if (history.length > 0) {
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!verifyConversation(principal, history, signature, rootKey)) {
      return json(
        {
          ok: false,
          message:
            "This conversation could not be verified and has been discarded. Start a new one.",
        },
        400,
      );
    }
  } else if (ask === "") {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  const approvals = Array.isArray(body.approvals)
    ? body.approvals.filter((id): id is string => typeof id === "string")
    : [];

  /**
   * Declining a pending write by asking something else.
   *
   * A paused write leaves its `tool_use` unanswered, which is what lets the user
   * approve it later. Asking something new instead has to remove it, or the API
   * rejects the conversation before the model sees the question. The *hub* does
   * the removing: the signature covers what the hub issued, so a history the
   * client had already shortened would no longer verify.
   */
  const base = body.declinePending === true ? dropTrailingUnanswered(history) : history;
  const messages: Message[] =
    ask === "" ? base : [...base, { role: "user", content: [{ type: "text", text: ask }] }];

  if (messages.length === 0) {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  // Declared outside the try so the catch can flush the audit writes a failed
  // turn had already started.
  let invoker: ReturnType<typeof agentInvoker> | undefined;

  try {
    const surface = await buildAgentSurface(principal);
    invoker = agentInvoker(principal, surface);

    const turns = maxTurns();
    const outcome = await runAgent(
      { messages, surface, approvals },
      {
        client: modelClient(),
        invoke: invoker.invoke,
        // Omitted when unset, so the loop keeps its own default rather than
        // being handed `undefined` as a number.
        ...(turns === undefined ? {} : { maxTurns: turns }),
      },
    );

    // Every tool call this turn made is on disk before the answer goes out.
    await invoker.flush();

    if (outcome.kind === "screen") {
      const allowed = visibleSatellites(getPortal().registry, principal).map((s) => s.id);
      return json(
        {
          ok: true,
          kind: "screen",
          ui: keyedToNested(flatToKeyed(outcome.spec)),
          citations: outcome.citations,
          allowedSatelliteIds: allowed,
          ...issue(outcome.messages),
        },
        200,
      );
    }

    if (outcome.kind === "confirm") {
      return json(
        {
          ok: true,
          kind: "confirm",
          pending: outcome.pending,
          ...issue(outcome.messages),
        },
        200,
      );
    }

    if (outcome.kind === "answer") {
      return json(
        {
          ok: true,
          kind: "answer",
          text: outcome.text,
          ...issue(outcome.messages),
        },
        200,
      );
    }

    return json({ ok: false, message: outcome.reason }, 200);
  } catch (error) {
    // The turn failed part way through, and the tool calls it did make before
    // failing still happened. Their records are awaited here too — a turn that
    // ended badly is exactly the one an audit is read for — and a write that
    // fails now cannot change an answer that is already a refusal.
    await invoker?.flush().catch(() => {});

    // Logged where an operator can read it, which is not the same as told to
    // the caller. Until this line, an unexpected failure left no trace
    // anywhere: the audit records the calls the turn made, never why it died,
    // and the response is deliberately one sentence. Diagnosing a 502 meant
    // reproducing it with a debugger attached.
    console.error("agent turn failed:", error);

    // The model call failed, or a satellite threw where the gateway does not
    // catch. Either way the user gets a sentence, not a stack — the same rule
    // the proxy follows about upstream detail.
    return json({ ok: false, message: "The assistant could not complete that request." }, 502);
  }
}
