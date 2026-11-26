# Laboratorio honesto — Etapa 8

> **SIMULATED PROFILES, NOT REAL-AGENT SESSIONS.**
> Perfiles **simulados**, no sesiones de agentes reales. La única fila
> `REAL-DERIVED` es un volcado **numérico** de una sesión humana de teclado
> grabada el 2026-11-26; no es una traza de agente. Nadie ejecutó a Grok Bot ni
> a otro agente para producir estas filas. Los veredictos son probabilísticos:
> esta tabla mide **qué detecta hoy la librería**, no cuánto dura en la vida real.

- Fecha: 2026-11-26
- Comandos: `bun test packages/is-that-an-ai/tests/lab-report.test.ts` y `bun tools/lab-report.ts`
- Código: `packages/is-that-an-ai/tests/lab-profiles.ts` (perfiles) y
  `tests/lab-report.test.ts` (mismas bandas, verificadas).

## Resultados medidos

| Perfil                                           | Señal              |  Score | Veredicto | ¿Detectado? | Esperado | Limitaciones                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------ | -----: | --------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SIMULATED] humano trackpad/ratón                | mouse              | 0.1580 | human     | no          | humano   | Jitter sintetizado con sinusoides: no es un trackpad real, solo imita su campana de velocidad y sus pausas.                                                                                           |
| [SIMULATED] humano clics+scroll                  | click+scroll       | 0.2199 | human     | no          | humano   | Deltas y delays muestreados con LCG: imitan la sesión E2E, no son eventos grabados.                                                                                                                   |
| [REAL-DERIVED] humano teclado                    | keyboard           | 0.0448 | human     | no          | humano   | Sesión real del 2026-11-26: mediana IKI 189ms, hold 94ms. Una sola sesión, no una población.                                                                                                          |
| [REAL-DERIVED] humano teclado REPLAY x2          | keyboard           | 0.1481 | human     | no          | humano   | La misma sesión grabada repetida dos veces: la librería actual NO compara entre sesiones, así que el replay puede pasar desapercibido.                                                                |
| [SIMULATED] bot naive mouse+clics+scroll         | mouse+click+scroll | 0.5813 | ai        | sí          | agente   | Línea recta, 16ms fijos y salto al clic; clics y wheel a cadencia exacta. El mouse solo (≈0.30) queda en duda: la detección la dan clics+scroll y el global roza AI_MIN (0.58). NO es un agente real. |
| [SIMULATED] bot naive teclado 7ms                | keyboard           | 0.7857 | ai        | sí          | agente   | IKI fijo 7ms y hold 10ms, dentro de las referencias públicas (Browser Use 5.31ms, Skyvern 9.52ms, Manus 1.39ms). Cadencia sintética, no traza de agente.                                              |
| [SIMULATED] agente humanizado mouse+clics+scroll | mouse+click+scroll | 0.1369 | human     | no          | agente   | Jitter y pausas de ciclo corto: reduce todas las medidas, pero sigue siendo un guion determinista. Puede NO detectarse.                                                                               |
| [SIMULATED] agente humanizado teclado            | keyboard           | 0.1785 | human     | no          | agente   | IKI jitterizado con pausa, pero holds de 12ms al estilo CDP. Al romper el ritmo exacto puede quedar por debajo de HUMAN_MAX: se reporta sin maquillar.                                                |

`¿Detectado?` = el veredicto fue **agente** (score ≥ 0.55). `Esperado` es la
etiqueta de origen del perfil, no un deseo: cuando `Esperado = agente` y
`¿Detectado? = no`, hay un **falso negativo** y se dice aquí.

### Desglose por señal (score 0 = humano, 1 = agente; «—» = sin evidencia)

| Perfil                   |  mouse |  click | scroll | keyboard |
| ------------------------ | -----: | -----: | -----: | -------: |
| human-mouse              | 0.1580 |      — |      — |        — |
| human-clicks-scrolls     |      — | 0.1756 | 0.2643 |        — |
| human-keyboard-recorded  |      — |      — |      — |   0.0448 |
| human-keyboard-replay    |      — |      — |      — |   0.1481 |
| naive-bot-combined       | 0.3021 | 1.0000 | 1.0000 |        — |
| naive-bot-keyboard       |      — |      — |      — |   0.7857 |
| humanized-agent-combined | 0.1597 | 0.1046 | 0.1005 |        — |
| humanized-agent-keyboard |      — |      — |      — |   0.1785 |

