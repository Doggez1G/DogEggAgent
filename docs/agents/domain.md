# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Layout for this repo

Single-context. This is a monorepo of three workspaces (`agent` / `ui` / `bridge`), but they are layers of one system sharing a single design-doc set (see `docs/superpowers/specs/` and `docs/plans/`) and one domain language — `bridge` is the shared message contract, not a separate bounded context. One `CONTEXT.md` + one `docs/adr/` at the repo root covers it.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-*.md
│   └── 0002-*.md
├── agent/
├── ui/
└── bridge/
```

If the project later grows distinct domain languages per package, switch to multi-context by adding `CONTEXT-MAP.md` at the root and per-package `CONTEXT.md` + `docs/adr/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
