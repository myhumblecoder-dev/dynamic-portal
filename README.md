# Dynamic Portal

A central hub that renders every solution's UI from a declaration the solution owns — plus an LLM agent and an MCP gateway over the same vocabulary.

**No micro-frontends.** Satellites send *data, not code*. The hub owns all CSS, branding, shell, nav, and auth; satellites own what to display. Adding or changing a satellite screen requires **zero hub deployments**.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the system design, and **[PLAN.md](./PLAN.md)** for the vision, the durability thesis, and the build order.

## The idea in one picture

```
            ┌──────────────────────────────┐
            │   SATELLITE DECLARATIONS      │  ← the durable asset
            │   screens · actions · tools   │
            └──────────────┬───────────────┘
                           │
     ┌──────────┬──────────┼──────────┬──────────┐
     ▼          ▼          ▼          ▼          ▼
  Screens   Agent tools  Outward   Public API  (future
                          MCP      (brokered)  projections)
```

One declaration, many projections. "AI / MCP / API" are not three systems — they are three views of one asset.

## Status

Early. Building M1 (deterministic portal + identity spine). See the build order in `PLAN.md`.

## Requirements

- **Node >= 22** (developed on 24)
- **pnpm 11.22.0** — `brew install pnpm`, version pinned by the `packageManager` field.
  Not via corepack: corepack ships with Node only up to v25, so it stops being
  available on the next LTS.
- **Docker** with Compose v2+
- Python 3.11+ (for the `satellite-fleet` satellite, not yet built)

## Getting started

```bash
pnpm install
pnpm up          # build and start the stack in Docker
pnpm test:all    # unit → integration → e2e
pnpm down        # stop and remove volumes
```

Running services:

| Service | Language | Port | MCP server | Health |
|---|---|---|---|---|
| `hub` | TypeScript / Next.js | 3000 | **outward**, `POST /api/mcp` | `GET /` |
| `satellite-orders` | TypeScript | 4001 | **hosts one**, `POST /mcp` | `GET /healthz` |
| `satellite-fleet` | Python | 4002 | **none, deliberately** | `GET /healthz` |
| `satellite-depots` | C# / .NET | 4003 | **none, deliberately** | `GET /healthz` |

Open <http://localhost:3000>. The landing page is built from
`config/satellites.yaml` for the current principal, so a satellite you cannot
reach is absent from the response rather than hidden in the browser. There is no
sidebar — the cards below *are* the navigation, grouped and ordered by the
`nav: { section, order }` each satellite declares. The wordmark is the way back
to them from any screen.

Each card is tagged **MCP** or **Non-MCP** — how the agent reaches that
solution. It is read from the registry's `mcpUrl`, never the manifest's, so a
satellite cannot advertise an integration the platform team did not grant it by
editing a file it owns. The tag is a property of the deployment, not a health
check: a solution whose MCP server is down is still an MCP solution, and the
pill beside it is what changes.

The landing page is a card per solution: its health, and the figures it chose to
be summarised by. Neither half is hardcoded. Health comes from the `healthPath`
in each manifest — probed by the hub, deliberately without touching the circuit
breaker: a liveness probe is an observation, not traffic, and recording either
outcome against the breaker would let a cheap `/healthz` reopen a circuit or a
flaky one close it. The figures are the
stat tiles on a screen the satellite nominates with `summary`, read with the
same extractor the agent's read tools use. So the front page can show no number
a team is not already showing its own users, nothing is declared twice, and
adding a fourth solution needs no hub change. Each card resolves in its own
`<Suspense>` boundary, so one slow satellite delays one card.

Three languages is not decoration. The protocol is a wire format, not a shared
library, and `satellite-fleet` shares no code with `@portal/protocol` — the e2e
tier parses its responses with the TypeScript schemas, which is where that stops
being a claim.

The MCP column is the other deliberate split. Two of three satellites ship no
MCP server, which is what keeps the hub's PUP-to-MCP shim exercised: a satellite
is agent-reachable for free, from the manifest it already publishes, with no
second server to run.

