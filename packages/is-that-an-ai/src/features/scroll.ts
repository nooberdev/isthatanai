// Medidas puras de scroll: funciones sobre ScrollSample[]. SIN DOM, SIN layout.
// Cada medida en [0,1] donde 1 = más probable IA.
//
// REGLA DE FUENTE (anti doble conteo): si en la ventana hay ALGUNA muestra con
// source === 1 (evento `scroll` real del documento: autoscroll del botón medio,
// teclado, scrollTo de un bot), se usan SOLO ésas y se ignoran TODAS las de
// `wheel`. Si no hay source === 1, se usan las de `wheel` (source === 0).
// El `wheel` es una intención que puede no desplazar el documento (fin de
// página, contenedor sin overflow), mientras que `source === 1` es el
// desplazamiento real: mezclarlas contaría dos veces el mismo gesto.
//
// Umbrales documentados (todas se saturan con `linear`):
// 1. deltaUniformity     - CV de |delta| por trazo: <=0.08 -> 1, >=0.5 -> 0.
// 2. intervalRegularity  - CV de intervalos por trazo: <=0.08 -> 1, >=0.5 -> 0.
// 3. directionChanges    - ratio de reversiones de signo: <=0.05 -> 1, >=0.35 -> 0.
// 4. decelerationProfile - cola/tramo inicial de |delta|: >=0.95 -> 1, <=0.5 -> 0
//                          (un trackpad humano desacelera; un bot no), multiplicado
//                          por una compuerta de suavidad: CV <=0.02 -> 1, >=0.1 -> 0.
//                          Sin esa compuerta, un humano con ruido en la rueda
//                          también parece "sin desaceleración" y daba falso positivo.
// 5. noPauses            - ratio de pausas (>2x mediana, >=150ms): 0 -> 1, >=0.3 -> 0.
// 6. roundDeltas         - ratio de deltas múltiplos de 50: >=0.95 -> 1, <=0.3 -> 0.
// 7. axisLock            - |dx|/(|dx|+|dy|) medio: <=0.02 -> 1, >=0.25 -> 0.
//
// PESOS DE SCORE (normalizados por la suma de pesos > 0): intervalRegularity
// 0.45, decelerationProfile 0.20, noPauses 0.10, directionChanges 0.10,
// deltaUniformity 0.10, roundDeltas 0.05, axisLock 0. La rueda está cuantizada
// por el dispositivo (roundDeltas apenas discrimina) y axisLock casi siempre
// es vertical incluso en humanos, así que no deben decidir el veredicto.
//
// Un "trazo" es un run de eventos separados por < 300ms. Sin evidencia ->
// NEUTRAL = 0.5. La agregación entre trazos es media ponderada por longitud.

import type { ScrollSample } from "../types";
import { clamp, linear, mean, median, stddev } from "../utils/math";

export const SCROLL_NEUTRAL = 0.5;

/** Hueco que separa trazos de scroll. */
const STROKE_GAP_MS = 300;
const WHEEL_SOURCE = 0;
const DOCUMENT_SOURCE = 1;

/** Preferencia global de fuente: gana el scroll real del documento. */
function preferredSource(samples: ScrollSample[]): ScrollSample[] {
  const documentScrolls = samples.filter((sample) => sample.source === DOCUMENT_SOURCE);
  if (documentScrolls.length > 0) return documentScrolls;
  return samples.filter((sample) => sample.source === WHEEL_SOURCE);
}

export interface ScrollFeatures {
  deltaUniformity: number;
  intervalRegularity: number;
  directionChanges: number;
  decelerationProfile: number;
  noPauses: number;
  roundDeltas: number;
  axisLock: number;
}

interface Entry {
  value: number;
  weight: number;
}

function aggregate(entries: Entry[]): number {
  let acc = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.weight <= 0) continue;
    acc += entry.value * entry.weight;
    total += entry.weight;
  }
  return total > 0 ? acc / total : SCROLL_NEUTRAL;
}

function strokesOf(samples: ScrollSample[]): ScrollSample[][] {
  const strokes: ScrollSample[][] = [];
  let current: ScrollSample[] = [];
  for (const sample of samples) {
    if (current.length > 0 && sample.t - current[current.length - 1].t > STROKE_GAP_MS) {
      strokes.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) strokes.push(current);
  return strokes;
}

function magnitude(sample: ScrollSample): number {
  return Math.sqrt(sample.dx * sample.dx + sample.dy * sample.dy);
}

function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

function intervalsOf(stroke: ScrollSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < stroke.length; i += 1) {
    const dt = stroke[i].t - stroke[i - 1].t;
    if (dt > 0) out.push(dt);
  }
  return out;
}

export function scrollDeltaUniformity(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  const entries: Entry[] = [];
  for (const stroke of strokesOf(samples)) {
    if (stroke.length < 3) continue;
    // El primer evento `scroll` no tiene estado previo y registra delta 0:
    // es un artefacto de inicialización, no ruido del dispositivo.
    const magnitudes = stroke.map(magnitude).filter((m) => m > 1e-9);
    if (magnitudes.length < 3) continue;
    entries.push({
      value: 1 - linear(cv(magnitudes), 0.08, 0.5),
      weight: magnitudes.length,
    });
  }
  return aggregate(entries);
}

export function scrollIntervalRegularity(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  const entries: Entry[] = [];
  for (const stroke of strokesOf(samples)) {
    const intervals = intervalsOf(stroke);
    if (intervals.length < 2) continue;
    entries.push({ value: 1 - linear(cv(intervals), 0.08, 0.5), weight: intervals.length });
  }
  return aggregate(entries);
}

