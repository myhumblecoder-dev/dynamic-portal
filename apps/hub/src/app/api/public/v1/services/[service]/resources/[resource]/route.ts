import { extractData } from "@portal/mcp-gateway";
import { checkResourceParams, projectResource, resolveResource } from "@portal/public-api";
import { findSatellite } from "@portal/registry";
import { statusFor } from "@/lib/http";
import { publicEntries, publicFailure, publicJson, unresolved } from "@/lib/publicApi";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * One resource, read.
 *
 * A screen underneath, and never visibly so: the response carries records and
 * a summary, not a UI tree. The extraction is the same one the agent path uses,
 * because "the data on this screen, without the layout" has one right answer.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ service: string; resource: string }> },
): Promise<Response> {
  const { service, resource } = await context.params;

  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  const source = await publicEntries(service);
  const resolved = resolveResource(source.entries, principal, service, resource);
  // Unknown and not-yours answer identically: a 403 would confirm that a
  // resource exists, which is the disclosure the whole audience model prevents.
  // An unreachable satellite is the one case that is neither.
  if (resolved === undefined) return unresolved(source);

  const query: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) query[key] = value;

  const checked = checkResourceParams(resolved.params, query);
  if (!checked.ok) return publicJson(publicFailure(checked.message), 400);

  const portal = getPortal();
  const satellite = findSatellite(portal.registry, resolved.satelliteId);
  if (satellite === undefined) return publicJson(publicFailure("not found"), 404);

  const screen = await portal
    .clientFor(satellite)
    .fetchScreen(resolved.screenId, checked.value as Record<string, string>, principal);

  // 503 and 504 are worth retrying and 502 is not; collapsing them would leave a
  // client no way to tell a satellite that is down from one that is broken.
  if (!screen.ok) return publicJson(publicFailure(screen.reason), statusFor(screen));

  return publicJson(
    projectResource(service, resource, screen.value.screen.title, extractData(screen.value.ui)),
    200,
  );
}
