import { authorize, type Principal } from "@portal/identity";
import type { ActionDescriptor, Manifest, ScreenDescriptor } from "@portal/protocol";
import type { Satellite } from "@portal/registry";

/**
 * The brokered external surface.
 *
 * PUP and the component catalog are internal contracts. Everything an external
 * client touches passes through this file first, and that indirection is the
 * point: the internal vocabulary stays evolvable by fiat precisely because no
 * partner depends on it. Publishing PUP would freeze it permanently, which
 * PLAN.md names as the mistake to avoid.
 *
 * So nothing here is a screen. A screen becomes a *resource* with a public name
 * the registry assigns, and an action becomes an *operation* — and a satellite
 * team renaming `orders.list` changes one line of registry rather than breaking
 * every client.
 *
 * **Two parties have to agree before anything is visible.** The registry names
 * it publicly, and the satellite's own manifest marks it external. Either alone
 * is not enough, which is the default-deny rule applied at the outermost edge
 * where getting it wrong is a disclosure rather than an inconvenience.
 */

/**
 * Versioned apart from `CURRENT_PROTOCOL_VERSION` and `CATALOG_VERSION`, on
 * purpose and permanently. This one carries a contractual obligation to people
 * outside the organization; those two are ours to change on a Tuesday.
 */
export const PUBLIC_API_VERSION = "1";