export function scrollDirectionChanges(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  const entries: Entry[] = [];
  for (const stroke of strokesOf(samples)) {
    if (stroke.length < 3) continue;
    let changes = 0;
    let signs = 0;
    let previous = 0;
    for (const sample of stroke) {
      const sign = sample.dy > 0 ? 1 : sample.dy < 0 ? -1 : 0;
      if (sign !== 0) {
        if (signs > 0 && sign !== previous) changes += 1;
        previous = sign;
        signs += 1;
      }
    }
    if (signs < 2) continue;
    entries.push({
      value: 1 - linear(changes / (signs - 1), 0.05, 0.35),
      weight: signs,
    });
  }
  return aggregate(entries);
}

export function scrollDecelerationProfile(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  const entries: Entry[] = [];
  for (const stroke of strokesOf(samples)) {
    if (stroke.length < 6) continue;
    const magnitudes = stroke.map(magnitude).filter((m) => m > 1e-9);
    if (magnitudes.length < 6) continue;
    const third = Math.floor(magnitudes.length / 3);
    const head = mean(magnitudes.slice(0, third));
    const tail = mean(magnitudes.slice(magnitudes.length - third));
    if (head <= 1e-9) continue;
    // Compuerta de suavidad: solo una serie casi constante ofrece un perfil
    // de desaceleración fiable. Con ruido de rueda humana, cola y cabeza se
    // parecen por azar y antes puntaban como IA (falso positivo).
    const smooth = 1 - linear(cv(magnitudes), 0.02, 0.1);
    entries.push({
      value: linear(tail / head, 0.5, 0.95) * smooth,
      weight: stroke.length,
    });
  }
  return aggregate(entries);
}

export function scrollNoPauses(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length < 2) return SCROLL_NEUTRAL;
  // Umbral por debajo del hueco que separa trazos (300ms): así una pausa
  // breve cuenta como pausa sin romper el trazo de desaceleración.
  const threshold = Math.max(2 * median(intervals), 150);
  const pauses = intervals.filter((dt) => dt > threshold).length / intervals.length;
  return 1 - linear(pauses, 0, 0.3);
}

export function scrollRoundDeltas(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  if (samples.length < 3) return SCROLL_NEUTRAL;
  let round = 0;
  for (const sample of samples) {
    const m = magnitude(sample);
    if (Math.abs(m / 50 - Math.round(m / 50)) <= 0.01) round += 1;
  }
  return linear(round / samples.length, 0.3, 0.95);
}

export function scrollAxisLock(samples: ScrollSample[]): number {
  samples = preferredSource(samples);
  if (samples.length < 3) return SCROLL_NEUTRAL;
  const ratios = samples.map((sample) => {
    const ax = Math.abs(sample.dx);
    const ay = Math.abs(sample.dy);
    return ax / (ax + ay + 1e-9);
  });
  return 1 - linear(mean(ratios), 0.02, 0.25);
}

export function extractScrollFeatures(samples: ScrollSample[]): ScrollFeatures {
  return {
    deltaUniformity: scrollDeltaUniformity(samples),
    intervalRegularity: scrollIntervalRegularity(samples),
    directionChanges: scrollDirectionChanges(samples),
    decelerationProfile: scrollDecelerationProfile(samples),
    noPauses: scrollNoPauses(samples),
    roundDeltas: scrollRoundDeltas(samples),
    axisLock: scrollAxisLock(samples),
  };
}

/**
 * Pesos conservadores del score de scroll (suma 1). Ver el encabezado: la
 * rueda está cuantizada por el dispositivo y axisLock casi siempre es vertical.
 */
export const SCROLL_FEATURE_WEIGHTS = {
  deltaUniformity: 0.1,
  intervalRegularity: 0.45,
  directionChanges: 0.1,
  decelerationProfile: 0.2,
  noPauses: 0.1,
  roundDeltas: 0.05,
  axisLock: 0,
} as const satisfies Readonly<Record<keyof ScrollFeatures, number>>;

/** Score de la señal de scroll: media ponderada de las medidas con peso > 0. */
export function computeScrollScore(features: ScrollFeatures): number {
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(SCROLL_FEATURE_WEIGHTS) as Array<keyof ScrollFeatures>) {
    const weight = SCROLL_FEATURE_WEIGHTS[key];
    const value = features[key];
    if (weight > 0 && typeof value === "number" && Number.isFinite(value)) {
      weighted += weight * clamp(value, 0, 1);
      total += weight;
    }
  }
  return total > 0 ? weighted / total : SCROLL_NEUTRAL;
}

/**
 * Razones legibles para el veredicto (máximo `top`).
 * Regla: solo aparecen medidas con peso > 0 en SCROLL_FEATURE_WEIGHTS.
 * `axisLock` (peso 0) se oculta aunque valga 1: la rueda casi siempre es
 * vertical también en humanos. Se ordenan por contribución `peso × valor`,
 * no por valor, para que la medida dominante del score aparezca primero.
 */
export function scrollReasons(features: ScrollFeatures, top = 2): string[] {
  const texts: Record<keyof ScrollFeatures, string> = {
    deltaUniformity: "Desplazamientos de scroll uniformes",
    intervalRegularity: "Ritmo de scroll demasiado regular",
    directionChanges: "Scroll siempre en la misma dirección",
    decelerationProfile: "Sin desaceleración al terminar el scroll",
    noPauses: "Sin pausas entre gestos de scroll",
    roundDeltas: "Deltas de scroll numéricamente redondos",
    axisLock: "Scroll bloqueado en un solo eje",
  };
  return (Object.keys(features) as Array<keyof ScrollFeatures>)
    .map((key) => ({ key, value: features[key], weight: SCROLL_FEATURE_WEIGHTS[key] }))
    .filter((entry) => entry.weight > 0 && entry.value >= 0.55)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, top)
    .map((entry) => texts[entry.key]);
}
