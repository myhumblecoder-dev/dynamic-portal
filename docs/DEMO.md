# Demo runbook

Twenty to thirty minutes, for a room that controls budget. The ask at the end
is a pilot: two or three real solutions, one quarter.

Every claim below has been run. Where something is unproven or fragile it says
so — a demo that oversells is worse than a shorter one, because the first
question afterwards is usually the one you dodged.

---

## Before the room

```bash
docker compose up -d --build            # ~2 minutes cold, ~20 seconds warm
open http://localhost:3000
```

Four services must be `healthy`:

```bash
docker compose ps --format "{{.Service}} {{.Health}}"
```

**Reset between rehearsals.** Satellites hold state in memory, so orders you
create and files you attach persist until the container restarts:

```bash
docker compose restart satellite-orders satellite-fleet satellite-depots
```

**Decide the model before you start**, and check what the hub actually has —
do not infer it from what you set:

```bash
docker compose logs hub | grep assistant:
# assistant: qwen2.5:7b on http://host.docker.internal:11434 (local, no API cost)
# assistant: claude-opus-5 via the Anthropic API (metered — every turn is billed)
# assistant: off (no ANTHROPIC_API_KEY — …)
```

The provider is read from `.env`. A hub that falls back to the metered API does
so silently otherwise, which is how this line came to exist.

**Decide the model before you start.** The assistant beats need one:

| | Setup | Composition | Notes |
|---|---|---|---|
| Hosted | `ANTHROPIC_API_KEY` in `.env` | ~13 s, measured | What to use in the room |
| Local | `PORTAL_MODEL_PROVIDER=ollama` | does not work | Free; six of the seven `the assistant` tests pass |

Screen composition — beat 6 — **needs the hosted model**. On a local 7B it runs
out of turns rather than composing. If the key is dead or the venue's network
is unreliable, cut beat 6 and say why; do not let it fail live.

**That ~13 s is a measurement, not a guarantee.** The home page is one turn
with several tool calls and a satellite round trip inside each, so it moves with
the model and the venue's network — the e2e test allows over three minutes
before giving up, and that gap is deliberate rather than slack. Rehearse it on
the venue's connection, keep talking while it fills in, and if it has not landed
by the time you finish the sentence, move on: the launcher above it is a
complete page, and beat 6 is the only beat that can be cut.

---

## Which model, and what beat 6 needs

Set `PORTAL_MODEL_PROVIDER=ollama` in `.env` and the stack runs `qwen2.5:7b` on
this machine: free, private, and enough for every beat except one. It is opt-in
and never a fallback — a `.env` copied from `.env.example` names no provider and
no key, and that hub reports `assistant: off`.

| | beat 6 — the composed home | everything else |
|---|---|---|
| `qwen2.5:7b` (local, free) | **0/3** | works |
| `claude-opus-5` (metered) | **3/3** | works |

Measured, not assumed, and raising the turn budget to 20 did not move the local
model at all — it is a capability limit, not a budget one. Composing a screen
means satisfying a 34-variant schema where every figure must cite a verified
tool call, and a 7B model does not get there.

**So: rehearse on the local model, and decide about beat 6 separately.** Either
skip it — it is `additive, never load-bearing` by design, and the failure table
below already covers it — or move to the hosted model for the run: unset
`PORTAL_MODEL_PROVIDER` in `.env` **and** set `ANTHROPIC_API_KEY`, then read the
startup line back. Unsetting the provider on its own resolves to Anthropic with
no key, which is `assistant: off` and a 404 from every assistant beat rather
than a hosted beat 6. One composed home on Opus costs about $0.15; a full `pnpm test:e2e` costs
about $1.45, which is worth knowing before running it in a loop.

## The spine

### 1 · One portal, three solutions (2 min)

Open `/`. Every solution is a card: whether it is up, how fast it answered, and
the figures that matter to it today. Let it settle for a second — the cards
paint immediately and each one's status fills in on its own.

> "One page for the estate. Is everything up, and what does today look like."

