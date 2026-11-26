// Medidas de atencion puras: funciones sobre AttentionSample[]. SIN DOM, SIN
// red, SIN almacenamiento, SIN teclas ni texto. Cada medida en [0,1],
// 1 = mas probable IA. Entrada insuficiente -> 0 (los pesos son 0, asi que el
// neutro es literalmente 0 y no altera ninguna calibracion).
//
// Codigos de muestra: 0 visible, 1 hidden, 2 focus, 3 blur, 4 resize,
// 5 idle, 6 active.
//
// Umbrales documentados (lineales entre extremos):
// 1. tabSwitches       - transiciones hidden->visible: 0 -> 0, >=5 -> 1.
// 2. background        - fraccion de tiempo hidden: 0 -> 0, >=0.50 -> 1.
// 3. focusLoss         - eventos blur: 0 -> 0, >=5 -> 1.
// 4. activeInactive    - fraccion idle/(idle+active): <=0.05 -> 1, >=0.30 -> 0
//                        (ausencia de pausas inactivas = IA).
// 5. cursorReturn      - CV de intervalos blur->focus: <=0.05 -> 1, >=0.40 -> 0.
//                        El cursor NO se registra (privacidad): el "regreso"
//                        se infiere solo del tiempo entre blur y focus.
// 6. resize            - eventos resize: 0 -> 0, >=3 -> 1.
// 7. readingTime       - ratio de visible->siguiente ACCION en <=50ms:
//                        <=0.05 -> 0, >=0.50 -> 1 (actuar sin leer).
// 8. reactionTime      - media de visible->accion tras hidden->visible:
//                        <=50ms -> 1, >=500ms -> 0.
//    "Accion" = resize (4) o active (6). focus (2) y visibilitychange (0/1)
//    NO cuentan: focus suele llegar ~10ms despues de visible sin que nadie
//    haya leido todavia, y medirlo marcaba a cualquier humano como IA.
// 9. reactionVariation - CV de esos tiempos: <=0.05 -> 1, >=0.40 -> 0.
// 10. fatigue          - pendiente normalizada de los tiempos de reaccion:
//                        <=0.02 -> 1 (sin fatiga), >=0.20 -> 0 (curva humana).
// 11. longPauses       - ratio de huecos >5000ms: 0 -> 1, >=0.10 -> 0
//                        (un bot nunca se levanta ni piensa).
//
// RENDIMIENTO: `extractAttentionFeatures` prepara el array saneado una sola vez.

import type { AttentionSample } from "../collectors/attention";
import { clamp, linear, mean, stddev } from "../utils/math";

/** Once medidas numericas; ninguna entra en el score actual (pesos 0). */
export interface AttentionFeatures {
  tabSwitches: number;
  background: number;
  focusLoss: number;
  activeInactive: number;
  cursorReturn: number;
  resize: number;
  readingTime: number;
  reactionTime: number;
  reactionVariation: number;
  fatigue: number;
  longPauses: number;
}

/** Tabla congelada: todos 0 para preservar la calibracion existente. */
export const ATTENTION_FEATURE_WEIGHTS = Object.freeze({
  tabSwitches: 0,
  background: 0,
  focusLoss: 0,
  activeInactive: 0,
  cursorReturn: 0,
  resize: 0,
  readingTime: 0,
  reactionTime: 0,
  reactionVariation: 0,
  fatigue: 0,
  longPauses: 0,
} as const satisfies Readonly<Record<keyof AttentionFeatures, number>>);

const MAX_TIME = 1e15;

function sanitize(sample: AttentionSample): AttentionSample {
  const t = Number.isFinite(sample.t) ? clamp(sample.t, -MAX_TIME, MAX_TIME) : 0;
  const kind = Number.isFinite(sample.kind) ? clamp(Math.trunc(sample.kind), 0, 6) : 0;
  return { seq: sample.seq, t: Math.max(0, t), kind, trusted: sample.trusted === 1 ? 1 : 0 };
}

function prepare(samples: AttentionSample[]): AttentionSample[] {
  return samples.map(sanitize);
}

function unit(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

/** Intervalos positivos entre muestras consecutivas. */
function gapsOf(samples: AttentionSample[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) gaps.push(dt);
  }
  return gaps;
}

