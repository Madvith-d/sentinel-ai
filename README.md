# Nexathon — Autonomous Incident Remediation Agent

> **Status: planning / work assignment.** This repository currently contains the MVP specification, not a working application. The three team members will implement the components below during a 10-hour build. Do not present planned features as already implemented.

## What we are building

A small, demonstrable DevOps agent that detects a broken Vercel deployment or a failing application route, investigates the associated GitHub revision, and takes one of two actions:

1. **Fresh regression:** The current production deployment fails, but the immediately previous deployment passes the same probe. The controller automatically rolls back the **demo project**, verifies recovery, and sends a developer report to Slack. No code is merged automatically.
2. **Persistent defect or broken build:** Rolling back would not help, or the build never reached production. An E2B sandbox runs Supercharge CLI against a cloned repository, reproduces the failure, produces a patch, runs tests/build, and creates a **draft GitHub PR** for human review. A Slack message links the incident and PR.

The local dashboard shows the evidence, decision, status, rollback or PR, and a chronological incident timeline. The Vercel app is a deliberately breakable **sample target**, not the dashboard itself.

### Honest MVP boundary

- **Detection:** Health probes every 30 seconds and Vercel deployment-status checks about every 60 seconds. Collect relevant logs when diagnosing an incident. This is **not** continuous Datadog/Sentry log-stream ingestion.
- **Hosting:** The sample app is deployed to Vercel; the controller, SQLite database, and dashboard run on a teammate's laptop during the demo. We have **E2B Pro, not Vercel Pro**; do not make Vercel paid webhooks/log drains a dependency.
- **Scope:** One explicitly configured Vercel project and this GitHub repository. No general-purpose production access, database rollback, automatic PR merge, or broad multi-tenant platform.
- **Agent:** Supercharge CLI runs headlessly *inside E2B*. Its provider/model must be configured with a **dedicated, spend-limited key** for the sandbox; do not copy anyone's personal `~/.supercharge/config.toml` into a repository or sandbox.

## Team ownership

| Person | Primary ownership | Deliverable by hour 7 | Avoid editing |
| --- | --- | --- | --- |
| **Anish Kumar** | E2B, Supercharge CLI, read-only GitHub MCP, reproduction/patch/test, draft-PR workflow | A failing persistent-bug incident produces a tested draft PR and evidence bundle | Controller decision rules and dashboard UI |
| **Ronit** | Sample Vercel app, monitoring worker, incident persistence/API, decision rules, guarded rollback | A fresh bad deployment is detected, rolled back once, and verified healthy | E2B runner and dashboard UI |
| **Madvit** | Lightweight dashboard, Slack presentation, demo script, and **PPT** | Incident timeline and Slack report work; pitch deck/demo are ready | Remediation and rollback internals |

**Workload note:** Madvit has less backend work because the PPT and presentation are a real deliverable. Anish and Ronit own the two risky engineering paths. Slack formatting can live in a separate notifier module owned by Madvit; Ronit calls it from the controller rather than both people editing the same files.

### Suggested non-overlapping directories

- Ronit: `apps/sample/`, `apps/controller/`, `packages/contracts/` and the root workspace setup.
- Anish: `packages/remediator/` (E2B/Supercharge/MCP/PR adapter and tests).
- Madvit: `apps/dashboard/`, `packages/notifier/`, `docs/demo.md` and slides outside the runtime code.

Ronit publishes the shared incident contract by the end of **hour 1**; Anish and Madvit develop against that contract and fixtures. If a contract change is needed, agree on it in the team chat before editing it.

## Hour-by-hour execution plan

Hours are elapsed hours **from the start of the hackathon build**, not clock times. At the end of each hour, push a small working commit and post a 1-minute status update in the team chat: done, next, blocker.

