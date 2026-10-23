# Ronit's Pending Tasks — Autonomous Incident Remediation Agent

## Context

The sample target app has been integrated into the Nexathon monorepo, verified locally, and deployed to Vercel. The sample app includes a Task Manager API with these routes:

- `GET /api/health`
- `GET /api/tasks`
- `GET /api/tasks/summary`

The app is intended to serve as the deliberately breakable target for the Autonomous Incident Remediation Agent.

**Important:** This checklist is based on the project requirements and progress described in our conversation. Items below are tasks to verify or complete—not claims that the features are currently missing. Inspect the actual repository and coordinate with teammates before changing shared files.

---

## Priority 1 — Confirm your sample app is ready for end-to-end incident demos

### 1. Verify the deployed baseline

- [ ] Save the deployed production URL and the immutable deployment URL for the known-good deployment.
- [ ] Confirm `/api/health`, `/api/tasks`, and `/api/tasks/summary` return the expected successful responses in the deployed environment.
- [ ] Confirm the healthy scenario is the default when no fault mode is configured.
- [ ] Confirm environment variables and fault switches are configured safely; do not expose secrets in logs or reports.
- [ ] Confirm the sample Vercel project is separate from the local controller/dashboard deployment and uses `apps/sample` as its root directory.
- [ ] Record the Git commit SHA associated with the known-good deployment.

### 2. Verify reproducible fault scenarios

- [ ] **Healthy baseline:** all monitored routes respond successfully.
- [ ] **Fresh runtime regression:** a new deployment fails the monitored route while the immediately previous deployment succeeds on the same route.
- [ ] **Persistent defect:** both the current and previous deployments fail the same probe, so rollback is not the right action and remediation should be considered.
- [ ] **Build failure:** a deployment fails during build before becoming the active production deployment; this must not trigger rollback of a healthy production deployment.
- [ ] Ensure scenarios are deterministic and easy to enable/disable for a demo.
- [ ] Ensure there is a safe recovery/reset procedure after each scenario.
- [ ] Avoid testing destructive or intentionally broken behavior against a shared production target without team agreement. Prefer a dedicated demo project or controlled test window.

### 3. Write down the demo procedure

- [ ] Document the exact steps to enable each fault mode, deploy it, observe the controller's decision, and reset the app.
- [ ] Include expected results for each scenario.
- [ ] Record the URLs and deployment identifiers needed by the controller team.
- [ ] Make sure the procedure does not rely only on a mutable production domain when comparing versions; the controller needs immutable deployment URLs for the current and previous versions.

---

## Priority 2 — Align with the controller owner on the monitoring contract

Coordinate with the teammate responsible for `apps/controller/`. Confirm the exact probe route and the integration details below.

- [ ] Choose and document the main monitored route. The project plan suggests `GET /api/tasks` as the representative route; `/api/health` can remain a basic health check.
- [ ] Confirm the controller probes the **current deployment and its immediately previous deployment using the same route**.
- [ ] Confirm the controller requires **three consecutive failed probes** before treating a runtime failure as an incident.
- [ ] Confirm deployment-status polling cadence and probe cadence are documented. The MVP plan describes route probing approximately every 30 seconds and deployment-status checks approximately every 60 seconds; treat these as targets to verify against the implementation.
- [ ] Confirm the controller can access the sample project's deployment metadata and immutable deployment URLs.
- [ ] Confirm the controller uses the intended allowlisted demo Vercel project for rollback. It must not be able to roll back arbitrary projects.
- [ ] Agree how the controller obtains the previous deployment and commit SHA.
- [ ] Confirm the controller's incident API and persistence model match the shared incident contract.
- [ ] Share your deployed URL, project identifier, deployment URL, and known-good commit SHA with the controller owner through the team's normal channel. Do not put credentials or tokens in chat.

### Shared incident contract to check

The initial project contract described these fields:

- `id`
- `kind`: `runtime_regression`, `persistent_defect`, or `build_failure`
- `status`: `detected`, `investigating`, `rolling_back`, `remediating`, `recovered`, `pr_opened`, or `needs_human`
- `detectedAt`
- `projectId`
- Optional: `deploymentId`, `deploymentUrl`, `commitSha`, `previousDeploymentUrl`, `probePath`, `evidence`, `decision`, `actionUrl`
- `decision`: `rollback`, `fix_pr`, or `escalate`
- `events`: list of `{ at, type, message }`

- [ ] Confirm the contract is checked into the shared repository and used consistently by the sample app/controller/dashboard/remediation handoff where applicable.
- [ ] Confirm the contract includes evidence and event history sufficient to explain why an action was chosen.

---

## Priority 3 — Verify guarded rollback behavior with the team

The controller owner likely implements most of this. Your responsibility is to supply a reliable target and help test the end-to-end behavior.

- [ ] Trigger a controlled fresh-regression demo: current deployment fails, previous immutable deployment passes the same probe.
- [ ] Confirm the controller checks the previous deployment before deciding to roll back.
- [ ] Confirm rollback is permitted only for the allowlisted demo project.
- [ ] Confirm rollback is blocked if there is no known-good predecessor, evidence conflicts, or the previous deployment also fails.
- [ ] Confirm at least three consecutive failed probes are required.
- [ ] Confirm only one automatic rollback attempt is allowed per incident.
- [ ] Confirm the controller verifies recovery after rollback and records the outcome.
- [ ] Confirm failed rollback verification leads to `needs_human`/escalation rather than an infinite retry loop.
- [ ] Confirm the incident record contains the evidence, decision, events, and action URL needed for a demo.
- [ ] Verify the known-good app is restored after the demo.

