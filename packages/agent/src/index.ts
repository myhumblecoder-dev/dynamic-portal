/**
 * What a model may say about a screen, and how the hub checks it.
 *
 * The agent composes layout; only tools supply facts. That sentence is the
 * whole package, and it is enforced in two places rather than asked for in a
 * prompt: the schema removes the properties that carry data, so a model has
 * nowhere to write a number it made up, and the grounding pass fills those
 * properties in from the tool call each node cites — refusing anything whose
 * citation does not hold up.
 *
 * Everything except `anthropic.ts` is a pure function over a spec, a message
 * list and a set of tool results — which is what makes the integrity claim
 * testable without a network. The vendor sits behind the smallest interface in
 * the repository, because PLAN.md rates the model as the fastest-decaying
 * dependency in the stack.
 */

export {
  AUTHORED_BY_TOOLS,
  MUST_CITE_A_SOURCE,
  RENDER_SCREEN_SCHEMA,
  renderScreenSchema,
} from "./schema";

export { lowerSpec, type LoweringIssue, type LoweringResult } from "./lower";

export {
  groundSpec,
  type GroundingIssue,
  type GroundingResult,
  type ToolCallRecord,
} from "./grounding";

export {
  RENDER_SCREEN_TOOL,
  SYSTEM_PROMPT,
  toolDefinitions,
  type ToolDefinition,
} from "./tools";

export {
  runAgent,
  type AgentOutcome,
  type Citation,
  type ContentBlock,
  type Message,
  type ModelClient,
  type ModelReply,
  type PendingWrite,
  type RunDeps,
  type RunInput,
} from "./loop";

export { conversationBudget, trimConversation } from "./trim";

export { OLLAMA_MODEL, OLLAMA_URL, ollamaClient, type OllamaClientOptions } from "./ollama";

export {
  AGENT_MODEL,
  anthropicClient,
  supportsAdaptiveThinking,
  type AnthropicClientOptions,
} from "./anthropic";