| Hour | Anish Kumar — E2B / Supercharge | Ronit — monitor / rollback | Madvit — UI / Slack / PPT |
| --- | --- | --- | --- |
| **0–1** | Verify E2B sandbox creation, Supercharge installation/headless invocation, and a dedicated model-provider credential. | Scaffold workspace; define shared incident contract; deploy known-good sample app to Vercel. | Sketch incident screen; outline PPT: problem, architecture, two decisions, live demo, safety. |
| **1–2** | Clone public repo in E2B; configure read-only GitHub MCP; prove repository/PR lookup. | Implement local 30-second route probe and 60-second deployment-status poll. | Build incident list/detail shell; draw architecture slide. |
| **2–3** | Create a deterministic failing test for the seeded persistent defect; capture before-patch failure. | Store incidents in SQLite with current/previous deployment URL, SHA, probe results, and timestamps. | Connect UI to shared fixture incidents; draft before/after and safety slides. |
| **3–4** | Invoke Supercharge one-shot on incident evidence; capture diff, diagnosis, test/build output. | Classify fresh regression versus persistent defect/build failure; deduplicate by deployment and failure fingerprint. | Show evidence, decision, action, and status in a readable timeline. |
| **4–5** | Push `agent/incident-<id>` branch and open a **draft PR only if reproduction fails before and passes after**. | Add project-scoped guarded Vercel rollback, one-action lock, and post-rollback probe. | Add Slack incident/PR formatting and webhook sender; complete first PPT draft. |
| **5–6** | Connect the remediator to the controller's fix dispatch; keep GitHub write credentials in controller, not E2B. | Connect persistence → decision → rollback/fix dispatch; expose read-only dashboard API. | Replace fixture UI with live API; add Slack links and real screenshots to slides. |
| **6–7** | Demonstrate older defect end to end: incident → E2B → tests → draft PR. | Demonstrate new bad deploy end to end: three failed probes → rollback → healthy probe. | Verify both incident views and Slack reports; prepare a 3-minute talk track. |
| **7–8** | Handle sandbox timeout, failed tests, invalid patch, and no-PR outcomes. | Test failed build without rollback, duplicate alerts, missing healthy predecessor, and rollback failure. | Finish small-screen UI and demo instructions; lock PPT content. |
| **8–9** | Rehearse the live fix path; leave a clean reproducible defect ready for the demo. | Reset to known-good deployment; rehearse live rollback and verify project/token scope. | Lead pitch rehearsal, collect feedback, finalize slides. **Feature freeze.** |
| **9–10** | Run the E2B/Supercharge part of a full dress rehearsal; own fix-path recovery if it fails. | Run Vercel failure/rollback part; ensure the app starts healthy. | Present the deck/dashboard, coordinate transitions, and keep a truthful screenshot backup for each flow. |

### Integration gates

- **End of hour 1:** Known-good app deployed; shared incident contract and fixture published; each person can start independently.
- **End of hour 5:** Probe/rollback, E2B patch/test/PR, and dashboard/Slack each work independently on fixture input.
- **End of hour 7:** Both live paths run through the controller and appear on dashboard/Slack.
- **End of hour 8:** No new features. Spend the final two hours on reliability and rehearsal.

If behind schedule at hour 5, **cut dashboard polish first**, then optional log enrichment. Do not cut rollback guards, the failing-before/passing-after proof, or the two end-to-end demos. A basic dashboard with a list and one detail view is enough.

## Agreed integration contract

Ronit owns the first version of `packages/contracts/`. The exact code can evolve, but every incident must expose the following information to the remediator, notifier, and dashboard:

```ts
type Incident = {
  id: string;
  kind: 'runtime_regression' | 'persistent_defect' | 'build_failure';
  status: 'detected' | 'investigating' | 'rolling_back' | 'remediating' | 'recovered' | 'pr_opened' | 'needs_human';
  detectedAt: string; // ISO 8601
  projectId: string;
  deploymentId?: string;
  deploymentUrl?: string;
  commitSha?: string;
  previousDeploymentUrl?: string;
  probePath?: string;
  evidence: string[]; // redacted, bounded messages
  decision?: 'rollback' | 'fix_pr' | 'escalate';
  actionUrl?: string; // rollback deployment or GitHub PR
  events: Array<{ at: string; type: string; message: string }>;
};
```

- **Controller → remediator:** Incident ID, repo/target SHA, redacted failure evidence, failing route or build command, and an explicit time budget. The remediator returns diagnosis, reproduction/test results, patch branch/PR URL or a failure reason. It **never** invokes Vercel rollback.
- **Controller → dashboard:** `GET /api/incidents` and `GET /api/incidents/:id`, bound to localhost for the demo. UI can refresh every few seconds; no WebSocket required.
- **Controller → notifier:** Incident state transition plus concise evidence and action URL. Slack failure must not prevent rollback verification or PR creation; record notification failure on the incident.
- **Idempotency:** One active incident per `(projectId, deploymentId, failure fingerprint)`, one rollback attempt per bad deployment, one agent PR per incident.

Do not expose an unauthenticated network endpoint that can trigger a rollback. Demo triggers and manual controls stay local to the controller machine.

## Decision and safety rules

1. **Build failed before production:** Never roll back a still-healthy production deployment. Record build evidence and attempt the fix-PR path.
2. **Runtime route failed:** Require **three consecutive failed probes** of the same representative route. Resolve the current production deployment and its immediate predecessor, then probe the predecessor's immutable URL with the **same route**.
3. **Automatic rollback only if:** The affected deployment is the current production deployment of the allowlisted demo project, it is recent relative to the first observed failure, the previous deployment passes, the current one fails, and no rollback has already been attempted for that deployment. Verify production recovery after the action.
4. **Fix PR if:** The previous deployment also fails, or the fault is a failed build, so rollback is unlikely to help. Require a failing reproduction before patching, passing targeted test and build afterward, and a bounded agent run. Leave the PR draft for humans to review.
5. **Escalate if unsure:** Missing predecessor, conflicting evidence, failed verification, failed sandbox/tests, exhausted time budget, missing permissions, or a rollback that does not restore health means `needs_human` and a Slack report—not repeated production actions.

