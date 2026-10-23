# Nexathon demo script

Use the fixture mode for a truthful, repeatable rehearsal when Vercel, Slack,
or the controller is unavailable. Fixture labels remain visible in the UI.

## Start the dashboard

From the repository root:

```sh
bun install
VITE_DATA_MODE=fixtures bun run --cwd apps/dashboard dev
```

For the live controller, omit `VITE_DATA_MODE=fixtures` and set
`CONTROLLER_API_URL` in `apps/dashboard/.env` to its localhost origin.

## Three-minute talk track

1. **Problem — 20 seconds.** “When a deployment breaks a route, the useful
   evidence is split across probes, deployment revisions, logs, and chat. This
   desk puts the evidence and the safety decision in one place.”

2. **Architecture — 35 seconds.** “The local controller probes the allowlisted
   Vercel project, compares the current immutable deployment with its immediate
   predecessor, and chooses rollback or a fix PR. The dashboard is read-only;
   Slack receives the same concise report.”

3. **Fresh regression — 60 seconds.** Select **Fresh runtime regression**.
   Point out three failed probes, the passing predecessor, the single guarded
   rollback, and the passing recovery probe. Call out that no code was merged.

4. **Persistent defect — 50 seconds.** Select **Persistent defect**. Show that
   both revisions fail, so rollback is skipped; then show the reproduction,
   passing targeted test/build, and draft PR link. The PR remains for human
   review.

5. **Safety — 15 seconds.** “Failed builds never roll back healthy
   production. Missing evidence, failed verification, sandbox errors, and
   notification failures escalate or remain visible instead of claiming
   success. After a Vercel rollback, a human may need to promote a repaired
   deployment before normal automatic assignment resumes.”

## Rehearsal checklist

- Confirm the dashboard shows `Rehearsal data` when fixtures are used.
- Open both rollback and draft-PR action links before presenting.
- Keep a screenshot of each fixture view as a backup; label it as fixture data.
- If Slack is unavailable, show the local report and say notification failure
  did not block recovery or PR creation.
- For the live run, verify the controller is bound to localhost and the Vercel
  project/token are the allowlisted demo resources.