/** Kinds que representan una accion real del usuario (no ruido de foco). */
const ACTION_KINDS = new Set([4, 6]); // 4 = resize, 6 = active

/**
 * Retraso desde una muestra dada hasta la PRIMERA accion real posterior.
 * focus (2), visible (0), hidden (1) e idle (5) se ignoran: son cambios de
 * estado del navegador, no interacciones del usuario. Devuelve null si no hay
 * accion posterior (sesion insuficiente -> medida neutra).
 */
function nextActionDelay(samples: AttentionSample[], visibleIndex: number): number | null {
  for (let j = visibleIndex + 1; j < samples.length; j += 1) {
    if (!ACTION_KINDS.has(samples[j].kind)) continue;
    const dt = samples[j].t - samples[visibleIndex].t;
    return dt > 0 ? dt : null;
  }
  return null;
}

/**
 * Retraso hasta la primera accion despues de que la pagina vuelve a hacerse
 * visible (hidden->visible->siguiente accion). Sin transiciones -> [].
 */
function reactionDelaysOf(samples: AttentionSample[]): number[] {
  const delays: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1].kind !== 1 || samples[i].kind !== 0) continue;
    const dt = nextActionDelay(samples, i);
    if (dt !== null) delays.push(dt);
  }
  return delays;
}

/** hidden->visible: 0 -> 0, >=5 -> 1. */
function tabSwitchesOf(samples: AttentionSample[]): number {
  let switches = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1].kind === 1 && samples[i].kind === 0) switches += 1;
  }
  return unit(linear(switches, 0, 5));
}

/** Fraccion de tiempo en segundo plano: 0 -> 0, >=0.50 -> 1. */
function backgroundOf(samples: AttentionSample[]): number {
  if (samples.length < 2) return 0;
  let hidden = 0;
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0) continue;
    total += dt;
    if (samples[i - 1].kind === 1) hidden += dt;
  }
  return total > 0 ? unit(linear(hidden / total, 0, 0.5)) : 0;
}

/** Perdidas de foco (blur): 0 -> 0, >=5 -> 1. */
function focusLossOf(samples: AttentionSample[]): number {
  let blurs = 0;
  for (const sample of samples) if (sample.kind === 3) blurs += 1;
  return unit(linear(blurs, 0, 5));
}

/** idle/(idle+active): <=0.05 -> 1, >=0.30 -> 0. Sin marcas -> 0. */
function activeInactiveOf(samples: AttentionSample[]): number {
  let idle = 0;
  let active = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0) continue;
    if (samples[i - 1].kind === 5) idle += dt;
    else if (samples[i - 1].kind === 6) active += dt;
  }
  const total = idle + active;
  return total > 0 ? unit(1 - linear(idle / total, 0.05, 0.3)) : 0;
}

/** Intervalos blur->focus; CV <=0.05 -> 1, >=0.40 -> 0. */
function cursorReturnOf(samples: AttentionSample[]): number {
  const intervals: number[] = [];
  let lastBlur: AttentionSample | null = null;
  for (const sample of samples) {
    if (sample.kind === 3) lastBlur = sample;
    else if (sample.kind === 2 && lastBlur !== null) {
      const dt = sample.t - lastBlur.t;
      if (dt > 0) intervals.push(dt);
      lastBlur = null;
    }
  }
  if (intervals.length < 2) return 0;
  return unit(1 - linear(cv(intervals), 0.05, 0.4));
}

/** Cambios de tamano de ventana: 0 -> 0, >=3 -> 1. */
function resizeOf(samples: AttentionSample[]): number {
  let resizes = 0;
  for (const sample of samples) if (sample.kind === 4) resizes += 1;
  return unit(linear(resizes, 0, 3));
}

/** Actuar en <=50ms tras hacerse visible: ratio <=0.05 -> 0, >=0.50 -> 1. */
function readingTimeOf(samples: AttentionSample[]): number {
  const delays: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].kind !== 0) continue;
    const dt = nextActionDelay(samples, i);
    if (dt !== null) delays.push(dt);
  }
  if (delays.length === 0) return 0;
  const instant = delays.filter((dt) => dt <= 50).length / delays.length;
  return unit(linear(instant, 0.05, 0.5));
}

