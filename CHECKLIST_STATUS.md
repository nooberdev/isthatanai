# Estado final del checklist

Auditoría de `checklist.txt` (205 ideas discretas). Ya **no queda ningún ítem parcial (`~`)**.

| Estado               | Antes |   Ahora |
| -------------------- | ----: | ------: |
| Hecho y probado (IW) |    56 | **205** |
| Parcial (`~`)        |    61 |   **0** |
| No implementado      |    88 |   **0** |

**Checklist completo.** Tras Etapas 9-12 se cerraron 17 ítems (replay,
sensibilidad, accesibilidad, debug, `pause/resume`, `onThreshold`, señales
activables, adaptadores, evento DOM, `autoStart`, jitter, sorpresa, integridad,
ruido y ritmo de fórmula). La última tanda cerró los 71 restantes: 35 medidas de
mouse/click/teclado/scroll, 21 medidas y colectores táctiles/atención, 11 de
coherencia/entorno, 3 de privacidad y la recalibración desde sesión grabada.

Las medidas nuevas son **opt-in** (`advancedMeasures`) y no alteran la calibración
validada: los 8 valores del laboratorio siguen idénticos y la suite pasa con
**851 tests**. Táctil y atención se activan pasando sus opciones al detector. El detalle item por ítem está en `REAL_WORLD_AUDIT.md`.

## Ítems que eran parciales y ahora están completos (61)

Cada uno tiene código real, exportación pública y al menos un test determinista.
Las medidas nuevas de señal se registran con **peso 0 por defecto** para no alterar
los scores calibrados; se pueden activar con la configuración del scorer.

### Señales (36)

- L3 `mouseCurvature`, L4 `mouseDirectionChanges`, L7 `mouseLargeJumps`, L9 `mouseZigzag`, L15 `mouseEdgeEntries`
- L18 `mouseAverageSpeed`, L20 `mouseBellProfile`, L25 `mouseSpeedVariation`, L27 `mouseImpossibleSpeed`, L31 `mouseTemporalResolution`
- L35 `mouseSubpixel`, L36 `mouseDeviceType`
- L43 `mouseFineCorrection`, L46 `mouseClickPrecision`, L48 `mouseCorrectedMisses`
- L55 `clickInstantaneous`, L58 `clickDoubleClickRhythm`, L62 `clickSecondaryButtons`
- L71 `keyboardIntervalDistribution`, L78 `keyboardTypingSpeed`, L83 `keyboardPauseAfterError`, L84 `keyboardWordPauses`, L85 `keyboardSentenceEndPauses`
- L91 `keyboardSelectionDeletion`, L92 `keyboardArrowUsage`, L96 `keyboardAutocompleteFalsePositive`, L98 `keyboardEnterSubmit`, L100 `keyboardCapitalization`, L101 `keyboardProgrammaticKeys`
- L104 `scrollSpeed`, L112 `scrollInstantEnd`
- L141/L145/L146 `evaluateCoherence` (mezcla sospechosa, acciones sin evento previo, eventos fantasma)
- L149 `injectionRisk`, L150 `declaredVsBehavior`

Código: `packages/is-that-an-ai/src/features/{mouse,click,scroll,keyboard}.ts`,
`src/core/{coherence,injection}.ts`. Tests: `tests/partial-pointer.test.ts` (23),
`tests/partial-keyboard.test.ts` (26), `tests/partial-guardrails.test.ts` (12).

### Scoring (5)

L163 pesos configurables, L164 combinación `adaptive`, L170 detección de cambio de
controlador, L171 protección por accesibilidad (reutiliza el perfil TV/táctil),
L175 umbrales configurables. Código: `src/scoring/score.ts`, `src/core/detector.ts`.
Test: `tests/partial-api.test.ts` (26).

### API y empaquetado (9)

L182 `onChange()`, L184 `getReasons()`, L185 `getScoreBreakdown()`, L186 `reset()`,
L187 `configure()`, L188 `attachTo()`; L192 ejemplo de etiqueta `<script>`
(`examples/script-tag.html`); L193 paquete npm (`exports`/`types`/`files` en
`package.json` y README); L197 tamaño verificado (`tools/check-bundle.ts`).

### Privacidad (3)

L199 cero envío, L204 sin cookies/rastreo/huella, L208 aviso de transparencia.
Código: `src/utils/privacy-audit.ts` (`PRIVACY_NOTICE`, `privacyAudit()`).

### Anti-trampas (2)

L213 eventos inyectados (`injectionRisk`), L215 humanización falsa
(`humanizationRisk`). Código: `src/core/injection.ts`.

### Demo (6)

L219 grabación en memoria, L220 exportar/importar JSON local, L221 breakdown en
vivo, L222 visualizador del camino, L223 simulador de bot, L225 auto-test con
perfiles deterministas y aviso honesto de que no se ejecutaron agentes reales.
Código: `apps/demo/src/lib/components/sections/**` y `apps/demo/src/lib/lab/**`.

## Evidencia de validación

```
bun test                 → 851 pass, 0 fail, 316119 expect() calls, 49 files
bun run typecheck        → exit 0 (librería + svelte-check de la demo: 0 errores/0 warnings)
bun run lint             → exit 0, 0 errores (3 warnings preexistentes)
bun run build            → exit 0 (ESM + IIFE + .d.ts)
bun tools/check-bundle.ts → IIFE 200,61 KB / ESM 351,83 KB, global y exports OK
bun run --filter=demo check → 0 errores / 0 warnings
bun run --filter=demo build → exit 0 (prerender OK)
```

## Cierre de la última tanda (71 ítems)

- **35 medidas finales** en mouse/click/teclado/scroll (`MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS`, etc.), con umbrales documentados y 40 tests (`tests/final-pointer-measures.test.ts`).
- **21 señales táctiles y de atención**: colectores reales con listeners y limpieza en `src/collectors/{touch,attention}.ts`, extractores en `src/features/{touch,attention}.ts`, 36 tests (`tests/final-touch-attention.test.ts`).
- **11 de coherencia/entorno**: `evaluateCoherenceDetailed` y `evaluateEnvironment` con pistas inyectadas en runtime, 53 tests (`tests/final-coherence-environment.test.ts`).
- **3 de privacidad**: `privacy-shape.ts` (solo agregados, redondeo, DNT) y 17 tests.
- **1 de demo**: `recalibrateFromSession` en `src/calibration/recalibrate.ts`, acotado a ±20 % y fail-closed, integrado en Recorder; 17 tests de integración.

Todo se activa de forma opt-in (`advancedMeasures`, opciones `touch`/`attention`) para no tocar la calibración validada. La sección de evidencia de arriba refleja la suite final.
