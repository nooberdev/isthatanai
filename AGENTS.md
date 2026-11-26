# AGENTS.md

Single Bun workspace monorepo for **is that an ai?**.

```text
is-that-an-ai/
├── apps/demo/                  SvelteKit static demo + /docs + 12-locale UI
├── packages/is-that-an-ai/     Publishable library (v0.1.0, MIT)
├── examples/script-tag.html    Plain HTML integration example
├── tools/                      Bundle and lab-report generators
├── README.md                   Product documentation (English)
├── REPORT_FOR_CLAUDE.md        Detailed handoff report
├── CHECKLIST_STATUS.md         205/205 checklist state
├── REAL_WORLD_AUDIT.md         One-by-one audit with realistic use cases
├── LAB_REPORT.md               Honest detection table and limitations
├── ROADMAP.md                  Etapas 3–12 complete
└── SECURITY.md                 Threat model and accepted limits
```

This is a finished product, not a scaffold. All 205 checklist items are implemented
and tested. Do not reintroduce TODO stubs or "in development" language.

## Commands (run from root)

- `bun install` — installs all workspaces. Workspace deps are linked into each
  package's own `node_modules` (e.g. `apps/demo/node_modules/is-that-an-ai` →
  `packages/is-that-an-ai`), not only hoisted.
- `bun run dev` → `bun run --filter=demo dev` (Vite on `http://localhost:5173/`).
- `bun run build` → library only: ESM `dist/index.js`, minified IIFE
  `dist/index.iife.js`, global installer `dist/global.iife.js` and `.d.ts`.
- `bun run build:all` → library, then the static demo.
- `bun run typecheck` → library `tsc --noEmit` then demo `svelte-check`.
- `bun run test` → `bun test` (851 tests across 49 files).
- `bun run lint` → `biome check .` (0 errors; a few long-standing demo warnings).
- `bun run check` → typecheck + lint + test.
- `bun run verify` → build + check + package/bundle verification.
- `bun run check:package` → verifies globals, exports and bundle size limits.
- Filter syntax: `bun run --filter=<name> <script>` (names: `is-that-an-ai`, `demo`).

## Boundaries and non-obvious wiring

- Library entrypoint: `packages/is-that-an-ai/src/index.ts`. Its `exports` point to
  `./dist`, so the demo and any consumer need `bun run build` first. The demo
  declares `"is-that-an-ai": "workspace:*"` and imports it in `+page.svelte`,
  `LabPanel.svelte`, `DevicePanel.svelte`, `DevPanel.svelte` and
  `CalibrationPanel.svelte`.
- Library `tsconfig.json` includes only `src/**/*.ts`; `tests/` is excluded on
  purpose so `bun:test` types never reach `tsc`. Tests import
  `{ describe, expect, it } from "bun:test"` explicitly.
- SSR rule (binding): no `window`/`document`/`navigator` at module scope or in the
  constructor; DOM access happens inside `start()` and is cleaned up in `stop()`.
  Runtime hints are captured inside `start()` only.
- Privacy rules: no network, no persistent storage, no cookies/fingerprinting,
  never key identities or text — only timings, coordinates and numeric categories.
  Password fields are skipped without reading their value.
- New measures must be added to a frozen, zero-weight additive table and exposed
  through `advancedMeasures: true`, preserving the validated default scores. The
  eight pinned laboratory scores are an effective regression contract.
- Fail closed: no evidence, hostile config or failed integrity → `measuring`,
  never `human`.
- `checklist.txt` is now a historical backlog; `CHECKLIST_STATUS.md` is the
  authoritative status (205 implemented, 0 partial, 0 pending).

## Demo / CLI quirks (hard-won)

- Demo is Tailwind v4 + Svelte 5; global CSS is `src/routes/layout.css`.
- shadcn-svelte path aliases must be written **explicitly** in
  `apps/demo/tsconfig.json` (`$lib`, `$lib/components`, `$lib/components/ui`,
  `$lib/utils`, `$lib/hooks`). Inheriting `$app/tsconfig` alone makes `init` fail
  with "does not use an existing path alias".
- `shadcn-svelte init` has no `-y` and still prompts unless `--overwrite` is used.
  Use `bunx --bun shadcn-svelte@latest ...` from `apps/demo`; CLI v1.8.2 warns
  about Node 22+ but works under Bun here.
- Regenerate UI with `bunx --bun shadcn-svelte@latest add <names> -y` from
  `apps/demo`. Installed: `button`, `card`, `slider`, `switch`, `tabs` under
  `src/lib/components/ui/`.
- `biome.json` ignores `*.svelte` and enables `css.parser.tailwindDirectives`;
  run `bunx biome check --write .` before `bun run lint` after editing generated
  or config files.
- TypeScript versions differ by package: root/library `^5.9.3`, sv-generated
  demo `^6.0.3`; npm `latest` is 7.x — do not bump wholesale.
- Bun 1.4 ignores `--global-name` for IIFE output. The `index.iife.js` and
  `global.iife.js` bundles are built from explicit entry files that assign the
  globals; do not "simplify" those scripts back to `--global-name`.
- Deployment to GitHub Pages and `npm publish` require user credentials; they are
  deliberately not scripted here.
