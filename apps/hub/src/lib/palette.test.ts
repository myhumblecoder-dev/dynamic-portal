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

const tokensIn = (block: string): Set<string> => new Set(block.match(/--[a-z0-9-]+/g) ?? []);

const blockFor = (pattern: RegExp): string => {
  const match = css.match(pattern);
  expect(match, `no block matched ${pattern}`).not.toBeNull();
  return match![1]!;
};

/** Layout and typography are shared; only colour is a brand's business. */
const COLOURS = [...tokensIn(blockFor(/^:root \{([\s\S]*?)\n\}/m))].filter(
  (token) => !/^--(radius|gap|font|nav)/.test(token),
);

describe("a brand's palette", () => {
  it("has colours to cover in the first place", () => {
    // Guards the guard: a regex that stopped matching would otherwise make
    // every assertion below vacuously true.
    expect(COLOURS.length).toBeGreaterThan(10);
    expect(COLOURS).toContain("--chart-1");
    expect(COLOURS).toContain("--accent");
  });

  for (const brand of BRANDS) {
    it(`${brand} redefines every colour in light`, () => {
      const defined = tokensIn(blockFor(new RegExp(`^:root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n\\}`, "m")));
      expect([...COLOURS].filter((token) => !defined.has(token))).toEqual([]);
    });

    it(`${brand} redefines every colour in dark`, () => {
      // Indented, because it lives inside the `prefers-color-scheme` block.
      const defined = tokensIn(blockFor(new RegExp(`^  :root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n  \\}`, "m")));
      expect([...COLOURS].filter((token) => !defined.has(token))).toEqual([]);
    });

    it(`${brand} does not reuse its accent as the danger tone`, () => {
      // A destructive control and a primary one must not be the same colour,
      // whatever a brand does on its marketing site.
      const light = blockFor(new RegExp(`^:root\\[data-brand="${brand}"\\] \\{([\\s\\S]*?)\\n\\}`, "m"));
      const value = (token: string) => light.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();
      expect(value("--accent")).not.toBe(value("--tone-danger"));
    });
  }
});
