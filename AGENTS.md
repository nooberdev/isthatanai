# AGENTS.md

Bun workspace monorepo: `packages/*` (library `is-that-an-ai`) and `apps/*` (demo `demo`). Currently a **skeleton only** — collectors/features/scoring are TODO stubs; do not add detection, scoring or drawing logic unless asked.

## Commands (run from root)

- `bun install` — installs all workspaces. Workspace deps are linked into each package's own `node_modules` (e.g. `apps/demo/node_modules/is-that-an-ai` → `packages/is-that-an-ai`), not only hoisted to the root.
- `bun run dev` → `bun run --filter=demo dev` (Vite on `http://localhost:5173/`).
- `bun run build` → builds **the library only**: ESM `dist/index.js`, minified IIFE `dist/index.iife.js` (global `IsThatAnAI`), `.d.ts` via `tsc --emitDeclarationOnly`. The demo is built separately with its own `build` script.
- `bun run typecheck` → library `tsc --noEmit` then demo `svelte-check`. `bun run test` → `bun test`. `bun run lint` → `biome check .`.
- Filter syntax is `bun run --filter=<name> <script>` (workspace names: `is-that-an-ai`, `demo`). The demo has both `check` and `typecheck` scripts.

## Boundaries and non-obvious wiring

- Library entrypoint: `packages/is-that-an-ai/src/index.ts`. Its `exports` point to `./dist`, so any consumer importing the package needs `bun run build` first. The demo declares `"is-that-an-ai": "workspace:*"` but does not import it yet.
- Library `tsconfig.json` includes only `src/**/*.ts`; `tests/` is excluded on purpose so `bun:test` types never reach `tsc`. Tests import `{ describe, expect, it } from "bun:test"` explicitly.
- SSR rule (binding): no `window`/`document`/`navigator` at module scope or in the constructor; all DOM access inside `start()`, cleaned up in `stop()`.
- Privacy rules (see README): no network requests, no localStorage/cookies, and never record which keys were pressed — only timings.
- `checklist.txt` at the root is a 227-line idea backlog (signals, API, privacy, tools). It is not code or config.

## Demo / CLI quirks (hard-won)

- Demo is Tailwind v4 + Svelte 5; global CSS is `src/routes/layout.css`. Current shadcn-svelte CLI requires this combo.
- shadcn-svelte path aliases must be written **explicitly** in `apps/demo/tsconfig.json` (`$lib`, `$lib/components`, `$lib/components/ui`, `$lib/utils`, `$lib/hooks`). Inheriting `$app/tsconfig` alone makes `init` fail with "does not use an existing path alias".
- `shadcn-svelte init` has no `-y` and still prompts to overwrite the stylesheet unless `--overwrite` is passed. Use `bunx --bun shadcn-svelte@latest ...` from `apps/demo`; the CLI reports v1.8.2 and warns that only Node 22+ is officially supported, but works under Bun here.
- Regenerate UI with `bunx --bun shadcn-svelte@latest add <names> -y` from `apps/demo`. Installed: `button`, `card`, `slider`, `switch`, `tabs` under `src/lib/components/ui/` (generated files).
- `biome.json` ignores `*.svelte` and enables `css.parser.tailwindDirectives`; run `bunx biome check --write .` before `bun run lint` after editing generated/config files.
- TypeScript versions differ by package: root/library `^5.9.3`, sv-generated demo `^6.0.3`; npm `latest` is 7.x — do not bump wholesale.
