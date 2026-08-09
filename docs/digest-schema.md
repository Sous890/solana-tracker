# Digest schema versions

A digest carries `schema`. Files written before that field existed are **schema 0**.

## Schema 0 — every digest in this directory before 2026-08-08

`digest-000-final-SIGTERM.json`, `digest-000-final-deadline.json`,
`digest-000-hourly.json`, `digest-001-final-SIGTERM.json`.

**These figures are invalid and must not be compared to schema 1:**

| Field | Why |
|---|---|
| `stream.disconnects` | Summed connect-**attempt** failures with socket deaths. Across the eleven sessions on record that is 25,783 attempt failures against ~39 real deaths — the number is dominated by retries, not by the feed breaking. It also double-counts each death, because a WebSocket fires `error` and then `close` and both were counted. |
| `stream.reconnectLatencyMs` | Measured to a `reconnected` event that could fire for a socket which had **already died** inside the post-reconnect gap fill. The interval may end with no socket. `digest-001-final-SIGTERM.json`'s `p50 36113ms` is one of these. |
| `unparsedShareBps` | Measured every unparsed transaction, including the ones the parser correctly declined. Fired at 97.05% on a healthy run. Replaced by `classifiedShareBps` (printed) and `unhandledShareBps` (alarmed). |
| `filteredNonTrades` | Removed. `INFRASTRUCTURE_ONLY` is one classified code among six and needs no special case. |

`money`, `trades`, `guardRejectionsByCode`, `recorder` and the venue tallies are
unaffected and remain comparable — with the standing caveat that guard rejection
counts undercount while Task 1 is unfixed, because gates 7 and 8 throw
non-`GuardRejection` errors that are recorded as `failed` rather than counted.

The three schema-0 digests written on 2026-08-06/07 also came from runs on a
host that slept; see the environment-integrity note in the session 25 handoff.

## Schema 1 — from 2026-08-08

- `stream.socketDeaths` — sockets that were live and died. The number that says how often the feed broke.
- `stream.connectAttemptFailures` — retries that never opened a socket.
- `stream.deathEchoesCollapsed` — `error`+`close` pairs folded into one death.
- `stream.reconnectLatencyMs` — now measured to a `reconnected` that is only emitted when a socket is live and subscribed.
- `classifiedByCode` / `classifiedTotal` / `classifiedShareBps` — distribution, printed, never alarmed.
- `unhandledByCode` / `unhandledTotal` / `unhandledShareBps` — alarmed at any occurrence.