`satellite-orders` hosts one anyway, and the bar for that is not "MCP is good".
It is a capability PUP cannot express — `orders.search` takes a nested query,
and `orders.reconcile` has no screen at all. What the hub gained for it is zero
lines of satellite-specific code: `packages/mcp-gateway/src/client.ts` is
generic, and governance still comes from `config/satellites.yaml`. See
`apps/satellite-orders/src/mcp.ts` for the argument in full.

## Testing

Three tiers, separated by what they are allowed to touch. Tests live beside the
code they cover; the tier is chosen by filename, not directory.

| Tier | Command | Pattern | Touches |
|---|---|---|---|
| **unit** | `pnpm test` | `src/**/*.test.ts` | Pure logic. No sockets, no clock. |
| **integration** | `pnpm test:integration` | `src/**/*.integration.test.ts` | A real server on a real port, in-process. No browser. |
| **python** | `pnpm test:py` | `apps/satellite-fleet/tests/` | Both tiers for the Python satellite (`-m integration` splits them). |
| **e2e** | `pnpm test:e2e` | `e2e/**/*.spec.ts` | The running stack, over published ports. Requires `pnpm up`. |

`pnpm test:all` runs every tier in order.

The tiers earn their keep by failing differently. Integration tests verify the
code; e2e verifies the code *as deployed* — image, entrypoint, environment,
healthcheck, port mapping. A green integration suite alongside a broken
Dockerfile is exactly the gap the e2e tier closes.

`pnpm stack:test` runs the suite inside the same image the services run in, so a
green local run and a green containerised run mean the same thing.

**Before opening a PR, run `pnpm verify:ci`.** It executes the CI workflow's
steps verbatim and in order. The distinction matters: CI installs with
`--frozen-lockfile` / `--frozen`, which *fail* on lockfile drift, while a plain
`pnpm install` / `uv sync` quietly re-resolves and passes — which is the
realistic way a PR goes red after a green local run.

## Contributing

`main` is protected by a repository ruleset. Direct pushes, force-pushes and
deletion are refused; every change lands through a pull request with a green
**`build + test`** check.

**Review is a working agreement, not a ruleset rule.** Every PR gets a code
review pass with findings applied *before* it is merged — including PRs opened
by whoever wrote the code.

That split is deliberate. GitHub can require an *approval*, but it forbids a PR
author from approving their own pull request, and this repository has a single
collaborator who authors every PR. Requiring one approval therefore made every
PR permanently unmergeable, with no bypass — the requirement is only meaningful
once a second account with write access exists. Rather than weaken CI to work
around it (bypass actors skip *every* rule in a ruleset, including the status
check), the approval requirement is left off and the review is enforced by
process. Add it back when there is someone to do the approving.

## Configuration

`config/satellites.yaml` supports `${VAR}` and `${VAR:-default}`, the same
subset docker-compose uses. Hostnames are parameterised so one reviewed file
serves every environment — the default is a laptop, and compose overrides it
with service names. An unset variable with no default is a startup error rather
than a silent empty value.

