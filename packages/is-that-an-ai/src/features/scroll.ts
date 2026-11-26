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
// REGLA DE AUTOSCROLL (gesto humano legítimo): se excluyen del scoring las
// rachas de >= 10 muestras `source === 1` con |dy| <= 100 y mediana de
// intervalos <= 30 ms (cadencia de frame del botón medio + arrastre). No son
// evidencia de IA. COSTE ACEPTADO: un bot que imite exactamente ese patrón
// también se libra; preferimos el falso negativo antes que marcar al humano.
// Si no queda ninguna muestra tras la exclusión, la señal no tiene evidencia.
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
// 8. largeJumps          - ratio de saltos repetidos >= 300px: >=0.95 -> 1,
//                          <=0.5 -> 0 (mínimo 2 saltos). Cubre scrollTo/PageDown
//                          lentos, cuyos huecos (>300ms) dividen los trazos y
//                          dejaban las medidas de ritmo en neutro.
//
// PESOS DE SCORE (normalizados por la suma de pesos > 0): intervalRegularity
// 0.45, decelerationProfile 0.20, noPauses 0.10, directionChanges 0.10,
// deltaUniformity 0.10, roundDeltas 0.05, largeJumps 0.15 (medida específica
// de salto grande repetido, peso pequeño y no tomado de los globales), axisLock 0.
// La rueda está cuantizada por el dispositivo (roundDeltas apenas discrimina) y
// axisLock casi siempre es vertical incluso en humanos, así que no deciden.
//
// Un "trazo" es un run de eventos separados por < 300ms. Sin evidencia ->
// NEUTRAL = 0.5. La agregación entre trazos es media ponderada por longitud.

import type { ScrollSample } from "../types";
import { clamp, distance, linear, mean, median, stddev } from "../utils/math";

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

/** Mínimo de muestras de una racha para considerarla autoscroll. */
export const AUTOSCROLL_MIN_SAMPLES = 10;
/** Paso máximo por muestra en el autoscroll del botón medio. */
export const AUTOSCROLL_MAX_ABS_DY = 100;
/** Mediana de intervalos máxima (cadencia de frame, ~60fps). */
export const AUTOSCROLL_MAX_MEDIAN_DT_MS = 30;
/** Hueco que rompe una racha candidata. */
const AUTOSCROLL_RUN_GAP_MS = 100;

function isAutoscrollCandidate(sample: ScrollSample): boolean {
  return sample.source === DOCUMENT_SOURCE && Math.abs(sample.dy) <= AUTOSCROLL_MAX_ABS_DY;
}

/**
 * Excluye las rachas de autoscroll humano antes de aplicar la preferencia de
 * fuente. Ver el encabezado para el criterio y el coste (falso negativo).
 * Se exporta para que el ScoreComputer calcule la evidencia sobre las mismas
 * muestras que luego puntúan: si no queda nada, la señal es null.
 */
export function withoutAutoscroll(samples: ScrollSample[]): ScrollSample[] {
  const excluded: boolean[] = new Array(samples.length).fill(false);
  let start = 0;
  while (start < samples.length) {
    if (!isAutoscrollCandidate(samples[start])) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (
      end < samples.length &&
      isAutoscrollCandidate(samples[end]) &&
      samples[end].t - samples[end - 1].t <= AUTOSCROLL_RUN_GAP_MS
    ) {
      end += 1;
    }
    if (end - start >= AUTOSCROLL_MIN_SAMPLES) {
      const dts: number[] = [];
      for (let i = start + 1; i < end; i += 1) {
        const dt = samples[i].t - samples[i - 1].t;
        if (dt > 0) dts.push(dt);
      }
      if (dts.length > 0 && median(dts) <= AUTOSCROLL_MAX_MEDIAN_DT_MS) {
        for (let i = start; i < end; i += 1) excluded[i] = true;
      }
    }
    start = end;
  }
  return excluded.some(Boolean) ? samples.filter((_, i) => !excluded[i]) : samples;
}

// Ataque: dx/dy/t hostiles (NaN, ±Infinity, 1e308). Las cotas están muy por
// encima de un scroll real, así que las muestras normales no se alteran.
const MAX_DELTA = 1e9;
const MAX_TIME = 1e15;