Then the line that matters, because it is the one they will not expect:

> "The hub has no idea what an order is. It does not know what a vehicle is
> either. Every number there is a figure the team already puts on their own
> screen — the hub just reads the screen they nominated. Adding a fourth
> solution changes nothing on this page."

Click **Orders**, then **Fleet**, then **Depots**.

> "Three solutions, one portal. Same shell, same table, same badges."

Copy the URL of a detail screen, paste it in a new tab, hit back. It all works
— these are real routes, not an iframe.

**Pick the brand.** `PORTAL_BRAND=partner docker compose up -d hub` swaps the
whole portal onto a second sample palette — no rebuild, just a re-created
container. `up -d`, never `restart`: a container's environment is fixed when it
is created, so restarting re-runs the old value and the rebrand silently does
not happen. Beat 2 has the long version.

`partner` is a **sample**, not your audience's palette — do not tell a room it
is theirs. What it demonstrates is the cost of making it theirs: one block of
custom properties in `globals.css`, no rebuild and no satellite touched. If
there is time before the room, paste their colours into a copy of that block
and add the name to `BRANDS`; a portal wearing the audience's palette stops
reading as a prototype.

### 2 · Where is the JavaScript? (2 min) — *kills version-and-dependency hell*

> "Fleet is Python. Depots is C#. Neither ships a line of JavaScript or a byte
> of CSS. There is no shared React version to fight over, because satellites
> send **data**, not code."

That is the difference from the last attempt, and it is structural rather than
a promise.

**Optional, and the shortest proof of it.** Set `PORTAL_BRAND=contoso` in `.env`,
then:

```bash
docker compose up -d hub                # NOT `restart` — see below
```

All three solutions restyle at once; none is rebuilt, redeployed, or told.

> `up -d`, not `restart`. A container's environment is fixed when it is
> created, so `docker compose restart hub` re-runs the same process with the
> same variables and the brand does not change — verified, because it is a
> silent no-op and the natural thing to type. `up -d` notices the config
> changed and re-creates the container from the image it already has, which is
> still no rebuild. Beat 3 is the other way round: the registry is a *mounted
> file*, so `restart` is genuinely enough there.

Rehearse it. It is the same few seconds of silence as beat 3, and the two are
better shown together than apart.

### 3 · The authoring moment (4 min) — *kills coordination cost*

Show `apps/satellite-depots/src/Satellite.Depots/Screens.cs`. It is a few
dozen lines and it produces the whole Depots dashboard.

Then edit `config/satellites.yaml` — change a `displayName` — and
`docker compose restart hub`. New portal, ~15 seconds, **no hub deploy, no
satellite deploy**.

> The registry is mounted into the hub rather than baked into its image. It has
> to be: with `COPY . .` the container re-read its own stale copy and the edit
> did nothing, which quietly falsified this beat. There is a test for the mount
> now, because this is the claim the pilot rests on.

> "Adding or changing a screen costs zero hub deployments. That is the number
> to hold me to."

**If you can, hand someone the keyboard.** A person who has never seen the code
adding a column is worth more than watching you type. Rehearse the undo.

### 4 · A real form (4 min) — *the objection you will actually get*

**Orders → New order.**

- Type a bad email → the error lands **on the field**, not as a banner.
- Tick **Expedite** → a reason box appears. Untick → it goes.
- Choose the **hazmat** label → a handling-notes box appears.
- Set priority **critical**, leave Expedite clear, submit → *"Critical orders
  are expedited."*

> "That last rule is not something a single field can express, and every real
> form has rules like it. The satellite sent `{field, equals}` — data, not code.
> The hub evaluated it. And the server enforces the rule regardless: hiding a
> field is presentation, and the satellite does not believe the browser."

Then open an order → **Documents** → attach a PDF. Bytes cross the hub to the
satellite, which records what arrived.

### 5 · Blast radius (2 min) — *the risk question, answered before it is asked*

```bash
docker compose stop satellite-fleet
```

