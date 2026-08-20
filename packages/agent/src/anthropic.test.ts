import { describe, expect, it } from "vitest";
import { supportsAdaptiveThinking } from "./anthropic";

/**
 * Which models accept `thinking: { type: "adaptive" }`.
 *
 * Found the hard way: pointing the portal at `claude-haiku-4-5` for a demo made
 * every turn fail with a 502 and one sentence, and the API's actual answer —
 * "adaptive thinking is not supported on this model" — was being swallowed by
 * the route's catch. Adaptive thinking arrived with the 4.6 generation; 4.5 and
 * earlier take a token budget instead, and reject the adaptive form outright.
 *
 * A predicate rather than a list of known-good names, because a list is wrong
 * the day a model ships and nobody notices until a demo.
 */

describe("adaptive thinking", () => {
  it("is used on the models that have it", () => {
    for (const model of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]) {
      expect(supportsAdaptiveThinking(model), model).toBe(true);
    }
  });

  it("is not used on 4.5 and earlier", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet"]) {
      expect(supportsAdaptiveThinking(model), model).toBe(false);
    }
  });

  it("reads the version, not the family", () => {
    // The rule is a generation, so a future haiku gets it and an old opus does
    // not — the opposite of what a list of "good models" would encode.
    expect(supportsAdaptiveThinking("claude-haiku-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-5")).toBe(false);
  });

  it("assumes support for a name it cannot read", () => {
    // The failure is loud and immediate either way — the API says exactly what
    // is wrong. Defaulting to *off* would instead silently drop thinking from a
    // model that wanted it, which is a quality regression nobody would see.
    expect(supportsAdaptiveThinking("some-future-model")).toBe(true);
  });

  it("tolerates a dated alias", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-6-20260101")).toBe(true);
  });

  it("reads the version segment, not any number in the name", () => {
    // A name can carry numbers that are not a version — a gateway prefix, a
    // region, a `-v1` suffix. Reading the first of those as the major version
    // is a confident wrong answer, and wrong in the direction that silently
    // removes thinking from a model that supports it.
    expect(supportsAdaptiveThinking("portal-v2-claude-opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("anthropic.claude-opus-4-6-v1:0")).toBe(true);
    expect(supportsAdaptiveThinking("anthropic.claude-haiku-4-5-v1:0")).toBe(false);
  });
});
