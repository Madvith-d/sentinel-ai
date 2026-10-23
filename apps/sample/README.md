# Sample target app — Ronit

Build the deliberately breakable Vercel target here. Start with a known-good route and a representative `/api/health` or `/api/demo` probe; add separate reproducible fresh-regression and persistent-defect scenarios. Use Bun for install, build, and tests. `vercel.json` opts Vercel Functions into its Bun runtime (Beta).

Do not put the incident dashboard in this deployment: rollback of the target must not take down the dashboard.