/** Tiempo de reaccion medio: <=50ms -> 1, >=500ms -> 0. */
function reactionTimeOf(samples: AttentionSample[]): number {
  const delays = reactionDelaysOf(samples);
  if (delays.length === 0) return 0;
  return unit(1 - linear(mean(delaySafe(delays)), 50, 500));
}

/** Variabilidad de la reaccion: CV <=0.05 -> 1, >=0.40 -> 0. */
function reactionVariationOf(samples: AttentionSample[]): number {
  const delays = reactionDelaysOf(samples);
  if (delays.length < 2) return 0;
  return unit(1 - linear(cv(delaySafe(delays)), 0.05, 0.4));
}

/** Curva de cansancio: pendiente normalizada <=0.02 -> 1, >=0.20 -> 0. */
function fatigueOf(samples: AttentionSample[]): number {
  const delays = reactionDelaysOf(samples);
  if (delays.length < 4) return 0;
  const values = delaySafe(delays);
  const first = values.slice(0, Math.max(1, Math.floor(values.length / 3)));
  const last = values.slice(values.length - Math.max(1, Math.floor(values.length / 3)));
  const early = mean(first);
  const late = mean(last);
  if (early <= 1e-9) return 0;
  return unit(1 - linear((late - early) / early, 0.02, 0.2));
}

/** Pausas largas: ratio de huecos >5000ms, 0 -> 1, >=0.10 -> 0. */
function longPausesOf(samples: AttentionSample[]): number {
  const gaps = gapsOf(samples);
  if (gaps.length === 0) return 0;
  const long = gaps.filter((dt) => dt > 5000).length / gaps.length;
  return unit(1 - linear(long, 0, 0.1));
}

/** Defensa extra: intervalos no finites no pueden venir de `sanitize`, pero
 *  las medias de listas enormes podian desbordar; se acota cada valor. */
function delaySafe(delays: number[]): number[] {
  return delays.map((dt) => (Number.isFinite(dt) ? clamp(dt, 0, MAX_TIME) : 0));
}

export function attentionTabSwitches(samples: AttentionSample[]): number {
  return tabSwitchesOf(prepare(samples));
}

export function attentionBackground(samples: AttentionSample[]): number {
  return backgroundOf(prepare(samples));
}

export function attentionFocusLoss(samples: AttentionSample[]): number {
  return focusLossOf(prepare(samples));
}

export function attentionActiveInactive(samples: AttentionSample[]): number {
  return activeInactiveOf(prepare(samples));
}

export function attentionCursorReturn(samples: AttentionSample[]): number {
  return cursorReturnOf(prepare(samples));
}

export function attentionResize(samples: AttentionSample[]): number {
  return resizeOf(prepare(samples));
}

export function attentionReadingTime(samples: AttentionSample[]): number {
  return readingTimeOf(prepare(samples));
}

export function attentionReactionTime(samples: AttentionSample[]): number {
  return reactionTimeOf(prepare(samples));
}

export function attentionReactionVariation(samples: AttentionSample[]): number {
  return reactionVariationOf(prepare(samples));
}

export function attentionFatigue(samples: AttentionSample[]): number {
  return fatigueOf(prepare(samples));
}

export function attentionLongPauses(samples: AttentionSample[]): number {
  return longPausesOf(prepare(samples));
}

/** Extrae las 11 medidas en una sola pasada de saneamiento. */
export function extractAttentionFeatures(samples: AttentionSample[]): AttentionFeatures {
  const clean = prepare(samples);
  return {
    tabSwitches: tabSwitchesOf(clean),
    background: backgroundOf(clean),
    focusLoss: focusLossOf(clean),
    activeInactive: activeInactiveOf(clean),
    cursorReturn: cursorReturnOf(clean),
    resize: resizeOf(clean),
    readingTime: readingTimeOf(clean),
    reactionTime: reactionTimeOf(clean),
    reactionVariation: reactionVariationOf(clean),
    fatigue: fatigueOf(clean),
    longPauses: longPausesOf(clean),
  };
}