## Metodología

1. **Perfiles deterministas.** Generadores con LCG de semilla fija (sin
   `Math.random`, sin dependencias). Ningún dato contiene teclas, texto,
   red, storage ni DOM; solo `t`, duraciones, magnitudes y categorías 0..7.
   Toda fila se etiqueta `SIMULATED` o `REAL-DERIVED` en su propio nombre.
2. **Fuentes.** ratón/clic/scroll humanos y de bots: generadores imitando los
   perfiles ya calibrados en `tests/fleet-calibration.test.ts` y
   `tests/e2e-retune.test.ts`. Teclado humano `REAL-DERIVED`: la sesión
   grabada `calibracion-teclado(1).json` (mediana IKI 189ms, hold 94ms,
   pausas de 1000/6813ms), volcada solo como `[t, kind, category]`.
   Teclado de agente naive: IKI fijo 7ms y hold 10ms, en la banda de las
   referencias públicas (Browser Use 5.31ms, Skyvern 9.52ms, Manus 1.39ms,
   FP-Agent arXiv:2605.01247). El humano de referencia CMU tiene IKI p50 191ms.
3. **Evaluación.** Un `ScoreComputer` **nuevo por fila** (sin EMA arrastrado):
   `evaluate(mouse, windowMs, clicks, scrolls, keys, inputs)`. Se exige
   evidencia mínima por señal (10 movimientos, 10 clics, 8 scrolls, o las vías
   de teclado calibradas). Bandas: `≤ 0.25` (HUMAN_MAX) → humano,
   `≥ 0.55` (AI_MIN) → agente; entre medias, **duda** (no cuenta como éxito).
   El test además confirma el bot naive con `IsThatAnAI` usando un reloj
   `now` inyectado y eventos sintéticos ordenados por `timeStamp`.
4. **Repetibilidad.** Los mismos perfiles alimentan el test y este script a
   través de `evaluateProfile()`; las cifras de arriba son las que imprimen
   ambos, no valores reescritos a mano.

## Honestidad: lo que NO se detecta

- **Agente humanizado (2 filas): NO detectado.** Añadir
  jitter y pausas de ciclo corto rompe `exactRhythm` e
  `intervalRegularity`; las filas `humanized-agent-*` quedan en banda
  `human` con scores 0.1369 y 0.1785.
  Se contabiliza como falso negativo en la columna `Esperado`. Un agente con
  acceso al código puede disfrazarse mejor todavía.
- **Replay idéntico: NO marcado como replay.** La sesión humana real repetida
  dos veces (`human-keyboard-replay`, score
  0.1481) se clasifica como humana: la librería actual
  no compara entre sesiones. Es una limitación conocida (Etapa 10), no un
  resultado positivo.
- **Mouse del bot naive, insuficiente por sí solo:** 0.3021
  (banda de duda). La detección global del bot naive (0.5813)
  viene de clics+scroll y roza AI_MIN: un cambio de jitter podría hacerla caer
  en duda.
- **Bot naive de teclado:** 0.7857 se detecta
  porque su cadencia es perfectamente regular. Eso es una traza sintética, no
  la medición de un agente real ejecutándose aquí.
- **Muestra pequeña:** un solo sujeto humano real, y ratón/clic/scroll humano
  son simulaciones. No hay medición de falsos positivos sobre población, ni de
  dispositivos móviles/tablets, ni de accesibilidad.
- **Veredictos, no verdad:** el código corre en el navegador; un bot que lo
  parchea o que genera eventos confiables de verdad puede evadirlo. Sin
  servidor no se puede comparar una grabación entre sesiones.

## Reglas respetadas

Cero red, cero almacenamiento persistente, cero cookies/fingerprinting, nunca
se guarda qué tecla se pulsó (solo tiempos y categorías numéricas). Importar
estos módulos no toca `window`, `document` ni `navigator`.
