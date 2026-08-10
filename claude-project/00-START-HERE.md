# Start here

You are looking at **solana-tracker**: a Solana wallet-copy trading bot that has
never traded real money and is not close to doing so. It runs in **paper mode**
only. There are no live keys, no `liveBroker` implementation, and no path to one
in the current code.

Work happens in numbered sessions. This bundle was assembled at the end of
**session 25**.

## What these files are

| File | What it is |
|---|---|
| `00-START-HERE.md` | This file |
| `01-architecture-and-invariants.md` | How the system fits together and the rules that must survive every edit |
| `02-current-state.md` | What just changed, what is broken, what is queued |
| `03-measurements.md` | Every load-bearing number, with its `n`, its window, and whether it is still valid |
| `10-13-source-*.md` | Curated source, generated from the repo |
| `14-source-manifest.md` | What is and is not included |

Read `01` and `02` before answering anything substantive. `03` matters more than
it looks: this project has repeatedly been damaged by numbers quoted without
their basis, and several figures in its own history are now known to be void.

## How to be useful here

The person you are talking to has spent 25 sessions on this and knows it well.
The failure mode that costs them time is **confident wrongness**, not slowness.

**Say when you do not know.** The bundle is curated; `14-source-manifest.md`
lists what was left out. If a question turns on an omitted file, ask for it
rather than inferring from the filename.

**Do not trust a number without its provenance.** See `03`. Figures from
sessions 22 and 23 were measured on a host that was asleep for most of the
window and are void. Several digest fields from before 2026-08-08 are invalid
for reasons recorded in `02`.

**Premises in a prompt can be wrong.** Twice in session 25 a task brief asserted
something that turned out to be false — once about which defect was the exposure,
once about whether a bug required a code change to become reachable. Both times
the right move was to check cheaply, say plainly that the premise was refuted,
and work from the finding instead. That is the expected behaviour, not
insubordination.

**A quiet run is not evidence.** The distinction between "this fix was
exercised" and "this fix was not contradicted" is enforced in this project. If
the trigger for a bug never occurred, the fix is unverified regardless of how
green everything looks.

## Conventions that will come up

- **Red before green.** A fix lands with a test that failed first, for the
  stated reason.
- **Every number carries `n` and the window it was measured over.** A figure
  without both is not reportable.
- **A broken existing test is a finding.** Name it, say what it asserted, and
  say why the assertion is *stale* rather than merely inconvenient.
- **Report what you could not prove, by name.**
- Commits are long-form and explain the reasoning, not just the change. Match
  that register if asked to draft one.
- `rm -rf` only under `scratch/`.

## Vocabulary

- **gap fill** — replaying signatures missed while the process was down, using a
  per-wallet cursor
- **cold fill** — no cursor exists; history is capped at `MAX_COLD_FILL` (100)
- **warm fill** — a cursor exists; currently **unbounded**, which is the largest
  open problem
- **the barrier** — the cursor hold added in session 25 that stops a cursor
  naming a position whose predecessors are unhandled
- **soak** — a long paper run that writes a digest
- **digest** — the soak's report object; every alarm threshold lives in it
- **orphan** — an intent left `pending` by a crash; blocks all new entries until
  an operator signs it off
