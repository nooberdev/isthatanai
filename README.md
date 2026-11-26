# is that an ai? — demo y herramientas (código privado)

La librería pública está en `https://github.com/nooberdev/is-that-an-ai-library`.
Este repo contiene la demo SvelteKit y la extensión de Firefox; no es público.
El sitio compilado se publica por separado en `https://nooberdev.github.io/is-that-an-ai/`.

## Etapa 5: despliegue

El sitio público se actualiza copiando `apps/demo/build/` al repo público
`nooberdev/is-that-an-ai` (solo artefactos, sin fuentes). Pages con plan Free no
permite publicar desde un repo privado, por eso ese repo intermedio existe.

Librería de JavaScript **plug and play** que corre 100 % en el navegador (sin backend) y
detecta en tiempo real si quien controla la página es una persona o un agente de IA,
analizando el comportamiento del mouse, teclado, clicks, scroll, táctil y atención.

Incluye una página demo ultra minimalista.

> **Estado actual:** Etapas 3 y 4 terminadas. La librería captura el mouse y calcula un
> score preliminar con medidas reales; el resto de las señales siguen en el roadmap.
> La demo pública es una **beta**: el puntaje es orientativo, no una verdad absoluta.

## Promesa honesta (leer antes de usarla)

Esta librería es de código abierto y corre en el navegador del usuario: quien quiera
engañarla puede leer las reglas y probar hasta que le salga. El objetivo no es que sea
imposible de esquivar, sino que **esquivarlo sea caro**, que a veces se note y que
**nunca sea la única puerta de algo importante**.

> Detecta agentes comunes y bots sin disimular, le complica la vida a los que
> disimulan, y no detiene a un atacante dedicado que controla su propio navegador.
> Úsalo como una señal más, no como cerradura.

Lo que sí puede hacer:

- Combinar señales (mouse, clics, teclado, scroll): falsificar una es fácil; falsificar
  todas de forma consistente cuesta mucho (Etapa 10).
- Medir formas estadísticas, no reglas fijas: "velocidad constante = bot" se esquiva en
  cinco minutos; preguntarse si el ruido parece humano o son números al azar aguanta más.
- Cambiar los chequeos en cada sesión: con código abierto se ve la lista, pero igual
  hay que pasarlos todos.
- Tratar **"sin veredicto" como "no verificado", nunca como "humano"**. Hoy
  `getStats().trustedRatio` permite a la página desconfiar de eventos sintéticos;
  la señal de "sigo viva" y la detección de repeticiones llegan en la Etapa 10.
- Detectar repeticiones dentro de una sesión: una grabación humana reproducida repite
  trayectorias idénticas.
- Actualizarse cuando aparece un truco nuevo.

Lo que no haremos: ofuscar el código. En un proyecto abierto es teatro, se desarma en
minutos y solo estorba a quien quiere ayudar.

Lo que no podemos resolver:

- Una extensión o herramienta que controle el navegador de verdad y envíe eventos
  reales: se ve igual que un agente.
- Sin servidor, no podemos reconocer que la misma grabación se reutiliza en otra sesión.
- Si alguien modifica la librería en su propio navegador, no hay nada que hacer; lo
  importante siempre debe verificarse en el servidor de la web.

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

### Uso desde npm

```sh
bun add is-that-an-ai
```

```ts
import { IsThatAnAI } from "is-that-an-ai";

const detector = new IsThatAnAI({ device: "auto" });
detector.onVerdict((v) => console.log(v.state, v.score));
detector.start();
```

El paquete publica `exports` (`.` y `./iife`), `types` y solo la carpeta `dist` en `files`.

### Uso con etiqueta `<script>` (sin bundler)

Tras `bun run build`, abre `examples/script-tag.html`. El bundle IIFE expone el global
`IsThatAnAI`; la clase se usa como `new IsThatAnAI.IsThatAnAI()`:

```html
<script src="dist/index.iife.js"></script>
<script>
  const detector = new IsThatAnAI.IsThatAnAI();
  detector.start();
</script>
```

### Idiomas (i18n)

La librería incluye 12 idiomas: `en`, `es`, `fr`, `de`, `pt`, `it`, `nl`, `sv`,
`pl`, `ja`, `ko` y `zh`. El idioma por defecto es **inglés** y se detecta el del
sistema al llamar a `start()`; si no se puede detectar, se usa `en`.

```ts
import { IsThatAnAI, detectLocale, t, type Locale } from "is-that-an-ai";

const detector = new IsThatAnAI({ locale: "auto" });
detector.start();
detector.getLocale(); // p. ej. "es"
detector.configure({ locale: "fr" }); // cambia también las razones del veredicto

detectLocale("zh-TW"); // "zh"
t("reason.mouse.teleport", "de"); // razón traducida
```

Las razones de `getVerdict()` y `onVerdict()` ya llegan en el idioma activo. La
detección es SSR-safe: `navigator` solo se consulta en tiempo de ejecución.

### API avanzada (Etapa 11)

```ts
import {
  IsThatAnAI,
  autoStart,
  installGlobal,
  createReactDetector,
  createSvelteDetector,
  createVueDetector,
} from "is-that-an-ai";

const detector = new IsThatAnAI({ debug: false, customEvent: true });
detector.pause(); // congela la evaluación, mantiene los colectores
detector.resume();
detector.onThreshold(0.55, (score) => console.log("cruzó 0.55", score));
detector.disableSignals(["scroll"]);
detector.enableSignals(["scroll"]);

autoStart(); // solo en navegador; null en SSR
installGlobal(); // window.isThatAnAI
```

Con `customEvent: true`, cada cambio de estado emite `CustomEvent("isthatanai")`
en `document`. Los adaptadores `createReactDetector`, `createSvelteDetector` y
`createVueDetector` son ayudantes de ciclo de vida sin dependencias de framework.

### Tamaño

Verificado con `bun tools/check-bundle.ts` (tras `bun run build`): IIFE minificado
**198,04 KB** (lo que carga el navegador) y ESM sin minificar **346,38 KB**.
El crecimiento respecto a versiones anteriores viene de los 12 diccionarios de
idiomas, las 71 medidas del checklist, los colectores táctiles/atención y el
endurecimiento anti-ataques; el límite del IIFE se elevó a 250 KB. Las medidas
avanzadas son opt-in y no se activan por defecto.
El script comprueba también el global IIFE y los exports ESM.

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
