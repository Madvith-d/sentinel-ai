# Remediator — Anish Kumar

Bun/TypeScript package for the **fix-PR path only**. The trusted local controller decides whether to dispatch a persistent defect or broken build. This package never performs a Vercel rollback and never merges a PR.

## Implemented

- Creates a 10-minute E2B sandbox, clones the allowlisted public `iotserver24/nexathon` repo at an exact 40-character SHA, installs **Bun 1.3.11** and runs the configured setup command.
- Requires the reproduction command to fail *before* any patch. Installs verified published **Supercharge CLI 1.3.30** in the sandbox (the hosted installer currently needs `SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases`). Configures a dedicated model provider and GitHub's remote MCP in read-only mode using a separate read-only token.
- Runs Supercharge headlessly with a prompt file, automatic tool approval **only inside E2B**, no subagents, an 18-turn cap, and a 270-second command cap. Files from GitHub, PRs and logs are untrusted inputs. Limits edited files to `apps/sample/`.
- Runs reproduction, all tests, and build again. Returns a bounded unified patch plus redacted evidence; refuses empty, binary, symlink, secret-bearing, outside-path, failed-test, or failed-build changes. Destroys the sandbox in `finally`.
- A separate **controller-only** `publishDraftPr()` revalidates the patch, clones the exact base SHA into a temporary directory, applies it, pushes `agent/incident-<id>` via a controller-only `GH_TOKEN`, and opens a **draft** PR. No write token enters E2B.

## Bun commands

From repository root:

```sh
bun install
bun run --cwd packages/remediator typecheck
bun test --cwd packages/remediator
bun run --cwd packages/remediator smoke:e2b
SMOKE_INSTALL_BUN=1 SMOKE_INSTALL_SUPERCHARGE=1 SMOKE_MCP_CONFIG=1 \
  SMOKE_CLONE_SHA=$(git rev-parse HEAD) bun run --cwd packages/remediator smoke:e2b
```

The last two commands create a short-lived **real E2B sandbox** and require `E2B_API_KEY`. The extended smoke test clones the exact pushed SHA, installs the whole Bun workspace, runs remediator typecheck/tests, and checks that published Supercharge parses its GitHub MCP configuration with a **dummy** token. It does not authenticate to GitHub MCP, call a model, or open a PR. A full fix run also needs a sample app, a failing test, a dedicated provider key, and a read-only GitHub MCP credential.

## Controller integration

Ronit should add `"@nexathon/remediator": "workspace:*"` to `apps/controller/package.json` and run `bun install` at the root before importing this package. The controller owns the incident-to-request mapping and keeps its GitHub write token locally.

```ts
import { generateFixInE2B, publishDraftPr } from '@nexathon/remediator';

const request = {
  incidentId: incident.id,
  repository: 'iotserver24/nexathon',
  commitSha: incident.commitSha, // exact 40-character SHA
  evidence: incident.evidence,   // redact and bound before dispatch
  setupCommand: 'bun install --frozen-lockfile',
  reproduceCommand: 'bun test apps/sample/tests/repro.test.ts',
  testCommand: 'bun test',
  buildCommand: 'bun run --cwd apps/sample build',
};

const fix = await generateFixInE2B(request, {
  modelName: 'dedicated-model',
  modelId: process.env.REMEDIATOR_MODEL_ID!,
  baseUrl: process.env.REMEDIATOR_MODEL_BASE_URL!, // HTTPS API root, e.g. /v1
  apiBackend: 'responses', // or chat_completions/messages, matching provider
  apiKey: process.env.REMEDIATOR_MODEL_API_KEY!,
  githubReadToken: process.env.GITHUB_READ_TOKEN!,
});

if (fix.ok) {
  const pr = await publishDraftPr(request, fix); // controller machine only; GH_TOKEN required
  // Persist pr.url, notify Slack, and leave review/merge to humans.
} else {
  // Persist fix.reason + fix.message and escalate; never open an unverified PR.
}
```

`setupCommand`, `reproduceCommand`, `testCommand`, and `buildCommand` must be **trusted project configuration**, not text taken from an alert, PR, or model output. `publishDraftPr` requires `GH_TOKEN` with Contents and Pull requests write access scoped to this repo; `GITHUB_READ_TOKEN` must be separate and read-only. Keep both and the provider key in local secrets, not `.env` committed to Git. GitHub MCP configuration uses `X-MCP-Readonly: true`, but the token itself should also have minimum permissions.

## Integration blockers / next steps

- Ronit must add the sample app, a reproducible failing-test fixture, and the controller's shared incident contract. Then connect the controller's `fix_pr` decision to `generateFixInE2B` and persist its result.
- Anish needs a **dedicated** model API credential and a read-only GitHub MCP token before the first full fix run. E2B sandbox creation, Bun install, and Supercharge CLI install have already been smoke-tested with the available E2B key; **the model-driven fix and PR creation are not yet end-to-end verified**.
- The published Supercharge release is currently 1.3.30 despite a newer locally built binary/docs. If the release changes, verify the exact installer asset and CLI flags before upgrading the pinned version.