function bounded(value: number, limit: number): number {
  return Number.isFinite(value) ? clamp(value, -limit, limit) : 0;
}

function sanitize(sample: ScrollSample): ScrollSample {
  return {
    ...sample,
    dx: bounded(sample.dx, MAX_DELTA),
    dy: bounded(sample.dy, MAX_DELTA),
    t: bounded(sample.t, MAX_TIME),
    source: sample.source === DOCUMENT_SOURCE ? DOCUMENT_SOURCE : WHEEL_SOURCE,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

/** Vista puntuable: sin autoscroll y con una sola fuente. */
function viewOf(samples: ScrollSample[]): ScrollSample[] {
  return preferredSource(withoutAutoscroll(samples.map(sanitize)));
}

export interface ScrollFeatures {
  deltaUniformity: number;
  intervalRegularity: number;
  directionChanges: number;
  decelerationProfile: number;
  noPauses: number;
  roundDeltas: number;
  axisLock: number;
  largeJumps: number;
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
  return distance(sample.dx, sample.dy);
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
  samples = viewOf(samples);
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
  samples = viewOf(samples);
  const entries: Entry[] = [];
  for (const stroke of strokesOf(samples)) {
    const intervals = intervalsOf(stroke);
    if (intervals.length < 2) continue;
    entries.push({ value: 1 - linear(cv(intervals), 0.08, 0.5), weight: intervals.length });
  }
  return aggregate(entries);
}

export function scrollDirectionChanges(samples: ScrollSample[]): number {
  samples = viewOf(samples);
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
  samples = viewOf(samples);
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
  samples = viewOf(samples);
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
  samples = viewOf(samples);
  if (samples.length < 3) return SCROLL_NEUTRAL;
  let round = 0;
  for (const sample of samples) {
    const m = magnitude(sample);
    if (Math.abs(m / 50 - Math.round(m / 50)) <= 0.01) round += 1;
  }
  return linear(round / samples.length, 0.3, 0.95);
}

export function scrollAxisLock(samples: ScrollSample[]): number {
  samples = viewOf(samples);
  if (samples.length < 3) return SCROLL_NEUTRAL;
  const ratios = samples.map((sample) => {
    const ax = Math.abs(sample.dx);
    const ay = Math.abs(sample.dy);
    return ax / (ax + ay + 1e-9);
  });
  return 1 - linear(mean(ratios), 0.02, 0.25);
}

/**
 * Salto grande repetido (>= 300px). Un solo salto no basta: requiere al
 * menos 2 para no penalizar un gesto aislado. Cubre `scrollTo`/PageDown
 * lentos, donde los huecos > 300ms parten los trazos y el resto de medidas
 * quedaban en neutro (score 0.575, justo sobre el umbral).
 * Thresholds: ratio >= 0.95 -> 1, <= 0.5 -> 0.
 */
export function scrollLargeJumps(samples: ScrollSample[]): number {
  samples = viewOf(samples);
  if (samples.length < 3) return SCROLL_NEUTRAL;
  const jumps = samples.filter((sample) => Math.abs(sample.dy) >= 300).length;
  if (jumps < 2) return 0;
  return linear(jumps / samples.length, 0.5, 0.95);
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
    largeJumps: scrollLargeJumps(samples),
  };
}

/**
 * Pesos conservadores del score de scroll (suma 1.15; se normalizan). Ver el encabezado: la
 * rueda está cuantizada por el dispositivo y axisLock casi siempre es vertical.
 */
// `as const` es solo compile-time: Object.freeze evita mutaciones en runtime.
export const SCROLL_FEATURE_WEIGHTS = Object.freeze({
  deltaUniformity: 0.1,
  intervalRegularity: 0.45,
  directionChanges: 0.1,
  decelerationProfile: 0.2,
  noPauses: 0.1,
  roundDeltas: 0.05,
  axisLock: 0,
  largeJumps: 0.15,
} as const satisfies Readonly<Record<keyof ScrollFeatures, number>>);

/** Score de la señal de scroll: media ponderada de las medidas con peso > 0. */
export function computeScrollScore(features: ScrollFeatures): number {
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(SCROLL_FEATURE_WEIGHTS) as Array<keyof ScrollFeatures>) {
    const weight = SCROLL_FEATURE_WEIGHTS[key];
    const value = features[key];
    if (weight > 0 && typeof value === "number" && Number.isFinite(value)) {
      // `largeJumps` es evidencia de un patrón concreto: solo entra en el
      // promedio cuando aparece. Así una rueda normal no se diluye por una
      // medida que no aplica, y un scrollTo lento sí recibe su contribución.
      if (key === "largeJumps" && value <= 0) continue;
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
    largeJumps: "Saltos grandes repetidos de desplazamiento",
  };
  return (Object.keys(features) as Array<keyof ScrollFeatures>)
    .map((key) => ({ key, value: features[key], weight: SCROLL_FEATURE_WEIGHTS[key] }))
    .filter((entry) => entry.weight > 0 && entry.value >= 0.55)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, top)
    .map((entry) => texts[entry.key]);
}

