import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callMcpTool, mcpTools, serverInstructions } from "@portal/mcp-server";
import type { Principal } from "@portal/identity";
import { agentInvokerDeps, buildAgentSurface, isAgentAllowedForTenant } from "@/lib/agent";
import {
  McpAuthError,
  challengeHeader,
  presentsCredential,
  principalFromBearer,
} from "@/lib/mcpAuth";
import { oidcConfigured } from "@/lib/oidc";
import { currentPrincipal } from "@/lib/session";

/**
 * The hub, as an MCP server.
 *
 * One endpoint, everything this account can reach. A staff member points Claude
 * Desktop or an IDE agent here and gets the same tools the in-hub assistant
 * gets, filtered by the same `entitle()` the screens use — the difference is
 * the wire, not the policy.
 *
 * **Stateless, and a fresh server per request.** No session id generator and
 * `enableJsonResponse` on, so every POST is self-contained: two hub replicas
 * need share nothing, and a restart costs a host nothing but a reconnect. The
 * surface is rebuilt per request for the same reason it is in the agent route —
 * a satellite that changed what it offers is reflected on the next call rather
 * than whenever a session happens to end.
 *
 * **Authenticated as an OAuth resource server.** A host presents a bearer token
 * it obtained by sending the user through the same Keycloak login the screens
 * use; `principalFromBearer` maps it through the same `principalFromClaims`, so
 * the roles here are the roles the portal would show that person. See
 * `lib/mcpAuth.ts` for why that mapping, rather than anything in this file, is
 * what makes "the difference is the wire, not the policy" true.
 */

/** An OAuth challenge, shaped so a host knows where to begin (RFC 6750, RFC 9728). */
function challenge(error: McpAuthError): Response {
  return new Response(
    JSON.stringify({ error: error.code, error_description: error.message }),
    {
      status: error.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": challengeHeader(error.code, error.message),
      },
    },
  );
}

/**
 * Who is calling, by whichever credential was presented.
 *
 * Bearer first, and — the part that matters — a bearer token that fails to
 * verify is the end of the request. Falling through to the cookie or the dev
 * stub after rejecting a token would mean a caller could be *upgraded* by
 * sending a bad one, which is the opposite of what presenting a credential
 * means. That is the single rule this function exists to hold.
 *
 * With no token at all, `currentPrincipal` answers exactly as it does for the
 * screens: a session cookie, then the development stub where it is enabled.
 * Deferring to it rather than challenging immediately keeps one definition of
 * "who is signed in" for the whole hub — and the stub is already an explicit,
 * production-refusing switch, so an endpoint that second-guessed it here would
 * only be disagreeing with the rest of the portal. When it has nothing to
 * offer, the caller gets the OAuth challenge and can go and get a token.
 */
async function principalFor(request: Request): Promise<Principal> {
  if (presentsCredential(request)) return principalFromBearer(request);

  try {
    return await currentPrincipal();
  } catch {
    throw new McpAuthError(
      "invalid_token",
      oidcConfigured()
        ? "This endpoint requires an OAuth access token. See the resource metadata to obtain one."
        : "You are not signed in.",
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let principal: Principal;
  try {
    principal = await principalFor(request);
  } catch (error) {
    return challenge(
      error instanceof McpAuthError
        ? error
        : new McpAuthError("invalid_token", "The credential presented was not accepted."),
    );
  }

  // The per-tenant kill switch, which governs the surface rather than whose
  // model reaches it — so it has to close this endpoint too, and for a while it
  // did not: the predicate was imported here and never called, leaving
  // PORTAL_AGENT_DISABLED_TENANTS shutting `/api/agent` while the outward MCP
  // server stayed open to the same tenant. A withdrawn consent that only closes
  // the door you happened to think of is not a consent control.
  if (!isAgentAllowedForTenant(principal)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "The assistant is not enabled for this account." },
      }),
      { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }

  let surface;
  let invoker;
  try {
    surface = await buildAgentSurface(principal);
    // Inside the same guard: `agentInvokerDeps` derives this tenant's audit key,
    // and `auditConfig()` throws when the mandatory audit settings are missing.
    // Outside, that throw is Next's HTML error page — the one thing this handler
    // must never hand an MCP host.
    invoker = agentInvokerDeps(principal);
  } catch {
    // `getPortal()` throws when the registry file or the principal secret is
    // missing. Letting that escape hands the host Next's error page — HTML, and
    // a stack trace in development — where the agent route deliberately returns
    // a sentence. A host can act on a JSON-RPC error and cannot act on either.
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "The portal could not list what this account can reach." },
      }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  const { deps, flush } = invoker;

  const server = new Server(
    { name: "dynamic-portal", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      // Read before any tool is called. It is where the governed writes are
      // named, so an agent that cannot see them sends the user to the portal
      // rather than reporting the thing impossible.
      instructions: serverInstructions(surface),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: mcpTools(surface).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (message) => {
    const result = await callMcpTool(
      surface,
      message.params.name,
      (message.params.arguments ?? {}) as Record<string, unknown>,
      principal,
      deps,
    );
    // Before the response leaves. A tool call whose record is still in flight
    // is a tool call the log may never show.
    await flush();
    // Copied into mutable arrays because the SDK's result type is not readonly,
    // and `isError` is spread rather than set so it is absent on success —
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as a value.
    return {
      content: [...result.content],
      ...(result.isError === true ? { isError: true } : {}),
    };
  });

  // Stateless because `sessionIdGenerator` is absent, not because it is set to
  // `undefined`: the transport stores `options.sessionIdGenerator` verbatim and
  // then tests it for `undefined`, so omitting the key and passing the key are
  // the same transport. Omitting it is the one `exactOptionalPropertyTypes`
  // accepts, which is why there is no assertion here — and no assertion means a
  // typo in `enableJsonResponse` is still a type error rather than a silent
  // fall back to SSE that every JSON-mode host would hang on.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    await flush();
    return response;
  } finally {
    // Nothing is kept between requests, so nothing may be left holding a socket.
    await transport.close();
  }
}
