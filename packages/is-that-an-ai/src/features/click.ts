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
import { clamp, distance, linear, mean, median, stddev } from "../utils/math";

/** Valor neutro cuando no hay suficientes pares/intervalos. */
export const CLICK_NEUTRAL = 0.5;

/** Mínimo de pares down/up para considerar una medida. */
const MIN_PAIRS = 3;
const PRIMARY_BUTTON = 0;

// Ataque: x/y/t hostiles (NaN, ±Infinity, 1e308) desbordaban el sqrt de la
// deriva y los CV. Cotas muy por encima de cualquier clic real: los valores
// normales pasan sin cambios.
const MAX_COORD = 1e9;
const MAX_TIME = 1e15;

function bounded(value: number, limit: number): number {
  return Number.isFinite(value) ? clamp(value, -limit, limit) : 0;
}

function sanitize(sample: ClickSample): ClickSample {
  return {
    ...sample,
    x: bounded(sample.x, MAX_COORD),
    y: bounded(sample.y, MAX_COORD),
    t: bounded(sample.t, MAX_TIME),
    button: Number.isFinite(sample.button) ? sample.button : 0,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

/** Solo botón principal: el autoscroll con botón medio no puntúa. */
function primaryOnly(samples: ClickSample[]): ClickSample[] {
  return samples.filter((sample) => sample.button === PRIMARY_BUTTON).map(sanitize);
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
      // `distance` evita el desbordamiento al cuadrado de coordenadas hostiles.
      duration: Math.max(0, up.t - down.t),
      drift: distance(up.x - down.x, up.y - down.y),
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
  // `distance` acota el sqrt: los cuadrados de coordenadas hostiles desbordaban.
  const meanDev = mean(pairs.map((pair) => distance(pair.down.x - cx, pair.down.y - cy)));
  const steps: number[] = [];
  for (let i = 1; i < pairs.length; i += 1) {
    steps.push(
      distance(pairs[i].down.x - pairs[i - 1].down.x, pairs[i].down.y - pairs[i - 1].down.y),
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
// `as const` es solo compile-time: una página podría mutar la tabla en runtime.
export const CLICK_FEATURE_WEIGHTS = Object.freeze({
  durationRegularity: 0.1,
  intervalRegularity: 0.35,
  burstiness: 0.3,
  downUpDrift: 0,
  singleButton: 0,
  noPauses: 0,
  aimConsistency: 0.2,
} as const satisfies Readonly<Record<keyof ClickFeatures, number>>);

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

// ---------------------------------------------------------------------------
// MEDIDAS PARCIALES (índices ~ del checklist). Carril nuevo y aditivo.
//
// Igual que en `mouse.ts`: interfaz y tabla de pesos propias, con TODOS los
// pesos a 0, para que `ClickFeatures`, `extractClickFeatures`, el score y las
// razones existentes sigan siendo exactamente los mismos. Solo números de
// ClickSample (tiempos/botón/coordenadas), sin DOM, red ni identidad de texto.
// 1 = más probable IA; evidencia insuficiente -> CLICK_NEUTRAL = 0.5.
// ---------------------------------------------------------------------------

/** Duración máxima (ms) para considerar un clic "instantáneo" (0 ms). */
const INSTANT_CLICK_MS = 1;
/** Ventana del doble clic: intervalo down->down entre 60 y 400 ms. */
const DOUBLE_CLICK_MIN_MS = 60;
const DOUBLE_CLICK_MAX_MS = 400;

/** Medidas parciales de clic; ninguna entra en el score actual (pesos 0). */
export interface ClickPartialFeatures {
  instantaneousClick: number;
  doubleClickRhythm: number;
  secondaryButtons: number;
}

/** Pesos del carril parcial: TODOS 0 (no cambian ningún score existente). */
// `as const` es solo compile-time: Object.freeze evita mutaciones en runtime.
export const CLICK_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  instantaneousClick: 0,
  doubleClickRhythm: 0,
  secondaryButtons: 0,
} as const satisfies Readonly<Record<keyof ClickPartialFeatures, number>>);

/** L55 Click instantáneo (0 ms): ratio de pares down->up con duración <= 1ms.
 *  Thresholds: ratio 0 -> 0; >= 0.5 -> 1; lineal entre. */
export function clickInstantaneous(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  const instant = pairs.filter((pair) => pair.duration <= INSTANT_CLICK_MS).length / pairs.length;
  return linear(instant, 0, 0.5);
}

/** L58 Ritmo del doble click: si hay al menos dos intervalos dentro de la
 *  ventana de doble clic (60-400ms) y son casi idénticos, el ritmo es
 *  mecánico. Thresholds: CV <= 0.01 -> 1; >= 0.1 -> 0; lineal entre.
 *  Sin intervalos de doble clic -> 0 (un humano también hace clics simples). */
export function clickDoubleClickRhythm(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  const doubles = downIntervals(pairs).filter(
    (dt) => dt >= DOUBLE_CLICK_MIN_MS && dt <= DOUBLE_CLICK_MAX_MS,
  );
  if (doubles.length < 2) return 0;
  return 1 - linear(cv(doubles), 0.01, 0.1);
}

/** L62 Click derecho/medio: un agente usa casi siempre solo el botón primario.
 *  Se evalúan TODAS las muestras (no `primaryOnly`). Ausencia total de botones
 *  secundarios -> 1. Thresholds: ratio 0 -> 1; >= 0.05 -> 0; lineal entre. */
export function clickSecondaryButtons(samples: ClickSample[]): number {
  if (samples.length === 0) return CLICK_NEUTRAL;
  const secondary = samples.filter((sample) => sample.button !== PRIMARY_BUTTON).length;
  return 1 - linear(secondary / samples.length, 0, 0.05);
}

/** Extrae las medidas parciales de clic en una sola lectura de las muestras. */
export function extractPartialClickFeatures(samples: ClickSample[]): ClickPartialFeatures {
  return {
    instantaneousClick: clickInstantaneous(samples),
    doubleClickRhythm: clickDoubleClickRhythm(samples),
    secondaryButtons: clickSecondaryButtons(samples),
  };
}

// ---------------------------------------------------------------------------
// CARRIL FINAL (índices L60..L66 del checklist). Aditivo, con pesos 0.
//
// No amplía `ClickFeatures`, `ClickPartialFeatures` ni sus tablas: hay tests
// que fijan el número exacto de claves y el objeto literal de esas tablas.
// Solo números de ClickSample (x/y/t/button), sin DOM, targets ni texto.
// 1 = más IA; evidencia insuficiente -> CLICK_NEUTRAL = 0.5. Coste O(n log n).
// ---------------------------------------------------------------------------

/** Distancia (px) máxima para considerar "el mismo punto". */
const FINAL_SAME_POINT_PX = 1;
/** Radio (px) para agrupar posiciones de click repetidas. */
const FINAL_TARGET_RADIUS_PX = 5;
/** Deriva (px) y duración (ms) mínimas para considerar un arrastre/selección. */
const FINAL_DRAG_MIN_PX = 20;
const FINAL_SELECTION_MIN_MS = 100;

/**
 * Medidas finales de click. Todas en [0, 1] con 1 = más IA; peso 0 por defecto.
 */
export interface ClickFinalPartialFeatures {
  noPriorMovement: number;
  naturalDrag: number;
  textSelection: number;
  nonInteractive: number;
  order: number;
}

/** Tabla de la lane final: TODOS 0 (ningún score existente la consulta). */
export const CLICK_FINAL_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  noPriorMovement: 0,
  naturalDrag: 0,
  textSelection: 0,
  nonInteractive: 0,
  order: 0,
} as const satisfies Readonly<Record<keyof ClickFinalPartialFeatures, number>>);

/** L60 · Click sin movimiento previo: el down cae exactamente donde estaba el
 *  down anterior, así que no hubo trayecto que lo precediera. Se usa la
 *  posición como proxy (el colector no registra eventos `pointermove` en el
 *  buffer de clics). Thresholds: share <= 0.2 -> 0, >= 0.8 -> 1. */
export function clickNoPriorMovement(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  let still = 0;
  for (let i = 1; i < pairs.length; i += 1) {
    const drift = distance(
      pairs[i].down.x - pairs[i - 1].down.x,
      pairs[i].down.y - pairs[i - 1].down.y,
    );
    if (drift <= FINAL_SAME_POINT_PX) still += 1;
  }
  return linear(still / (pairs.length - 1), 0.2, 0.8);
}

/** L63 · Arrastrar y soltar natural: la deriva down->up de un humano varía de
 *  un gesto a otro; un bot repite exactamente la misma distancia (o nunca
 *  arrastra). Thresholds: CV <= 0.05 -> 1, >= 0.4 -> 0. */
export function clickNaturalDrag(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  const drags = pairs.map((pair) => pair.drift).filter((drift) => drift > FINAL_SAME_POINT_PX);
  if (drags.length === 0) return 1;
  if (drags.length < 2) return CLICK_NEUTRAL;
  return 1 - linear(cv(drags), 0.05, 0.4);
}

/** L64 · Selección de texto: arrastre apreciable y sostenido antes de soltar.
 *  Un bot no arrastra para seleccionar. Thresholds: share 0 -> 1,
 *  >= 0.3 -> 0 (selecciona como un humano). */
export function clickTextSelection(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  const selections = pairs.filter(
    (pair) => pair.drift >= FINAL_DRAG_MIN_PX && pair.duration >= FINAL_SELECTION_MIN_MS,
  ).length;
  return 1 - linear(selections / pairs.length, 0, 0.3);
}

/** L65 · Click en zonas no clickeables: sin acceso al DOM se usa como proxy
 *  la dispersión espacial. Quien solo pulsa objetivos repetidos cae siempre en
 *  el mismo punto; el humano explora y pulsa también zonas inertes.
 *  Thresholds: share de posiciones únicas <= 0.4 -> 1 (IA), >= 0.9 -> 0. */
export function clickNonInteractive(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < MIN_PAIRS) return CLICK_NEUTRAL;
  // Hash espacial: solo se comparan las 9 celdas vecinas de la rejilla. Cada
  // celda guarda como máximo 16 representantes, así que el coste es O(n) con
  // constante acotada incluso si todas las muestras caen en el mismo punto.
  const cell = FINAL_TARGET_RADIUS_PX;
  const maxPerCell = 16;
  const grid = new Map<string, Array<{ x: number; y: number }>>();
  let unique = 0;
  for (const pair of pairs) {
    const { x, y } = pair.down;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let seen = false;
    for (let ox = -1; ox <= 1 && !seen; ox += 1) {
      for (let oy = -1; oy <= 1 && !seen; oy += 1) {
        const neighbours = grid.get(`${gx + ox},${gy + oy}`);
        if (!neighbours) continue;
        seen = neighbours.some((point) => distance(x - point.x, y - point.y) <= cell);
      }
    }
    if (!seen) unique += 1;
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket) {
      if (bucket.length < maxPerCell) bucket.push({ x, y });
    } else {
      grid.set(key, [{ x, y }]);
    }
  }
  return 1 - linear(unique / pairs.length, 0.4, 0.9);
}