**Vercel safety note:** A rollback can affect which deployment is assigned to the production domain. Coordinate with the controller owner and understand the project's promotion behavior before testing. Do not assume a rollback automatically makes a repaired deployment the production version.

---

## Priority 4 — Verify persistent-defect remediation and draft PR behavior

This workflow is primarily owned by the teammate responsible for E2B/Supercharge remediation. Coordinate with them rather than duplicating their implementation.

- [ ] Create a controlled persistent-defect case in which the current and previous deployment fail the same probe.
- [ ] Confirm the controller chooses remediation or escalation, not automatic rollback.
- [ ] Confirm the remediation worker operates in an isolated E2B sandbox and has bounded execution/time limits.
- [ ] Confirm it reproduces the failure before applying a patch.
- [ ] Confirm the failing reproduction/test is captured before the patch.
- [ ] Confirm targeted tests and build pass after the patch.
- [ ] Confirm the worker opens a **draft GitHub PR** for human review.
- [ ] Confirm it never auto-merges the PR.
- [ ] Confirm missing permissions, uncertain diagnosis, sandbox failure, failed tests/build, or timeout result in escalation rather than a false success.
- [ ] Confirm the incident links to the PR and records relevant evidence/events.

---

## Priority 5 — Check dashboard, incident API, and Slack integration

These may be owned by other teammates; verify the integration instead of rebuilding their work.

- [ ] Confirm `GET /api/incidents` returns persisted incidents.
- [ ] Confirm `GET /api/incidents/:id` returns one incident and its event history.
- [ ] Confirm incidents are persisted, not held only in memory, if the project design requires persistence across controller restarts.
- [ ] Confirm the dashboard can display incident kind, status, evidence, decision, event timeline, and action/PR URL.
- [ ] Confirm Slack notifications include the incident summary, decision, verification result, and relevant links.
- [ ] Confirm notifications are sent for important transitions and do not create duplicate alert spam.
- [ ] Confirm API and Slack integration failures are visible and do not silently report success.

---

## Priority 6 — Run the acceptance-demo matrix

Run this with the team once the controller and remediation worker are integrated.

| Scenario | Required setup | Expected behavior | Pass? |
|---|---|---|---|
| Healthy baseline | Current deployment responds successfully | No incident/action | [ ] |
| Fresh regression | Current fails; previous immutable deployment passes same probe | One guarded rollback; recovery verified; Slack/report updated | [ ] |
| Persistent defect | Current and previous fail same probe | Remediation investigates; passing patch tests/build; draft PR opened, or safe escalation | [ ] |
| Failed build | New build fails before production activation | No production rollback; incident recorded/escalated as appropriate | [ ] |
| Missing predecessor | No trustworthy previous deployment | No rollback; escalate | [ ] |
| Duplicate incident | Same failure continues or repeats | No duplicate destructive action; guardrail works | [ ] |
| Rollback verification fails | Post-rollback probe still fails | No infinite retries; escalate to human | [ ] |
| Remediation failure | Sandbox/test/build/PR creation fails | No false success; escalate with evidence | [ ] |

For each scenario, capture:

- [ ] Incident ID and event timeline.
- [ ] Current and previous deployment URLs and probe results.
- [ ] The controller's decision and reason.
- [ ] Rollback or PR action result.
- [ ] Post-action verification result.
- [ ] Slack notification and dashboard evidence.

---

## Priority 7 — Keep the project safe and demo-ready

- [ ] Keep credentials in environment variables/secret storage; never commit Vercel, GitHub, Slack, or sandbox tokens.
- [ ] Keep rollback limited to the allowlisted demo project.
- [ ] Keep draft PRs human-reviewed; never auto-merge.
- [ ] Ensure uncertain evidence or failed verification leads to escalation.
- [ ] Keep the dashboard/controller separate from the target app so rolling back the target does not take down the demo interface.
- [ ] Ensure setup and demo instructions are clear enough for a teammate or judge to follow.
- [ ] Rehearse the full demo once from a clean starting state and reset to healthy production afterward.

---

## What to do next

Do **not** start implementing every item at once. First run a repository audit and ask your coding agent to report the actual state of the project.

Use this prompt:

> Audit the Nexathon Autonomous Incident Remediation Agent repository against this checklist and the existing project README/requirements. Inspect code and tests, not just documentation. For each item, report `Implemented`, `Partial`, `Missing`, or `Blocked`, with exact file paths and evidence. Identify which tasks belong to me (Ronit, `apps/sample/`, shared contract/root workspace) versus the controller, remediation, and dashboard/Slack owners. Do not modify files yet. Do not reveal secret values. Finish with the three highest-priority tasks I should personally do next.

After that audit, prioritize the gaps in this order:

1. A reliable and safe end-to-end fresh-regression → rollback → recovery demo.
2. A persistent-defect → sandbox remediation → draft PR demo.
3. The failed-build/no-rollback case and duplicate-action guardrails.
4. Dashboard/Slack polish and presentation evidence.
