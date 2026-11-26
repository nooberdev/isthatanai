// Medidas puras de clics: funciones sobre ClickSample[]. SIN DOM, SIN layout,
// SIN targets. Cada medida en [0,1] donde 1 = más probable IA.
//
// REGLA DE BOTÓN PRINCIPAL: todas las medidas se calculan SOLO sobre muestras
// con `button === 0`. Los eventos de botón secundario/medio se conservan en el
// buffer y se exponen en getRecentClicks(), pero se excluyen del scoring:
// pointerdown con button === 1 inicia el autoscroll del navegador y puede
// durar segundos, lo que falsearía duración, intervalos, ráfagas y deriva
// (y con ellas el score). Como consecuencia, `singleButton` vale 1 siempre
// que haya evidencia de botón principal: el propio filtro ya garantiza el
// uso exclusivo del botón primario en las muestras puntuadas.
//
// Umbrales documentados (todas las medidas se saturan con `linear`):
// 1. durationRegularity  - CV de duraciones down->up: <=0.08 -> 1, >=0.5 -> 0.
// 2. intervalRegularity  - CV de intervalos down->down: <=0.08 -> 1, >=0.5 -> 0.
// 3. burstiness          - ratio de intervalos <=150ms: >=0.95 -> 1, <=0.7 -> 0
//                          (solo ráfagas muy marcadas puntúan alto).
// 4. downUpDrift         - desplazamiento down->up medio: <=1px -> 1, >=12px -> 0.
// 5. singleButton        - ratio de muestras con button===0 (tras el filtro): 1.
// 6. noPauses            - ratio de pausas (>3x mediana, >=300ms): 0 -> 1, >=0.3 -> 0.
// 7. aimConsistency      - dispersión de la puntería respecto al paso típico:
//                          <=0.1 -> 1, >=0.5 -> 0 (mismo punto => 1). Umbral
//                          endurecido: con 0.2..1 un humano de 6 clics con
//                          posiciones variables aún daba "Puntería repetida
//                          en el mismo punto" como razón engañosa.
//
// PESOS DE SCORE (conservadores, normalizados por la suma de pesos usados):
// intervalRegularity 0.35, burstiness 0.30, aimConsistency 0.20,
// durationRegularity 0.10; downUpDrift, singleButton y noPauses = 0.
// Los tres a peso 0 no discriminan: el hardware/SO fijan la deriva y las
// pausas incluso en humanos, y `singleButton` siempre vale 1 después del
// filtro de botón principal. Ponderarlos generaba falsos positivos.
//
// Sin evidencia suficiente -> NEUTRAL = 0.5, nunca un extremo.

import type { ClickSample } from "../types";
import { clamp, linear, mean, median, stddev } from "../utils/math";

/** Valor neutro cuando no hay suficientes pares/intervalos. */
export const CLICK_NEUTRAL = 0.5;

/** Mínimo de pares down/up para considerar una medida. */
const MIN_PAIRS = 3;
const PRIMARY_BUTTON = 0;

/** Solo botón principal: el autoscroll con botón medio no puntúa. */
function primaryOnly(samples: ClickSample[]): ClickSample[] {
  return samples.filter((sample) => sample.button === PRIMARY_BUTTON);
}

export interface ClickFeatures {
  durationRegularity: number;
  intervalRegularity: number;
  burstiness: number;
  downUpDrift: number;
  singleButton: number;
  noPauses: number;
  aimConsistency: number;
}

interface ClickPair {
  down: ClickSample;
  duration: number;
  drift: number;
}

function pairsOf(samples: ClickSample[]): ClickPair[] {
  const pairs: ClickPair[] = [];
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const down = samples[i];
    const up = samples[i + 1];
    if (down.kind !== 0 || up.kind !== 1) continue;
    pairs.push({
      down,
      duration: Math.max(0, up.t - down.t),
      drift: Math.sqrt((up.x - down.x) ** 2 + (up.y - down.y) ** 2),
    });
  }
  return pairs;
}

/** Coeficiente de variación: 0 si la media es ~0 o hay menos de 2 valores. */
function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

/** Intervalos estrictamente positivos entre los inicios (down) de cada par. */
function downIntervals(pairs: ClickPair[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pairs.length; i += 1) {
    const dt = pairs[i].down.t - pairs[i - 1].down.t;
    if (dt > 0) out.push(dt);
  }
  return out;
}

/** Regularidad de la duración del clic: constante => IA. */
export function clickDurationRegularity(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  return 1 - linear(cv(pairs.map((pair) => pair.duration)), 0.08, 0.5);
}

/** Ritmo regular entre clics (down a down). */
export function clickIntervalRegularity(samples: ClickSample[]): number {
  const intervals = downIntervals(pairsOf(primaryOnly(samples)));
  if (intervals.length < 2) return CLICK_NEUTRAL;
  return 1 - linear(cv(intervals), 0.08, 0.5);
}

/** Ráfagas: muchos intervalos cortos (<=150ms) indican disparos automáticos. */
export function clickBurstiness(samples: ClickSample[]): number {
  const intervals = downIntervals(pairsOf(primaryOnly(samples)));
  if (intervals.length < 2) return CLICK_NEUTRAL;
  const rapid = intervals.filter((dt) => dt <= 150).length / intervals.length;
  return linear(rapid, 0.7, 0.95);
}