// ---------------------------------------------------------------------------
// MEDIDAS PARCIALES (índices ~ del checklist). Carril nuevo y aditivo.
//
// Interfaz y tabla de pesos propias con TODOS los pesos a 0: `ScrollFeatures`,
// `extractScrollFeatures`, el score y las razones existentes no cambian. Solo
// números de ScrollSample (dx/dy/t), sin DOM, red ni almacenamiento.
// 1 = más probable IA; evidencia insuficiente -> SCROLL_NEUTRAL = 0.5.
// ---------------------------------------------------------------------------

/** Mínimo de muestras para medir la velocidad del scroll. */
const SCROLL_SPEED_MIN_SAMPLES = 3;
/** Velocidad de scroll (px/ms): <= 1 -> 0, >= 8 -> 1; lineal entre. */
const SCROLL_SPEED_LOW = 1;
const SCROLL_SPEED_HIGH = 8;
/** "Instantáneo hasta el final": trazo de <= 2 eventos con >= 1000px. */
const INSTANT_END_MAX_SAMPLES = 2;
const INSTANT_END_MIN_PX = 1000;

/** Medidas parciales de scroll; ninguna entra en el score actual (pesos 0). */
export interface ScrollPartialFeatures {
  scrollSpeed: number;
  instantEnd: number;
}

/** Pesos del carril parcial: TODOS 0 (no cambian ningún score existente). */
// `as const` es solo compile-time: Object.freeze evita mutaciones en runtime.
export const SCROLL_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  scrollSpeed: 0,
  instantEnd: 0,
} as const satisfies Readonly<Record<keyof ScrollPartialFeatures, number>>);

/** L104 Velocidad del scroll: píxeles por milisegundo dentro de cada trazo.
 *  Thresholds: <= 1 px/ms -> 0; >= 8 px/ms -> 1; lineal entre. */
export function scrollSpeed(samples: ScrollSample[]): number {
  const view = viewOf(samples);
  if (view.length < SCROLL_SPEED_MIN_SAMPLES) return SCROLL_NEUTRAL;
  let distancePx = 0;
  let timeMs = 0;
  let count = 0;
  for (const stroke of strokesOf(view)) {
    for (let i = 1; i < stroke.length; i += 1) {
      const dt = stroke[i].t - stroke[i - 1].t;
      if (dt <= 0) continue;
      distancePx += magnitude(stroke[i]);
      timeMs += dt;
      count += 1;
    }
  }
  if (count === 0 || timeMs <= 0) return SCROLL_NEUTRAL;
  return linear(distancePx / timeMs, SCROLL_SPEED_LOW, SCROLL_SPEED_HIGH);
}

/** L112 Scroll instantáneo hasta el final: trazo muy corto (<= 2 eventos) con
 *  desplazamiento acumulado >= 1000px. Thresholds: ratio de trazos 0 -> 0,
 *  >= 0.5 -> 1; lineal entre. Sin trazos -> SCROLL_NEUTRAL. */
export function scrollInstantEnd(samples: ScrollSample[]): number {
  const strokes = strokesOf(viewOf(samples));
  if (strokes.length === 0) return SCROLL_NEUTRAL;
  let instant = 0;
  for (const stroke of strokes) {
    let total = 0;
    for (const sample of stroke) total += Math.abs(sample.dy);
    if (stroke.length <= INSTANT_END_MAX_SAMPLES && total >= INSTANT_END_MIN_PX) instant += 1;
  }
  return linear(instant / strokes.length, 0, 0.5);
}