Reload the portal. **The front page tells you first** — Fleet's card goes red
and says so, while Orders and Depots keep their figures. Open Fleet and it is a
scoped error card; the wordmark still takes you home.

If you want the sharper version, `docker compose pause satellite-fleet` instead:
the container accepts connections and never answers, which is the failure that
actually hangs systems. The card waits out its three-second budget and gives up;
the other two are already on screen.

```bash
docker compose start satellite-fleet
```

> "One solution failing is one card. That got **better**. The hub failing is
> new, and it is the trade we would be asking you to fund."

Have the availability slide ready — it is the strongest argument against this
and they will find it without you.

### 6 · The assistant (5 min) — *needs the hosted model*

Return to `/`. The launcher renders instantly; below it, **Needs attention**
fills in — a screen composed across all three solutions, with the tool calls it
came from named on it.

> "No satellite could have produced that view, because no satellite can see the
> others. Nobody maintains it. Every number on it traces to a tool call."

Then open the assistant and ask it to approve an order. It **pauses** and the
hub draws a confirmation card.

> "The model proposes; a person decides. Deletion is not offered to it at all —
> that is a line in a config file a human reviews, not a prompt."

### 6b · What a solution can offer beyond a screen (3 min) — *the API/MCP question*

This beat exists because someone in the room is researching MCP and will ask
whether this is a portal strategy or an integration strategy. It is one thing.

Point at the tags on the landing page first — **MCP** on Order Management,
**Non-MCP** on the other two. That ratio is the argument, and it is on screen
before you say anything.

Ask the assistant: **"Which pending orders are critical?"** It answers, and the
tool it used was `orders.search` — which is **not** one of Order Management's
screens. That satellite hosts its own MCP server, and this is a capability with
no UI: a structured query with nested filters.

> "Two of our three solutions host nothing. The hub turns their screens into
> agent tools for free — that is the default, and it is why onboarding is a day.
> Order Management went further, and got to offer something a screen cannot
> express. The hub gained no code for it. Not one line knows what an order is."

Then ask it to **reconcile blocked orders for a vehicle**. It pauses on the same
confirmation card you saw in beat 6 — a tool the hub has never heard of,
governed by the same file, in the same way.

> "That is the whole answer on MCP. Solutions can expose capability directly,
> and the moment they do it lands under the same governance as everything else:
> the registry decides who may call it, whether a person confirms, and it is in
> the same audit log. We did not build a second system to hold it."

**If asked "so should every team run an MCP server?"** — No, and the ratio in
front of them is the recommendation: one in three. A team should host one when
it has a capability its screens cannot express. Otherwise the shim is strictly
less work for the same reach.

### 6c · The same surface from outside the portal (4 min) — *optional*

Run this from **Claude Code**, not Claude Desktop. See the warning below.

Set up before the room is watching — the stack on `PORTAL_ALLOW_DEV_SESSION=0`,
so the endpoint genuinely demands a token:

```
claude mcp add --transport http portal http://localhost:3000/api/mcp --callback-port 47110
```

Live, run `/mcp` → Authenticate. A browser opens at Keycloak — the *same* login
the portal uses. Sign in as `eng`, then ask it to list the orders. Real data,
from the same satellite the screens read.

The beat lands on what is *missing*. `orders__orders_edit` is there for `eng`
because the satellite declares that screen `roles: [engineering]`. Sign out, sign
back in as `fin`, and it is gone. `orders.approve` is absent for both, and refuses
if named directly.

> "This is the same endpoint, the same code, and the same registry file. The
> only thing that changed is who logged in. An agent outside the portal gets
> exactly what that person would get inside it — nothing widened because the
> request arrived over a different wire."

**Do not run this beat from Claude Desktop.** Desktop can only talk to stdio
servers, so it needs the `mcp-remote` bridge, and it kills any MCP server that
has not finished `initialize` within its startup timeout, then respawns it. The
bridge opens a browser sign-in window on every start, nobody logs in that fast,
and each new process invalidates the previous window's PKCE verifier. In front of
an audience that is three or four dead sign-in windows and no connection.