/** Deriva down->up: un agente suelta exactamente donde presionó. */
export function clickDownUpDrift(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  return 1 - linear(mean(pairs.map((pair) => pair.drift)), 1, 12);
}

/** Uso exclusivo del botón primario (tras filtrar, siempre 1 si hay muestras). */
export function clickSingleButton(samples: ClickSample[]): number {
  const primary = primaryOnly(samples);
  if (primary.length === 0) return CLICK_NEUTRAL;
  const ratio =
    primary.filter((sample) => sample.button === PRIMARY_BUTTON).length / primary.length;
  return linear(ratio, 0.8, 1);
}

/** Ausencia de pausas largas entre clics. */
export function clickNoPauses(samples: ClickSample[]): number {
  const intervals = downIntervals(pairsOf(primaryOnly(samples)));
  if (intervals.length < 2) return CLICK_NEUTRAL;
  const threshold = Math.max(3 * median(intervals), 300);
  const pauses = intervals.filter((dt) => dt > threshold).length / intervals.length;
  return 1 - linear(pauses, 0, 0.3);
}

/**
 * Puntería: dispersión de los puntos down frente al paso típico entre clics.
 * Un agente repite el mismo objetivo (dispersión ~0) => 1.
 */
export function clickAimConsistency(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  const xs = pairs.map((pair) => pair.down.x);
  const ys = pairs.map((pair) => pair.down.y);
  const cx = mean(xs);
  const cy = mean(ys);
  const meanDev = mean(
    pairs.map((pair) => Math.sqrt((pair.down.x - cx) ** 2 + (pair.down.y - cy) ** 2)),
  );
  const steps: number[] = [];
  for (let i = 1; i < pairs.length; i += 1) {
    steps.push(
      Math.sqrt(
        (pairs[i].down.x - pairs[i - 1].down.x) ** 2 + (pairs[i].down.y - pairs[i - 1].down.y) ** 2,
      ),
    );
  }
  const dispersion = meanDev / (median(steps) + 1e-9);
  return 1 - linear(dispersion, 0.1, 0.5);
}

export function extractClickFeatures(samples: ClickSample[]): ClickFeatures {
  return {
    durationRegularity: clickDurationRegularity(samples),
    intervalRegularity: clickIntervalRegularity(samples),
    burstiness: clickBurstiness(samples),
    downUpDrift: clickDownUpDrift(samples),
    singleButton: clickSingleButton(samples),
    noPauses: clickNoPauses(samples),
    aimConsistency: clickAimConsistency(samples),
  };
}

/**
 * Pesos conservadores del score de clic (suma 0.95). Normalizados por la
 * suma de pesos > 0, así que un bot perfecto da 1.
 * Ver el encabezado para la justificación de los pesos a 0.
 */
export const CLICK_FEATURE_WEIGHTS = {
  durationRegularity: 0.1,
  intervalRegularity: 0.35,
  burstiness: 0.3,
  downUpDrift: 0,
  singleButton: 0,
  noPauses: 0,
  aimConsistency: 0.2,
} as const satisfies Readonly<Record<keyof ClickFeatures, number>>;

/**
 * Score de la señal de clic: media ponderada de las medidas con peso > 0.
 * Hereda el filtro de botón principal: las medidas que recibe ya excluyen
 * las muestras con button !== 0, así que el autoscroll nunca puntúa.
 */
export function computeClickScore(features: ClickFeatures): number {
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(CLICK_FEATURE_WEIGHTS) as Array<keyof ClickFeatures>) {
    const weight = CLICK_FEATURE_WEIGHTS[key];
    const value = features[key];
    if (weight > 0 && typeof value === "number" && Number.isFinite(value)) {
      weighted += weight * clamp(value, 0, 1);
      total += weight;
    }
  }
  return total > 0 ? weighted / total : CLICK_NEUTRAL;
}

/**
 * Razones legibles para el veredicto (máximo `top`).
 * Regla: solo aparecen medidas con peso > 0 en CLICK_FEATURE_WEIGHTS, es decir,
 * las que realmente aportan al score. Las de peso 0 (deriva, botón único,
 * pausas) se ocultan aunque su valor sea 1. Se ordenan por contribución
 * `peso × valor`, no por valor: una medida regular pero poco peso no puede
 * desplazar a la señal dominante del veredicto.
 */
export function clickReasons(features: ClickFeatures, top = 2): string[] {
  const texts: Record<keyof ClickFeatures, string> = {
    durationRegularity: "Duraciones de clic casi idénticas",
    intervalRegularity: "Ritmo de clics demasiado regular",
    burstiness: "Ráfagas de clics seguidos",
    downUpDrift: "Clic sin desplazamiento al soltar",
    singleButton: "Un solo botón usado siempre",
    noPauses: "Sin pausas entre clics",
    aimConsistency: "Puntería repetida en el mismo punto",
  };
  return (Object.keys(features) as Array<keyof ClickFeatures>)
    .map((key) => ({ key, value: features[key], weight: CLICK_FEATURE_WEIGHTS[key] }))
    .filter((entry) => entry.weight > 0 && entry.value >= 0.55)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, top)
    .map((entry) => texts[entry.key]);
}