| Variable | Purpose |
|---|---|
| `PORTAL_PRINCIPAL_SECRET` | Shared HMAC secret for principal tokens. Required; the hub and satellites refuse to start without it. |
| `PORTAL_AUDIT_KEY` | Root secret every tenant's audit digest key is derived from. Required by the hub; there is no unkeyed mode. |
| `PORTAL_AUDIT_LOG` | Absolute path the audit records are appended to. Required by the hub; writes fail closed, so its storage is on the critical path. |
| `PORTAL_REGISTRY_PATH` | Where to read the registry. Defaults to `config/satellites.yaml`. |
| `PORTAL_ORDERS_URL` / `PORTAL_FLEET_URL` / `PORTAL_DEPOTS_URL` | Satellite base URLs. |
| `PORTAL_DEV_TENANT` / `PORTAL_DEV_AUDIENCE` / `PORTAL_DEV_ROLES` | Switch the development session's tenant, audience, or org roles, for exercising isolation and RBAC by hand. `PORTAL_DEV_ROLES=finance` acts as finance; unset means every role. |
| `PORTAL_ALLOW_DEV_SESSION` | Lets the development session stub run under `NODE_ENV=production`. Set only by the compose stack. Set it to `0` to force real Keycloak login instead of the stub. |
| `PORTAL_OIDC_ISSUER` | Keycloak realm issuer, browser-facing (e.g. `http://localhost:8080/realms/portal`). Enables OIDC login when set. |
| `PORTAL_OIDC_INTERNAL_ORIGIN` | Origin the hub reaches Keycloak at from inside the network (e.g. `http://keycloak:8080`) when it differs from the browser-facing issuer; the hub rewrites its own back-channel calls to it. |
| `PORTAL_OIDC_CLIENT_ID` / `PORTAL_OIDC_CLIENT_SECRET` | The confidential client the hub authenticates as. |
| `PORTAL_OIDC_REDIRECT_URI` | The hub's callback URL registered with that client (e.g. `http://localhost:3000/api/auth/callback`). |
| `PORTAL_SESSION_SECRET` | Secret the encrypted session cookie is keyed from. Required once OIDC is in use. |
| `PORTAL_PUBLIC_ORIGIN` | The origin MCP hosts reach the hub at. Names the OAuth resource an access token must be audienced to, so it is configuration rather than a `Host` header read. Defaults to `http://localhost:3000`; must match the audience mapper on the `portal-mcp` realm client. |
| `PORTAL_MCP_CLIENT_ID` | The public PKCE client handed to every caller of the registration shim. Defaults to `portal-mcp`. |
| `PORTAL_BRAND` | Which palette the portal wears. Every brand ships in the hub's stylesheet, so a rebrand costs no rebuild and no satellite is redeployed or told; applying it re-creates the hub container (`docker compose up -d hub`, not `restart`, which keeps the environment it was created with). Currently `contoso` and `partner`; unset is the default palette, and an unrecognised name is a startup error rather than a rebrand that silently did not happen. |

Two session providers, tried in order: a real **Keycloak OIDC** login (when the
`PORTAL_OIDC_*` variables are set), then — only behind `PORTAL_ALLOW_DEV_SESSION`
— a development stub that otherwise refuses to run under `NODE_ENV=production`.
The hub logs the user in at Keycloak and maps the token's org roles and tenant
into the same `Principal` everything downstream already takes; the wire to
satellites is still the signed `Principal`, with RFC 8693 token exchange the next
step. Nothing below the session boundary changes either way.

### Roles and login

Four org roles gate what each person sees and does: `leadership`, `engineering`,
`finance`, `platform`. Satellites declare which roles may reach each screen and
action; the hub enforces; the platform registry can narrow further but never
widen. Roles are **any-of** and **opt-in** (a screen that declares none is not
role-gated), and they gate **internal** users only — external/partner access is
governed by audience and the public API.

Two ways to exercise it locally:

- **Dev-role switch** (no IdP): `PORTAL_DEV_ROLES=finance docker compose up -d hub`
  re-creates the hub acting as finance; nav, screens, and the agent surface narrow
  to match. Unset means every role.
- **Real Keycloak login**: `PORTAL_ALLOW_DEV_SESSION=0 docker compose up` forces the
  OIDC flow. Log in as `lead`, `eng`, `fin`, or `plat` (password = the username) —
  one demo user per role, all in tenant `acme`.

### Connecting an MCP host

`POST /api/mcp` is an OAuth 2.0 protected resource. A host discovers how to
authenticate, sends the user through the *same* Keycloak login the screens use,
and comes back with a bearer token whose realm roles become the `Principal`'s
roles — so the tools it is offered are the ones that person could reach in the
portal. The difference is the wire, not the policy.

**Claude Code** speaks HTTP MCP directly, which makes it the path to use:

```
PORTAL_ALLOW_DEV_SESSION=0 docker compose up
claude mcp add --transport http portal http://localhost:3000/api/mcp --callback-port 47110
```

