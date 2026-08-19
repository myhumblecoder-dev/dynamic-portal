import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRANDS } from "./brand";

/**
 * Every brand redefines every colour, in both schemes.
 *
 * Not tidiness. `[data-brand]` outscores the bare `:root` the dark block uses,
 * so a token a brand sets wins in dark mode and a token it omits does not —
 * which once put a dark scheme's pastel chart series onto a near-white card.
 * That was found by reading the CSS; this is the check that finds the next one.
 */

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/**
 * Declarations only. The bare `/--[a-z0-9-]+/` this started as also matched a
 * `var(--x)` reference and any token named in a comment — and the comments in
 * this stylesheet do name tokens — so a block could claim to define a colour it
 * merely mentions. Comments are stripped first, then a token counts only where
 * a value follows it.
 */
const tokensIn = (block: string): Set<string> =>
  new Set(block.replace(/\/\*[\s\S]*?\*\//g, "").match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);

const blockFor = (pattern: RegExp): string => {
  const match = css.match(pattern);
  expect(match, `no block matched ${pattern}`).not.toBeNull();
  return match![1]!;
};

/** Layout and typography are shared; only colour is a brand's business. */
const COLOURS = [...tokensIn(blockFor(/^:root \{([\s\S]*?)\n\}/m))].filter(
  (token) => !/^--(radius|gap|font|nav)/.test(token),
);

const missingFrom = (block: string): string[] => {
  const defined = tokensIn(block);
  return COLOURS.filter((token) => !defined.has(token));
};

const lightBlock = (brand: string) =>
  blockFor(new RegExp(`^:root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n\\}`, "m"));

/** Indented, because it lives inside the `prefers-color-scheme` block. */
const darkBlock = (brand: string) =>
  blockFor(new RegExp(`^  :root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n  \\}`, "m"));

const valueIn = (block: string, token: string) =>
  block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();

describe("a brand's palette", () => {
  it("has colours to cover in the first place", () => {
    // Guards the guard: a regex that stopped matching would otherwise make
    // every assertion below vacuously true.
    expect(COLOURS.length).toBeGreaterThan(10);
    expect(COLOURS).toContain("--chart-1");
    expect(COLOURS).toContain("--accent");
  });

  // The default palette is subject to the same rule and was the one breaking
  // it: the dark block below `:root` inherits from the light block above it,
  // so a colour it omits keeps its daylight value rather than falling back to
  // anything sensible. This is the block a brand's dark scheme has to outscore,
  // which makes it the worst one to leave incomplete.
  it("the default redefines every colour in dark", () => {
    expect(missingFrom(blockFor(/^  :root \{([\s\S]*?)\n  \}/m))).toEqual([]);
  });

  for (const brand of BRANDS) {
    it(`${brand} redefines every colour in light`, () => {
      expect(missingFrom(lightBlock(brand))).toEqual([]);
    });

    it(`${brand} redefines every colour in dark`, () => {
      expect(missingFrom(darkBlock(brand))).toEqual([]);
    });

    // A destructive control and a primary one must not be the same colour,
    // whatever a brand does on its marketing site. Both schemes: a brand whose
    // accent and danger are distinct in daylight can still collapse them when
    // both are lifted for dark.
    for (const [scheme, block] of [
      ["light", lightBlock],
      ["dark", darkBlock],
    ] as const) {
      it(`${brand} does not reuse its accent as the danger tone in ${scheme}`, () => {
        const scoped = block(brand);
        expect(valueIn(scoped, "--accent")).not.toBe(valueIn(scoped, "--tone-danger"));
      });
    }
  }
});
