import { buildCatalog } from "@portal/public-api";
import { publicEntries, publicFailure, publicJson } from "@/lib/publicApi";
import { currentPrincipal } from "@/lib/session";

/**
 * The catalog, as a partner sees it.
 *
 * Everything here is a public name. If an internal id ever appears in this
 * response, the decoupling has failed and a satellite team can no longer rename
 * a screen without breaking someone outside the organization.
 *
 * A listing is best-effort: a satellite that is not answering right now is
 * omitted rather than failing the whole catalog, because one solution being
 * down should not take every other solution's listing with it. The item routes
 * are the ones that distinguish "not published" from "not answering", since
 * that is where the distinction changes what a client does next.
 */
export async function GET(): Promise<Response> {
  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  const source = await publicEntries();
  return publicJson(buildCatalog(source.entries, principal), 200);
}