export interface PublicResourceParam {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface PublicOperationParam {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
}

export interface PublicResource {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly params: readonly PublicResourceParam[];
}

export interface PublicOperation {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly params: readonly PublicOperationParam[];
}

export interface PublicService {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly resources: readonly PublicResource[];
  readonly operations: readonly PublicOperation[];
}

export interface PublicCatalog {
  readonly version: string;
  readonly services: readonly PublicService[];
}

export interface CatalogEntry {
  readonly satellite: Satellite;
  readonly manifest: Manifest;
}

export function buildCatalog(
  entries: readonly CatalogEntry[],
  principal: Principal,
): PublicCatalog {
  const services: PublicService[] = [];

  for (const entry of entries) {
    const projection = entry.satellite.public;
    if (projection === undefined) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const resources = projection.resources
      .map(({ name, screenId }) => {
        const screen = entry.manifest.screens.find((candidate) => candidate.id === screenId);
        return screen !== undefined && published(screen.audience, principal)
          ? describeResource(name, screen)
          : undefined;
      })
      .filter((resource): resource is PublicResource => resource !== undefined);

    const operations = projection.operations
      .map(({ name, actionId }) => {
        const action = entry.manifest.actions.find((candidate) => candidate.id === actionId);
        return action !== undefined && offered(entry.satellite, action, principal)
          ? describeOperation(name, action)
          : undefined;
      })
      .filter((operation): operation is PublicOperation => operation !== undefined);

    // A service with nothing in it is noise in a listing and a url that answers
    // 404 on everything below it.
    if (resources.length === 0 && operations.length === 0) continue;

    services.push({
      name: projection.service,
      title: entry.satellite.displayName,
      ...(entry.satellite.description === undefined
        ? {}
        : { description: entry.satellite.description }),
      resources,
      operations,
    });
  }

  return { version: PUBLIC_API_VERSION, services };
}

export interface ResolvedResource {
  readonly satelliteId: string;
  readonly screenId: string;
  readonly params: readonly PublicResourceParam[];
}

export interface ResolvedOperation {
  readonly satelliteId: string;
  readonly actionId: string;
  readonly params: readonly PublicOperationParam[];
}

/**
 * Resolution runs through the same projection the listing does, so a client
 * cannot reach by url what it could not see in the catalog. Sharing the filter
 * rather than restating it is the whole reason these live in one file.
 */
export function resolveResource(
  entries: readonly CatalogEntry[],
  principal: Principal,
  service: string,
  resource: string,
): ResolvedResource | undefined {
  for (const entry of entries) {
    if (entry.satellite.public?.service !== service) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const mapping = entry.satellite.public.resources.find((item) => item.name === resource);
    if (mapping === undefined) continue;

    const screen = entry.manifest.screens.find((candidate) => candidate.id === mapping.screenId);
    if (screen === undefined || !published(screen.audience, principal)) continue;

    return {
      satelliteId: entry.satellite.id,
      screenId: screen.id,
      params: describeResource(resource, screen).params,
    };
  }
  return undefined;
}

export function resolveOperation(
  entries: readonly CatalogEntry[],
  principal: Principal,
  service: string,
  operation: string,
): ResolvedOperation | undefined {
  for (const entry of entries) {
    if (entry.satellite.public?.service !== service) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const mapping = entry.satellite.public.operations.find((item) => item.name === operation);
    if (mapping === undefined) continue;

    const action = entry.manifest.actions.find((candidate) => candidate.id === mapping.actionId);
    if (action === undefined || !offered(entry.satellite, action, principal)) continue;

    return {
      satelliteId: entry.satellite.id,
      actionId: action.id,
      params: describeOperation(operation, action).params,
    };
  }
  return undefined;
}

const reachable = (satellite: Satellite, principal: Principal): boolean =>
  satellite.audience.includes("external") &&
  authorize(principal, {
    audience: satellite.audience,
    rbacScopes: satellite.rbacScopes,
  }).allowed;

/**
 * Marked external by the satellite *and* callable by this principal.
 *
 * The first half is what makes the façade the façade: an internal caller here
 * sees the public API, not everything they happen to be entitled to. The
 * surface is defined by what it projects, not by who is asking.
 */
const published = (audience: readonly ("internal" | "external")[], principal: Principal): boolean =>
  audience.includes("external") &&
  authorize(principal, { audience, rbacScopes: [] }).allowed;

/**
 * Everything `published` asks of a screen, plus the two things a *write* needs.
 *
 * An action that declares no parameters is not offered at all, for the same
 * reason the MCP gateway skips one: a caller who cannot see the shape guesses
 * field names at a write endpoint, and here it is worse than for an agent —
 * the façade would accept only `{}`, so every call posts an empty payload to a
 * mutation and the partner has no way to send what it actually needs.
 *
 * And the registry's tool policy is the file that governs writes, so the scopes
 * it attaches to one are required here too. Without this, `reachable` is the
 * only scope check on the whole path and it asks for the satellite's *read*
 * scopes — a partner holding `orders.read` could run an operation the registry
 * says needs `orders.write`, and only the satellite's own check would stop it.
 * The agent path already enforces this; the outermost edge should not be the
 * one surface that does not.
 */
const offered = (
  satellite: Satellite,
  action: ActionDescriptor,
  principal: Principal,
): boolean =>
  action.params !== undefined &&
  published(action.audience, principal) &&
  authorize(principal, {
    audience: action.audience,
    // `hasOwn`, not bare bracket access: `tools` is a plain object and
    // `constructor` is a legal id, so `tools["constructor"]` resolves to the
    // `Object` function, whose `rbacScopes` is undefined — and `?? []` would
    // then quietly require *no* scopes on exactly the surface where that is
    // worst. The gateway fixed this same read two changes ago; the fix did not
    // travel with the rule.
    rbacScopes: Object.hasOwn(satellite.tools, action.id)
      ? (satellite.tools[action.id]?.rbacScopes ?? [])
      : [],
  }).allowed;

function describeResource(name: string, screen: ScreenDescriptor): PublicResource {
  return {
    name,
    title: screen.title,
    ...(screen.description === undefined ? {} : { description: screen.description }),
    params: (screen.params ?? []).map((param) => ({
      name: param.name,
      required: param.required,
      ...(param.description === undefined ? {} : { description: param.description }),
    })),
  };
}

function describeOperation(name: string, action: ActionDescriptor): PublicOperation {
  return {
    name,
    title: action.title ?? name,
    ...(action.description === undefined ? {} : { description: action.description }),
    params: (action.params ?? []).map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required,
      ...(param.description === undefined ? {} : { description: param.description }),
      ...(param.enum === undefined ? {} : { enum: param.enum }),
    })),
  };
}
