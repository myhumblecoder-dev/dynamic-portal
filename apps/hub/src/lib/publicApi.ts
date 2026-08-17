import type { CatalogEntry } from "@portal/public-api";
import type { Failure } from "@portal/registry";
import { statusFor } from "./http";
import { getPortal } from "./portal";

export interface PublicSource {
  readonly entries: readonly CatalogEntry[];
  /**
   * The satellites that did not answer.
   *
   * A satellite that failed contributes nothing to the projection, which is
   * indistinguishable from a satellite that published nothing. The façade has to
   * be able to tell those apart, or an outage answers "no such resource" — a
   * permanent-sounding answer to a temporary problem, and one a partner may act
   * on by deleting the integration.
   */
  readonly unreachable: readonly Failure[];
}

/**
 * The satellite/manifest pairs the public façade projects from.
 *
 * Every satellite the projection could name is offered to it, not only the ones
 * already marked external — the entitlement filtering belongs in one place, and
 * that place is `@portal/public-api`, which is also where it is tested. A second
 * filter here would be a second chance to get the rule wrong, on the surface
 * where getting it wrong is a disclosure.
 *
 * `service` narrows by *routing*, never by entitlement: a request for
 * `order-management` cannot be answered by any other satellite's manifest, so
 * fetching the rest costs a round trip per satellite and couples the latency of
 * every public request to the slowest thing in the registry. Whether the
 * principal may see what it names is still decided downstream, so the answer is
 * identical either way.
 */
export async function publicEntries(service?: string): Promise<PublicSource> {
  const portal = getPortal();

  const candidates = portal.registry.filter(
    (satellite) => service === undefined || satellite.public?.service === service,
  );

  const results = await Promise.all(
    candidates.map(async (satellite) => {
      const manifest = await portal.clientFor(satellite).fetchManifest();
      return manifest.ok ? ({ satellite, manifest: manifest.value } as CatalogEntry) : manifest;
    }),
  );

  return {
    entries: results.filter((result): result is CatalogEntry => !("ok" in result)),
    unreachable: results.filter((result): result is Failure => "ok" in result),
  };
}

/** Hub-authored copy. A partner never sees a satellite's own error text. */
export function publicFailure(reason: string): { readonly error: string } {
  return { error: reason };
}

export function publicJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Tenant-scoped, and an operation's outcome is never cacheable.
      "cache-control": "no-store",
    },
  });
}

/**
 * The answer when a public name resolved to nothing.
 *
 * Unknown and not-yours are deliberately the same 404: a 403 would confirm that
 * a resource exists, which is the disclosure the whole audience model prevents.
 * "The satellite behind it did not answer" is a third case, and reporting it as
 * 404 tells a partner their integration is wrong when it is not. Because the
 * source was already narrowed to the requested service, an unreachable entry
 * here is that service and no other — and the body still names nothing.
 */
export function unresolved(source: PublicSource): Response {
  const [failure] = source.unreachable;
  return failure === undefined
    ? publicJson(publicFailure("not found"), 404)
    : publicJson(publicFailure("temporarily unavailable"), statusFor(failure));
}