/** L66 · Orden de los clicks: recorrer la página en barrido monótono (lista de
 *  tareas) delata a un bot; el humano salta entre zonas. Se mide la mayor
 *  consistencia de signo entre posiciones consecutivas en X o en Y.
 *  Thresholds: consistencia <= 0.5 -> 0, >= 0.95 -> 1. */
export function clickOrder(samples: ClickSample[]): number {
  const pairs = pairsOf(primaryOnly(samples));
  if (pairs.length < 3) return CLICK_NEUTRAL;
  let xPos = 0;
  let xNeg = 0;
  let yPos = 0;
  let yNeg = 0;
  for (let i = 1; i < pairs.length; i += 1) {
    const dx = pairs[i].down.x - pairs[i - 1].down.x;
    const dy = pairs[i].down.y - pairs[i - 1].down.y;
    if (dx > FINAL_SAME_POINT_PX) xPos += 1;
    else if (dx < -FINAL_SAME_POINT_PX) xNeg += 1;
    if (dy > FINAL_SAME_POINT_PX) yPos += 1;
    else if (dy < -FINAL_SAME_POINT_PX) yNeg += 1;
  }
  const total = pairs.length - 1;
  const consistency = Math.max(Math.abs(xPos - xNeg), Math.abs(yPos - yNeg)) / total;
  return linear(consistency, 0.5, 0.95);
}