Then `/mcp` inside Claude Code, and Authenticate. A browser opens at Keycloak;
log in as `eng` / `eng`. The `orders.edit` screen is declared `roles: [engineering]`
by the satellite, so `orders__orders_edit` is among the tools offered. Sign out and
reconnect as `fin` / `fin` and it is gone — same endpoint, same code, a different
role. The governed writes (`orders.approve` and the rest) are absent for everyone,
as they are on any MCP session: they are not listed, and refuse if called by name.

`--callback-port` pins the redirect URI. The realm registers the loopback form, so
any port works, but a fixed one keeps the flow reproducible.

Keycloak stays the only authorization server. The hub serves RFC 9728 resource
metadata at `/.well-known/oauth-protected-resource/api/mcp` and republishes the
realm's authorization metadata with one field changed: `registration_endpoint`
points at `/api/oauth/register`, which hands every caller the pre-registered
public `portal-mcp` client. Hosts that require RFC 7591 registration therefore
connect without Keycloak's own registration endpoint being exposed. Authorization
and token exchange go straight to Keycloak; the hub never sees a credential.

#### Claude Desktop: works, but read this first

> **Do not sign in for the first time from Claude Desktop.** It opens a browser
> sign-in window *per connection attempt*, and none of them can succeed. Run
> `scripts/mcp-login.sh` first, then start Desktop.

Desktop's `claude_desktop_config.json` accepts only stdio servers — an entry
without a `command` is silently skipped with a warning dialog — so a remote HTTP
server has to go through `mcp-remote`, a stdio-to-HTTP bridge that performs the
OAuth flow itself:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json   (macOS)
{
  "mcpServers": {
    "dynamic-portal": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.8.3", "http://localhost:3000/api/mcp", "47110"]
    }
  }
}
```

The bridge is where the trouble comes from. Desktop tears down an MCP server that
has not finished `initialize` within its startup timeout and respawns it, and
`mcp-remote` opens a browser every time it starts. Nobody logs in that fast, so
each respawn adds another sign-in window — and each new process invalidates the
previous one's PKCE verifier, so the earlier windows are already dead. Observed:
three windows, four spawns, no connection.

Authenticating *before* Desktop launches removes the race. Nothing supervises
that process, so the browser can stay open as long as you need:

```
scripts/mcp-login.sh          # sign in once, at your own pace
open -a Claude                # connects immediately, no browser
```

This is not specific to Desktop — Claude Code does the same thing if you point it
at the stdio bridge instead of using `--transport http` (two windows, then a
timeout). It is inherent to supervising a stdio server that blocks on a human.
Claude Code simply does not need the bridge.

`~/.mcp-auth` caches the token. To sign in as somebody else, delete it *and* end
the Keycloak session — otherwise SSO re-authorizes silently as the previous user
and no login is shown:

```
rm -rf ~/.mcp-auth
open http://localhost:8080/realms/portal/protocol/openid-connect/logout
```

> Run the stack with `PORTAL_ALLOW_DEV_SESSION=0`. With the stub enabled the
> endpoint answers an unauthenticated host as one fixed all-roles tenant, so the
> host never starts the OAuth flow and every user looks the same.

> The `portal-mcp` client registers `http://localhost/*` and `http://127.0.0.1/*`,
> which is Keycloak's loopback form: the port is ignored (MCP hosts bind an
> ephemeral one) and the host is anchored. The obvious-looking `http://localhost*`
> is **not** equivalent and must not be used — a trailing wildcard is a plain
> prefix match, so it also matches `http://localhost.attacker.example/`, and a
> public client whose redirect URI an attacker controls hands them the
> authorization code and with it the user's roles.

## Conventions

- **TDD** — red, green, refactor. Tests land with (or before) the code they cover.
- **A branch per feature**, PR into `main`. No merge without a review and green CI.
- **The catalog is additive-only.** Components are deprecated, never removed.
- **Satellites authorize themselves.** The hub authenticates and propagates the
  principal; every satellite independently enforces tenant scoping. A hub bug
  must be an availability incident, never a cross-tenant disclosure.
