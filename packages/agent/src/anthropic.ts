import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, ModelClient } from "./loop";

/**
 * The SDK, behind the seam.
 *
 * This is the only file in the package that knows a model vendor exists, and
 * the only one that cannot be tested without a network. Everything the loop
 * does — the tool surface, the confirmation gate, grounding — is a pure
 * function above it. That split is deliberate: PLAN.md rates the model as the
 * fastest-decaying dependency in the stack, at six to eighteen months, so it
 * sits behind the smallest interface in the repository.
 */

/**
 * Zero-data-retention eligible, which is why it and not a more capable sibling.
 * PLAN.md treats the model choice as a compliance decision before a capability
 * one, and regulated data reaches this call through tool results.
 */
export const AGENT_MODEL = "claude-opus-5";

/**
 * Whether this model accepts `thinking: { type: "adaptive" }`.
 *
 * Adaptive thinking arrived with the 4.6 generation. Ask a 4.5 model for it and
 * the request is refused outright — `invalid_request_error: adaptive thinking
 * is not supported on this model` — so every turn fails, and the route turns
 * that into one sentence with no clue in it. That is how pointing a demo at
 * `claude-haiku-4-5` cost an afternoon.
 *
 * A version comparison rather than a list of known-good names: a list is wrong
 * the day a model ships, and wrong in the direction where a future Haiku
 * silently loses thinking it supports.
 *
 * The version is a hyphen-delimited segment of one or two short numbers, which
 * covers both spellings the family has used: `claude-opus-4-6` is 4.6 and the
 * older `claude-3-5-sonnet` is 3.5. A run of four or more digits is a date
 * stamp, not a version part, so `claude-opus-4-6-20260101` is still 4.6.
 *
 * Delimited rather than "the first digits anywhere", because a name can carry
 * numbers that are not a version — a gateway prefix, a region, a `-v1` suffix —
 * and reading those as one produces a confident wrong answer rather than no
 * answer, which is the case the default below is supposed to catch.
 *
 * A name this cannot parse is assumed to support it. Both defaults are wrong
 * sometimes; this one fails loudly and immediately with the API saying exactly
 * why, and the other quietly removes thinking from a model that wanted it.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  const version = /(?:^|-)(\d{1,3})(?:-(\d{1,3}))?(?=-|$)/.exec(model);
  if (version === null) return true;

  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);

  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Enough for a screen of any size this catalog can express, and not so much
 * that a runaway generation is expensive before `maxTurns` notices.
 */
const MAX_TOKENS = 8192;

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly model?: string;
}

export function anthropicClient(options: AnthropicClientOptions): ModelClient {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? AGENT_MODEL;

  return {
    async respond({ system, messages, tools }) {
      const message = await client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        // Adaptive rather than a token budget: `budget_tokens` is rejected
        // outright on this model generation, and the work here varies from
        // "answer from one lookup" to "compose a cross-satellite screen".
        //
        // Omitted entirely on models that predate it, which refuse the request
        // rather than ignoring the field. A deployment running a 4.5 model gets
        // a working assistant without thinking, not a broken one with it.
        ...(supportsAdaptiveThinking(model) ? { thinking: { type: "adaptive" as const } } : {}),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Beta.BetaTool["input_schema"],
        })),
        messages: messages.map(toSdkMessage),
      });

      // Said out loud, because this is the metered path and nothing else
      // reported what a turn cost. "Every turn is billed" was a claim in a
      // startup line with no number behind it, so the only way to find out
      // which question was expensive was the invoice. Before the checks below,
      // so a turn that ends badly is still counted — those are the expensive
      // ones.
      const used = message.usage;
      console.log(
        `agent turn: ${model} in=${used.input_tokens} out=${used.output_tokens}` +
          (used.cache_read_input_tokens ? ` cached=${used.cache_read_input_tokens}` : ""),
      );

      // Two stop reasons produce content the loop cannot use, and both look
      // like an ordinary success to a caller that only reads `content`.
      //
      // A refusal arrives as HTTP 200 with the content empty, so the loop would
      // see no tool call, take the empty text for an answer, and the user would
      // get a blank reply. Truncation is worse: a `tool_use` cut off mid-input
      // is a tool call with half its arguments, which the loop would go on to
      // make. Both are raised so the route can say something true instead.
      if (message.stop_reason === "refusal") {
        throw new Error("The model declined to answer this request.");
      }
      if (message.stop_reason === "max_tokens") {
        throw new Error("The model's reply did not fit within the token budget.");
      }

      return { content: message.content.map(fromSdkBlock) };
    },
  };
}

function toSdkMessage(message: Message): Anthropic.Beta.BetaMessageParam {
  return {
    role: message.role,
    content: message.content.map(toSdkBlock) as Anthropic.Beta.BetaMessageParam["content"],
  };
}

function toSdkBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    case "opaque":
      // Straight back out the way it came in. A thinking block carries a
      // signature that only verifies if the block is byte-identical, so
      // anything this file does not understand it must not touch.
      return block.raw;
  }
}

function fromSdkBlock(block: Anthropic.Beta.BetaContentBlock): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: (block.input ?? {}) as Record<string, unknown>,
    };
  }
  return { type: "opaque", raw: block };
}
