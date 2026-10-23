# Local controller — Ronit

The controller provides SQLite incident/probe-streak/rollback-claim storage, a read-only incidents API, a periodic worker, and a Vercel-backed runtime monitor. The monitor supports same-route current/predecessor probes, a three-failure threshold, project/recency checks, one rollback claim per deployment, and bounded post-rollback verification. The worker and rollback integration are disabled by default. Build-status polling and remediator/notifier dispatch are not wired yet.

## Run locally

From this directory:

```sh
bun run start
```

The API binds only to `127.0.0.1` (default port `8787`). Set `CONTROLLER_PORT` to change the port and `INCIDENT_DB_PATH` to change the SQLite file location. The default database is `./data/incidents.sqlite` relative to this package. Copy `.env.example` to an untracked `.env` for local configuration; monitoring and rollback remain disabled unless explicitly enabled.

- `GET /api/incidents` lists up to 500 incidents.
- `GET /api/incidents/:id` returns the incident including event history.
- Other methods are rejected; the HTTP API cannot trigger production actions.

## Tests

```sh
bun test
```

Set `CONTROLLER_MONITOR_ENABLED=true` to poll the single `VERCEL_PROJECT_ID` every 30 seconds (configurable up to 5 minutes). Supply `VERCEL_ACCESS_TOKEN`, `VERCEL_PRODUCTION_DOMAIN`, and optionally `VERCEL_TEAM_ID`. The token is used only by the local Vercel REST client and is never logged. To permit rollback, also set `CONTROLLER_ROLLBACK_ENABLED=true` and make `CONTROLLER_ROLLBACK_PROJECT_ID` exactly match `VERCEL_PROJECT_ID`; use only the dedicated demo project. Otherwise, failures are recorded/escalated without rollback. The adapter rechecks the active alias and immediate predecessor before making the rollback request. See the root README for rollback behavior and Vercel's production-domain caveat.