Desktop does work if it is signed in *before* it launches — `scripts/mcp-login.sh`,
then start Desktop — but there is no reason to take the risk live. Claude Code
speaks HTTP directly and has none of this. If someone asks, the honest answer is
that it is a host limitation, not a portal one: the same bridge misbehaves under
Claude Code too, and neither host needs it when the host can speak HTTP.

### 7 · The ask (3 min)

Two or three named solutions, one quarter, and the platform team writes the
first screen for each. That last clause turns "will teams adopt?" from a hope
into a commitment, and it is cheap at this size.

---

## The data on screen is invented, deliberately

Wile E. Coyote, Acme Anvils, Globex. Addresses are on `.test`, a domain reserved
by RFC 6761 that can never resolve.

That matters more under a real brand than under a neutral one: a screenshot of
plausible-looking personal data is a problem in a regulated organisation whether
or not the data is real, and "it was only demo data" is a sentence nobody wants
to say afterwards. There is a test asserting it stays that way, so a future edit
that reaches for realism fails in CI rather than in a deck.

If someone asks whether this is real data, the answer is no, and it is provable
in one file.

## If something breaks

| Symptom | Cause | Do this |
|---|---|---|
| Assistant says it could not complete | No API credit, or model unreachable | Skip to beat 7; the deterministic portal is unaffected |
| A screen shows an error card | That satellite is stopped | `docker compose start satellite-<name>` |
| Form shows stale data | In-memory state from a rehearsal | `docker compose restart satellite-orders` |
| Home never fills in | Composition failed | Say so and move on — the cards above it are a complete page |
| A card is stuck on "Checking…" | That satellite is slow | It resolves or gives up within its timeout; the other cards are unaffected, which is beat 5 arriving early |
| A card shows no figures | That satellite nominates no summary screen, or the account cannot read it | Expected, not broken — the card still shows health |
| `/mcp` shows "Needs authentication" and nothing happens | Normal — authentication is user-initiated | Choose the server, then Authenticate; a browser opens |
| MCP login shows no sign-in page | A Keycloak SSO session is still live, so it re-authorized silently as the previous user | Open `http://localhost:8080/realms/portal/protocol/openid-connect/logout`, then reconnect |
| Several Keycloak sign-in windows open at once | Claude Desktop respawning the stdio bridge — see beat 6c | Quit Desktop, `pkill -f mcp-remote`, run `scripts/mcp-login.sh`, then reopen. Better: run the beat from Claude Code |
| `orders.search` not found | The orders MCP server is unreachable | Skip beat 6b — the other tools are unaffected, which is itself the point of beat 5 |

**Do not** run `docker compose down` in the room. Restarting a service keeps
the stack up; `down` removes the containers and the next `up` re-creates all
four and waits on every healthcheck. The images and the build cache survive it,
so this is the ~20-second warm path rather than the cold build — but it is
still the longest silence in the room, and `restart` above does everything a
rehearsal reset needs.

(The `-v` in `pnpm down` is harmless here: this stack declares no named volumes,
so there are none to remove. Satellite state is in memory and goes with the
container either way.)

---

## What to say if asked

**"Is this micro-frontends again?"** No. Satellites send JSON validated against
a fixed vocabulary. Nothing they send is executed. The failure mode you had —
version coupling between teams — is absent by construction, not by discipline.

**"What if a solution needs something the vocabulary lacks?"** Then the platform
team adds it, additively, and every satellite keeps working. The rule is that a
new component needs demand from more than one team. There is an escape hatch —
a registered full-page iframe — and it is deliberately unattractive.

**"What does this cost?"** A permanent platform function. If it is defunded in
year three, the catalog stops evolving and teams take the escape hatch, and you
are back to the portal this replaced. That risk is organisational; no
architecture removes it.

**"Can we see it fail?"** Yes — beat 5 is exactly that, and it is in the demo
deliberately.