/** Extrae las 5 medidas finales de click en una sola lectura. */
export function extractFinalClickFeatures(samples: ClickSample[]): ClickFinalPartialFeatures {
  return {
    noPriorMovement: clickNoPriorMovement(samples),
    naturalDrag: clickNaturalDrag(samples),
    textSelection: clickTextSelection(samples),
    nonInteractive: clickNonInteractive(samples),
    order: clickOrder(samples),
  };
}

// ---------------------------------------------------------------------------
// CARRIL OPT-IN (índices L61 y L67 del checklist). Aditivo, con pesos 0.
//
// No amplía ninguna de las tablas anteriores (hay tests que fijan su número
// exacto de claves). Solo números de ClickSample: `t` es event.timeStamp
// medido desde el origen de la navegación, así que el primer `down` es, por
// sí mismo, el tiempo transcurrido desde la carga de la página. Sin DOM, red,
// almacenamiento ni identidad de texto. 1 = más IA; sin evidencia -> 0.5.
// ---------------------------------------------------------------------------

/** L61 · primer click: <= 50 ms tras la carga => 1 (IA), >= 500 ms => 0. */
const FIRST_CLICK_AI_MS = 50;
const FIRST_CLICK_HUMAN_MS = 500;
/** L67 · velocidad de clics seguidos: >= 10/s => 1 (IA), <= 5/s => 0. */
const CONSECUTIVE_SPEED_AI_PER_S = 10;
const CONSECUTIVE_SPEED_HUMAN_PER_S = 5;

