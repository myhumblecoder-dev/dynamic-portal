/**
 * Which palette the portal wears.
 *
 * A re-create rather than a rebuild: every brand ships in `globals.css` and
 * this only picks one, so rebranding recompiles nothing and no satellite is
 * redeployed or even told. That last clause is the claim the styling bargain
 * rests on, which is why it is worth a module of its own rather than a closure
 * in the layout — a claim nothing can call is a claim nothing can check.
 *
 * "Re-create", not "restart", and the difference is not pedantry: a container's
 * environment is fixed when it is created, so `docker compose restart hub`
 * re-runs the same process with the old value and the rebrand does not happen.
 * `docker compose up -d hub` is the one that applies it. Written down because
 * `restart` is the natural thing to type and its failure mode is silence.
 */

/**
 * The palettes `globals.css` actually defines, which is the list this file has
 * to agree with. A name here with no `:root[data-brand="…"]` rule beside it —
 * or the reverse — is a brand that resolves to the default while claiming to be
 * something, and a stylesheet cannot be asked at runtime which names it knows.
 */
export const BRANDS = ["contoso", "partner"] as const;

/**
 * Resolves `PORTAL_BRAND`, or throws.
 *
 * Absent means the default, because a portal with no brand configured should
 * look like the portal rather than fail to render.
 *
 * **A name nobody recognises throws.** CSS has no `@else`: an unmatched
 * `data-brand` selects nothing, so the page renders in the default palette,
 * looks entirely correct and is entirely wrong. `PORTAL_BRAND=Contoso` with a
 * capital C is enough — selector attribute values are case-sensitive in HTML —
 * and the only symptom is a rebrand that did not happen, discovered by whoever
 * is presenting. Matching is exact rather than case-folded on purpose: quietly
 * accepting `Contoso` would make the attribute in the DOM disagree with the
 * value the operator set, and the next person to grep for one would not find
 * the other.
 *
 * This is the same call `modelClient()` makes about `PORTAL_MODEL_PROVIDER=ollma`,
 * for the same reason: a setting that silently does nothing is worse than one
 * that refuses.
 */
export function resolveBrand(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const brand = (env["PORTAL_BRAND"] ?? "").trim();
  if (brand === "") return undefined;
  if (!(BRANDS as readonly string[]).includes(brand)) {
    throw new Error(
      `PORTAL_BRAND="${brand}" is not a brand. Use ${BRANDS.map((name) => `"${name}"`).join(", ")}, or leave it unset for the default palette.`,
    );
  }
  return brand;
}

/**
 * What the layout spreads onto `<html>`.
 *
 * An object rather than a string, so the absent case is an attribute that is
 * not there at all rather than `data-brand=""` — which is a value CSS can match
 * on, and would be one more way to select nothing.
 */
export function brandAttributes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const brand = resolveBrand(env);
  return brand === undefined ? {} : { "data-brand": brand };
}