**Important Vercel behavior:** After a rollback, automatic production-domain assignment can be disabled until a human promotes a repaired deployment. Mention this explicitly in the report and demo; do not imply that future pushes automatically restore the normal release flow.

## Demo scenarios and acceptance criteria

### A. Fresh bad deployment → rollback

Deploy a known-good revision, then deploy a revision that breaks the probed route. Within three probe failures the dashboard must show current versus previous evidence, exactly one rollback, a passing recovery probe, and a Slack developer report. No patch is merged.

### B. Persistent defect → draft fix PR

Use a defect that is reproducible on **both** current and previous deployments. The controller must not roll back. E2B/Supercharge must reproduce the failure, propose a patch, run the targeted test and build, and create a draft PR with the incident evidence and test results. Slack and dashboard link that PR.

### C. Failed build → no production rollback

Break the build of a new deployment. Show the failed deployment status and a fix attempt; the last healthy production deployment stays active.

### D. Failure/duplicate guardrails

Replay the same alert; no duplicate rollback or PR. Make predecessor lookup, sandbox, tests, Slack, or Vercel verification fail in separate tests; the incident records the reason and escalates rather than claiming success.

## Configuration checklist (implementation will add runnable commands)

This README is the assignment, **not** a claim that scripts or `.env` files already exist. When implementation lands, add an `.env.example`, documented package scripts, and precise run/deploy commands. Keep real `.env` files, provider configuration, logs containing secrets, and credentials out of Git.

- [ ] Vercel project created and linked to `apps/sample`; known-good deployment URL and immutable predecessor accessible.
- [ ] Project-scoped Vercel token available **only to the local controller**; confirm permission to inspect deployments and roll back the demo project.
- [ ] E2B API key available to the local controller; sandbox creation and cleanup verified.
- [ ] Dedicated, spend-limited model-provider key configured for Supercharge **inside each ephemeral sandbox**; no personal CLI config copied.
- [ ] GitHub MCP read-only access in sandbox; public-repo clone/search verified.
- [ ] GitHub write credential for this one repository available **only to the controller** to push branch/open draft PR.
- [ ] Slack incoming webhook available to notifier; test message sent. If unavailable, display the report locally and mark Slack integration incomplete.
- [ ] Database/incident state survives a controller restart; project allowlist and localhost binding verified.

## Git and collaboration rules

- `main` is the integration branch. Each member uses a named branch (`anish/remediator`, `ronit/controller`, `madvit/dashboard-pitch`) and opens small PRs; one person reviews another's change. Avoid direct force pushes to `main`.
- Commit small, runnable slices hourly. Do not edit another person's owned directory without asking; integrate through the shared contract.
- At the end of hours **1, 5, and 7**, perform a quick integration check together. Report blockers immediately rather than waiting for the next checkpoint.
- Do not post tokens, model keys, webhook URLs, raw sensitive logs, or sandbox config in commits, PRs, Slack summaries, or PPT screenshots.

## Demo pitch (3 minutes)

1. **Problem (20 s):** Detection and recovery are slow when engineers must correlate logs, deployments, and commits by hand.
2. **Architecture (35 s):** Probe/deployment lookup → evidence-based decision → Vercel rollback or E2B/Supercharge fix PR → human-visible dashboard/Slack.
3. **Fresh regression (60 s):** Break the live route, show three failures and healthy predecessor, one rollback, recovered route, developer report.
4. **Persistent bug (50 s):** Show no rollback; reproduce, patch, test, and open draft PR from the sandbox.
5. **Safety and next steps (15 s):** All actions are project-scoped; no automatic merge; future work is Sentry/Datadog ingestion, hosted control plane, and broader policy controls.

## Reference documentation

- [Supercharge CLI docs](https://www.superchargeai.in/docs) — installation, provider setup, one-shot `-p`, bounded `--max-turns`, permissions, and MCP configuration. Check the installed CLI's `--version`/`--help` before scripting; published docs may lag the installed build.
- [E2B documentation](https://e2b.dev/docs) — sandbox lifecycle and command execution.
- [Vercel deployment rollback](https://vercel.com/docs/deployments/rollback-production-deployment) — rollback behavior and post-rollback release implications.
- [GitHub MCP Server](https://github.com/github/github-mcp-server) — repository and PR search tools.