/** Extrae las medidas parciales de scroll en una sola vista puntuable. */
export function extractPartialScrollFeatures(samples: ScrollSample[]): ScrollPartialFeatures {
  return {
    scrollSpeed: scrollSpeed(samples),
    instantEnd: scrollInstantEnd(samples),
  };
}

// ---------------------------------------------------------------------------
// CARRIL FINAL (índices L110..L111 del checklist). Aditivo, con pesos 0.
// Igual que en los otros archivos: no se amplían las tablas existentes (hay
// tests que fijan sus claves exactas). Solo números de ScrollSample (dx/dy/t).
// 1 = más IA; evidencia insuficiente -> SCROLL_NEUTRAL = 0.5.
// ---------------------------------------------------------------------------

/** Correlación de Pearson acotada a [-1, 1]; 0 sin varianza suficiente. */
function finalCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  if (dx2 <= 1e-12 || dy2 <= 1e-12) return 0;
  const r = num / Math.sqrt(dx2 * dy2);
  return Number.isFinite(r) ? clamp(r, -1, 1) : 0;
}

/** Medidas finales de scroll. Peso 0 por defecto; 1 = más IA. */
export interface ScrollFinalPartialFeatures {
  proportional: number;
  noOtherMovement: number;
}

/** Tabla de la lane final: TODOS 0 (ningún score existente la consulta). */
export const SCROLL_FINAL_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  proportional: 0,
  noOtherMovement: 0,
} as const satisfies Readonly<Record<keyof ScrollFinalPartialFeatures, number>>);

/** L110 · Scroll proporcional al contenido: el desplazamiento de una rueda
 *  humana crece con el tiempo que se dedica a desplazarse; un `scrollTo` aplica
 *  siempre el mismo salto. Correlación entre |dy| y el intervalo previo.
 *  Thresholds: |correlación| <= 0 -> 1 (salto fijo, IA), >= 0.5 -> 0. */
export function scrollProportional(samples: ScrollSample[]): number {
  const view = viewOf(samples);
  const magnitudes: number[] = [];
  const intervals: number[] = [];
  for (const stroke of strokesOf(view)) {
    for (let i = 1; i < stroke.length; i += 1) {
      const dt = stroke[i].t - stroke[i - 1].t;
      const dy = Math.abs(stroke[i].dy);
      if (dt <= 0 || dy <= 1e-9) continue;
      magnitudes.push(dy);
      intervals.push(dt);
    }
  }
  if (magnitudes.length < 4) return SCROLL_NEUTRAL;
  return 1 - linear(Math.abs(finalCorrelation(magnitudes, intervals)), 0, 0.5);
}

/** L111 · Scroll sin otro movimiento: un gesto aislado y programático llega a
 *  intervalos casi exactos; la interacción humana (rueda + otras acciones)
 *  introduces jitter. Thresholds: CV <= 0.03 -> 1 (IA), >= 0.2 -> 0. */
export function scrollNoOtherMovement(samples: ScrollSample[]): number {
  const view = viewOf(samples);
  const byStroke: number[][] = [];
  for (const stroke of strokesOf(view)) {
    const dts = intervalsOf(stroke);
    if (dts.length >= 2) byStroke.push(dts);
  }
  if (byStroke.length === 0) return SCROLL_NEUTRAL;
  let acc = 0;
  let total = 0;
  for (const intervals of byStroke) {
    const m = mean(intervals);
    if (m <= 1e-9) continue;
    const value = 1 - linear(stddev(intervals) / m, 0.03, 0.2);
    acc += value * intervals.length;
    total += intervals.length;
  }
  return total > 0 ? acc / total : SCROLL_NEUTRAL;
}

/** Extrae las 2 medidas finales de scroll en una sola vista puntuable. */
export function extractFinalScrollFeatures(samples: ScrollSample[]): ScrollFinalPartialFeatures {
  return {
    proportional: scrollProportional(samples),
    noOtherMovement: scrollNoOtherMovement(samples),
  };
}
