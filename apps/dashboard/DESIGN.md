# Keel Dashboard Design

The dashboard is an Operate surface: a local incident control room for developers. Its visual world is a dark, instrument-like workspace with restrained color reserved for state.

## Visual system

- Backgrounds: near-black navy surfaces with a clear raised-surface hierarchy.
- Accent: teal means healthy, connected, or actionable; amber means degraded or awaiting attention; red means stopped or unsafe.
- Typography: Space Grotesk for headings and IBM Plex Sans for operational copy; monospace is reserved for revisions, routes, codes, and hosts.
- Layout: a stable incident rail beside an evidence detail pane; settings use a guided primary-provider section followed by optional configuration.
- Depth: separation comes from borders, surface changes, and spacing rather than decorative shadows or gradients.

## Interaction rules

- Keep connection and save states explicit.
- Never echo secret values after saving.
- Preserve visible keyboard focus and reduced-motion behavior.
- Keep incident state scannable before the operator reads the full timeline.