/** Medidas opt-in de clic; ninguna entra en un score existente (pesos 0). */
export interface ClickOptInFeatures {
  firstClickLatency: number;
  consecutiveSpeed: number;
}

/** Tabla opt-in: TODOS 0, para no alterar scores calibrados. */
export const CLICK_OPT_IN_FEATURE_WEIGHTS = Object.freeze({
  firstClickLatency: 0,
  consecutiveSpeed: 0,
} as const satisfies Readonly<Record<keyof ClickOptInFeatures, number>>);

/** L61 · Tiempo desde la carga hasta el primer click. Un agente que dispara
 *  en cuanto el script arranca (timeStamp ~0) no pudo haber leído la página.
 *  Umbrales documentados: t <= 50ms -> 1, t >= 500ms -> 0, lineal entre. */
export function clickFirstClickLatency(samples: ClickSample[]): number {
  const primary = primaryOnly(samples);
  let first = Infinity;
  for (const sample of primary) {
    if (sample.kind === 0 && sample.t < first) first = sample.t;
  }
  if (!Number.isFinite(first)) return CLICK_NEUTRAL;
  return 1 - linear(first, FIRST_CLICK_AI_MS, FIRST_CLICK_HUMAN_MS);
}

/** L67 · Velocidad de clics seguidos, en clics/s sobre la mediana de
 *  intervalos down->down. Humanos abarcan ~2-3/s; un bucle automatizado
 *  sostiene >= 10/s. Umbrales: <= 5/s -> 0, >= 10/s -> 1, lineal entre. */
export function clickConsecutiveSpeed(samples: ClickSample[]): number {
  const intervals = downIntervals(pairsOf(primaryOnly(samples)));
  if (intervals.length < 2) return CLICK_NEUTRAL;
  const rate = 1000 / Math.max(median(intervals), 1e-9);
  return linear(rate, CONSECUTIVE_SPEED_HUMAN_PER_S, CONSECUTIVE_SPEED_AI_PER_S);
}

/** Extrae las 2 medidas opt-in en una sola lectura. */
export function extractOptInClickFeatures(samples: ClickSample[]): ClickOptInFeatures {
  return {
    firstClickLatency: clickFirstClickLatency(samples),
    consecutiveSpeed: clickConsecutiveSpeed(samples),
  };
}
