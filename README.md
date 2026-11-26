# is that an ai?

Librería de JavaScript **plug and play** que corre 100 % en el navegador (sin backend) y
detecta en tiempo real si quien controla la página es una persona o un agente de IA,
analizando el comportamiento del mouse, teclado, clicks, scroll, táctil y atención.

Incluye una página demo ultra minimalista.

> **Estado actual:** Etapas 3 y 4 terminadas. La librería captura el mouse y calcula un
> score preliminar con medidas reales; el resto de las señales siguen en el roadmap.
> La demo pública es una **beta**: el puntaje es orientativo, no una verdad absoluta.

## Demo pública (beta)

`https://nooberdev.github.io/is-that-an-ai/`

Se publica con GitHub Pages desde `.github/workflows/deploy.yml`. La demo no tiene
backend: el veredicto y los datos quedan en el navegador. Para juntar sesiones hay un
grabador en el panel de desarrollo y una extensión de Firefox en `tools/firefox-extension/`.

## Estructura

```
is-that-an-ai/
├─ package.json                 # workspaces: packages/*, apps/*
├─ tsconfig.base.json
├─ biome.json
├─ packages/
│  └─ is-that-an-ai/            # librería TypeScript
│     ├─ src/
│     │  ├─ index.ts            # API pública
│     │  ├─ types.ts
│     │  ├─ core/               # detector.ts (clase IsThatAnAI)
│     │  ├─ collectors/         # mouse, keyboard, click, scroll, touch, attention
│     │  ├─ features/           # un extractor por señal
│     │  ├─ scoring/            # score.ts, weights.ts
│     │  └─ utils/              # math.ts, time.ts, ring-buffer.ts
│     └─ tests/
└─ apps/
   └─ demo/                     # SvelteKit + TS + Tailwind + shadcn-svelte
      └─ src/routes/+page.svelte
```

## Comandos

```sh
bun install       # instala todos los workspaces
bun run dev       # levanta la demo
bun run build     # compila la librería (ESM + IIFE minificado + .d.ts)
bun run test      # ejecuta los tests con bun test
bun run typecheck # typecheck de todos los workspaces
bun run lint      # biome check
```

La librería también puede construirse de forma aislada con `bun run --filter=is-that-an-ai build`.

## Entregables de la librería

- `dist/index.js` — ESM para npm / bundlers.
- `dist/index.iife.js` — IIFE minificado, global `IsThatAnAI`, para `<script>`.
- `dist/*.d.ts` — declaraciones de tipos.

## Reglas del proyecto

1. **Sin backend y sin red:** la librería no hace peticiones de red (fetch/XHR/WebSocket).
2. **Sin almacenamiento persistente:** no usa `localStorage`, `sessionStorage`, cookies ni
   APIs similares.
3. **Sin registrar teclas:** solo se miden tiempos (y, en su caso, conteos/ritmos). Nunca
   se guarda qué tecla se presionó.
4. **SSR-safe:** no se accede a `window`, `document` ni `navigator` al importar el módulo.
   Todo acceso al DOM ocurre dentro de `start()` (y se limpia en `stop()`).
5. Stack cerrado: Bun, TypeScript, SvelteKit, Tailwind y shadcn-svelte. No agregar
   dependencias nuevas sin preguntar antes.
