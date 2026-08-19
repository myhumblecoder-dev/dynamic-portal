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

## The spine

### 1 · One portal, three solutions (1 min)

Open `/`. Click **Orders**, then **Fleet**, then **Depots**.

> "Three solutions, one portal. Same shell, same table, same badges."

Copy the URL of a detail screen, paste it in a new tab, hit back. It all works
— these are real routes, not an iframe.

**Pick the brand.** `PORTAL_BRAND=partner docker compose up -d hub` dresses
the portal in the organisation's own colours — no rebuild, just a re-created
container. `up -d`, never `restart`: a container's environment is fixed when it
is created, so restarting re-runs the old value and the rebrand silently does
not happen. Beat 2 has the long version. Worth doing before the room: a portal
wearing your palette stops reading as a prototype. The colours were read off the
public site rather than a brand guide, so a designer should confirm the exact
values; correcting them is one block in `globals.css`, which is itself the
point.

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

Reload the portal. Fleet shows a scoped error card; Orders and Depots are
untouched; navigation still works.

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
| Home never fills in | Composition failed | Say so and move on — the launcher is a complete page |

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
