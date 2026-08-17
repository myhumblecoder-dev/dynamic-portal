import { checkOperationParams, projectOperation, resolveOperation } from "@portal/public-api";
import { findSatellite } from "@portal/registry";
import { MAX_PAYLOAD_BYTES, readBounded, statusFor } from "@/lib/http";
import { publicEntries, publicFailure, publicJson, unresolved } from "@/lib/publicApi";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * One operation, run.
 *
 * No confirmation gate here, and that is not an oversight: a confirmation is a
 * human deciding whether an *agent* should act. A partner calling this endpoint
 * is the human, and their own credentials already authorize it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ service: string; operation: string }> },
): Promise<Response> {
  const { service, operation } = await context.params;

  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  // Counted off the wire as it arrives. Buffering the whole body first and
  // objecting afterwards pays exactly the cost the limit exists to avoid, and a
  // `content-length` check alone does not save it: a chunked request has no such
  // header and a dishonest one can simply understate it.
  const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) return publicJson(publicFailure("payload too large"), 413);

  let body: unknown;
  try {
    body = raw === "" ? {} : JSON.parse(raw);
  } catch {
    return publicJson(publicFailure("body is not valid JSON"), 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return publicJson(publicFailure("body must be a JSON object"), 400);
  }

  const source = await publicEntries(service);
  const resolved = resolveOperation(source.entries, principal, service, operation);
  if (resolved === undefined) return unresolved(source);

  const checked = checkOperationParams(resolved.params, body as Record<string, unknown>);
  if (!checked.ok) return publicJson(publicFailure(checked.message), 400);

  const portal = getPortal();
  const satellite = findSatellite(portal.registry, resolved.satelliteId);
  if (satellite === undefined) return publicJson(publicFailure("not found"), 404);

  const result = await portal
    .clientFor(satellite)
    .invokeAction(resolved.actionId, checked.value, principal);

  // A timed-out write specifically must not be reported as 502: the satellite
  // may well have applied it, and "bad gateway" invites a partner to retry a
  // change that already happened.
  if (!result.ok) return publicJson(publicFailure(result.reason), statusFor(result));

  return publicJson(projectOperation(service, operation, result.value), 200);
}
