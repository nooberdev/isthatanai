// Extractor de medidas de mouse: funciones puras sobre PointerSample[].
// SIN DOM. Cada medida devuelve un número en [0, 1] donde 1 = más probable IA.
//
// Segmentos: conjuntos máximos de muestras kind === 0 (movimiento).
// kind 1 (entrada) y 2 (salida) son fronteras duras: NUNCA se unen segmentos
// a través de ellas; todas las medidas operan sobre un segmento por vez.
//
// Agragación entre segmentos: media ponderada por número de pasos, no MAX:
// ninguna medida puede decidir por un segmento microscópico.
//
// Medidas (10), todas con umbrales documentados (1 = más IA, 0 = menos IA):
// 1. straightness          - eficiencia del camino: D / P (path vs displacement).
// 2. teleport              - ratio de saltos grandes (teletransporte).
// 3. speedUniformity       - 1 - CV de velocidades.
// 4. jerk                  - variabilidad del cambio de velocidad / velocidad media.
// 5. tremor                - 1 - desviación perpendicular de alta freq. a la trayectoria suavizada.
// 6. intervalRegularity    - 1 - CV de intervalos entre eventos.
// 7. overshoot             - reversión detectada: longitud del camino de los cambios de dirección > 120°
//                             normalizada por el camino total. Sin reversión -> 0.
// 8. turnSmoothness        - giros suaves (1) vs bruscos (0).
// 9. microPauses           - 1 cuando no hay pausas breves entre eventos.
// 10. roundSteps           - ratio de pasos numéricos redondos (peso reducido: false positive en mouse humano).
//
// "Sin evidencia suficiente" (segmento vacío / sin movimiento) -> NEUTRAL = 0.5,
// nunca un extremo.
//
// RENDIMIENTO: `extractMouseFeatures` prepara segmentos y pasos UNA SOLA VEZ
// y reutiliza esa estructura en las 10 medidas. Las funciones públicas siguen
// funcionando de forma independiente y producen exactamente los mismos valores.

import type { ClickSample, PointerSample } from "../types";
import { clamp, distance, linear, mean, median, stddev } from "../utils/math";

/** Valor neutro devuelto cuando no hay evidencia suficiente. */
export const NEUTRAL = 0.5;

/** Angulo de reversión: un cambio de dirección mayor que esto cuenta como reversión. */
const REVERSAL_RADIANS = (2 * Math.PI) / 3; // 120°

/** Un paso es salto si su distancia supera esta vez la mediana del segmento. */
const JUMP_DIST_RATIO = 7; // rango 6–8
/** ...y además su velocidad supera esta vez la mediana de velocidades. */
const JUMP_SPEED_RATIO = 4;
/** Guarda para no contar pasos sin movimiento (y evitar 0/0 si la mediana es 0). */
const JUMP_EPS = 1e-9;

// Ataque: coordenadas/tiempos hostiles (NaN, ±Infinity, 1e308) pueden
// desbordar las restas y las sumas de pasos. Ningún valor realista se acerca a
// estas cotas (pantalla < 1e6 px, reloj de página < 1e12 ms), así que recortar
// aquí no altera ninguna puntuación calibrada: solo acota la entrada hostil.
const MAX_COORD = 1e9;
const MAX_TIME = 1e15;

function bounded(value: number, limit: number): number {
  return Number.isFinite(value) ? clamp(value, -limit, limit) : 0;
}

function sanitize(sample: PointerSample): PointerSample {
  return {
    ...sample,
    x: bounded(sample.x, MAX_COORD),
    y: bounded(sample.y, MAX_COORD),
    t: bounded(sample.t, MAX_TIME),
    pointerType: Number.isFinite(sample.pointerType)
      ? (clamp(sample.pointerType, 0, 3) as PointerSample["pointerType"])
      : 0,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

/**
 * Medidas normalizadas de mouse. Cada campo está en [0, 1]; 1 = más probable IA.
 */
export interface MouseFeatures {
  straightness: number;
  teleport: number;
  speedUniformity: number;
  jerk: number;
  tremor: number;
  intervalRegularity: number;
  overshoot: number;
  turnSmoothness: number;
  microPauses: number;
  roundSteps: number;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

interface Step {
  dx: number;
  dy: number;
  dt: number;
}

interface PreparedSegment {
  samples: PointerSample[];
  steps: Step[];
}

function segmentsOf(samples: PointerSample[]): PointerSample[][] {
  const segments: PointerSample[][] = [];
  let current: PointerSample[] = [];
  for (const sample of samples) {
    if (sample.kind === 0) {
      current.push(sample);
    } else {
      // kind 1|2: frontera dura; nunca se une al segmento anterior.
      if (current.length > 0) segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function stepsOf(segment: PointerSample[]): Step[] {
  const out: Step[] = [];
  for (let i = 1; i < segment.length; i += 1) {
    out.push({
      dx: segment[i].x - segment[i - 1].x,
      dy: segment[i].y - segment[i - 1].y,
      dt: segment[i].t - segment[i - 1].t,
    });
  }
  return out;
}

/** Segmentos + pasos compartidos por todas las medidas de una evaluación. */
function prepareSegments(samples: PointerSample[]): PreparedSegment[] {
  return segmentsOf(samples.map(sanitize)).map((segment) => ({
    samples: segment,
    steps: stepsOf(segment),
  }));
}

/** Entry de una medida: valor en [0,1] + peso (número de pasos). */
export interface WeightedValue {
  value: number;
  weight: number;
}

/**
 * Agregación entre segmentos: media ponderada por `weight` (número de pasos),
 * así un segmento microscópico no decide el resultado.
 */
function aggregateWeighted(entries: WeightedValue[]): number {
  let acc = 0;
  let total = 0;
  for (const { value, weight } of entries) {
    if (weight <= 0) continue;
    acc += value * weight;
    total += weight;
  }
  return total > 0 ? acc / total : NEUTRAL;
}

function pathLength(steps: Step[]): number {
  let total = 0;
  for (const step of steps) total += distance(step.dx, step.dy);
  return total;
}

/** true cuando dx y dy están cerca de enteros (paso numérico redondo). */
function isRound(dx: number, dy: number, eps = 0.02): boolean {
  return Math.abs(dx - Math.round(dx)) <= eps && Math.abs(dy - Math.round(dy)) <= eps;
}

function angleDelta(a: number, b: number): number {
  let delta = Math.abs(a - b);
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
  return delta;
}

/**
 * Micro-ruido: pasos por debajo de esta fracción de la mediana del segmento son
 * temblor/subpíxel, no giros intencionales. Un cursor quieto con trackpad o con
 * zoom alto emite coords fraccionarias; sin este suelo esas micro-muestras
 * dominan los ángulos y hacen que una pausa parezca "curvatura" o "zigzag".
 */
const MICRO_STEP_RATIO = 0.15;

/** Pasos con longitud >= 15% de la mediana del segmento (descarta micro-ruido). */
function significantSteps(steps: Step[]): Step[] {
  if (steps.length < 2) return steps;
  const med = median(steps.map((step) => distance(step.dx, step.dy)));
  const floor = Math.max(1e-9, MICRO_STEP_RATIO * med);
  return steps.filter((step) => distance(step.dx, step.dy) >= floor);
}

// ---------------------------------------------------------------------------
// Medidas sobre segmentos ya preparados
// ---------------------------------------------------------------------------

/**
 * Eficiencia del camino: D / P, D = |p_end - p_start|, P = suma de pasos.
 * 1 = camino perfectamente recto; ~0.5 = muy meandroso.
 * Thresholds: D/P >= 0.95 -> 1; <= 0.55 -> 0; lineal entre.
 */
function straightnessOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { samples: segment, steps } of prepared) {
    if (steps.length < 1) continue;
    const d = distance(
      segment[segment.length - 1].x - segment[0].x,
      segment[segment.length - 1].y - segment[0].y,
    );
    const p = pathLength(steps);
    const value = p <= 1e-9 ? 1 : linear(d / p, 0.55, 0.95);
    entries.push({ value, weight: steps.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Teletransporte: ratio total de saltos / total de pasos (todos los segmentos).
 *
 * Un paso cuenta como salto solo si, DENTRO DE SU SEGMENTO:
 *   d >= 7 x mediana de distancias  Y  v = d/dt >= 4 x mediana de velocidades.
 * No hay umbrales absolutos en px ni en px/ms: al bajar el zoom del navegador
 * las coordenadas CSS se separan, pero todos los pasos escalan igual y ambos
 * ratios se mantienen. Solo un paso desproporcionado frente a sus vecinos
 * (mucha distancia en poco tiempo) cuenta como salto.
 * Thresholds: ratio >= 0.15 -> 1; <= 0.02 -> 0; lineal entre.
 */
function teleportOf(prepared: PreparedSegment[]): number {
  let jumps = 0;
  let stepsTotal = 0;
  for (const { steps } of prepared) {
    if (steps.length === 0) continue;
    // Las distancias se calculan una sola vez: las usan las dos medianas y
    // la comprobación de saltos. Mismo orden de operaciones que antes.
    const dists = steps.map((step) => distance(step.dx, step.dy));
    const medDist = median(dists);
    const speeds: number[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i].dt > 0) speeds.push(dists[i] / steps[i].dt);
    }
    const medSpeed = median(speeds);
    for (let i = 0; i < steps.length; i += 1) {
      const d = dists[i];
      const v = steps[i].dt > 0 ? d / steps[i].dt : 0;
      // Un paso sin movimiento nunca es salto; además evita 0/0 si la mediana es 0.
      if (d <= JUMP_EPS || v <= JUMP_EPS) continue;
      if (d >= JUMP_DIST_RATIO * medDist && v >= JUMP_SPEED_RATIO * medSpeed) jumps += 1;
    }
    stepsTotal += steps.length;
  }
  return stepsTotal === 0 ? NEUTRAL : linear(jumps / stepsTotal, 0.02, 0.15);
}

/**
 * Uniformidad de velocidad: 1 - CV(velocidades).
 * Velocidad constante -> CV ~ 0 -> 1; variable -> 0.
 * Thresholds: CV <= 0.15 -> 1; >= 0.7 -> 0; lineal entre.
 */
function speedUniformityOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const speeds = steps
      .filter((step) => step.dt > 0)
      .map((step) => distance(step.dx, step.dy) / step.dt);
    if (speeds.length < 2) continue;
    const m = mean(speeds);
    if (m <= 1e-9) continue;
    entries.push({ value: 1 - linear(stddev(speeds) / m, 0.15, 0.7), weight: speeds.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Jerk: variabilidad del cambio de velocidad.
 * speeds[i] = dist_i / dt_i (dt > 0). a_i = (speeds[i] - speeds[i-1]) / dt_i.
 * score = 1 - linear(stdA / (mediaV + 1e-9), 0.05, 0.3).
 */
function jerkOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const entriesStep = steps
      .filter((step) => step.dt > 0)
      .map((step) => ({ speed: distance(step.dx, step.dy) / step.dt, step }));
    if (entriesStep.length < 2) continue;
    const speeds = entriesStep.map((entry) => entry.speed);
    const accels: number[] = [];
    for (let i = 1; i < entriesStep.length; i += 1) {
      if (entriesStep[i].step.dt > 0)
        accels.push((speeds[i] - speeds[i - 1]) / entriesStep[i].step.dt);
    }
    if (accels.length < 1) continue;
    const m = mean(speeds);
    if (m <= 1e-9) continue;
    entries.push({
      value: 1 - linear(stddev(accels) / (m + 1e-9), 0.05, 0.3),
      weight: accels.length,
    });
  }
  return aggregateWeighted(entries);
}

/**
 * Poco temblor de mano: desviación PERPENDICULAR de cada punto interior a la
 * recta que une a sus dos vecinos (i-1, i+1). No es la distancia euclídea al
 * promedio: puntos colineales con espaciado desigual dan 0 (sin temblor).
 * 1 cuando la desviación media es ~0; 0 cuando >= 0.3 x stepLen.
 */
function tremorOfSegment(segment: PointerSample[]): WeightedValue | null {
  const n = segment.length;
  if (n < 3) return null;
  let totalPath = 0;
  for (let i = 1; i < n; i += 1) {
    totalPath += distance(segment[i].x - segment[i - 1].x, segment[i].y - segment[i - 1].y);
  }
  if (totalPath <= 1e-9) return null;
  const stepLen = totalPath / (n - 1);
  let totalDev = 0;
  let countDev = 0;
  // Solo puntos interiores (i-1 y i+1 existen).
  for (let i = 1; i < n - 1; i += 1) {
    const dx = segment[i + 1].x - segment[i - 1].x;
    const dy = segment[i + 1].y - segment[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    let perp: number;
    if (len <= 1e-9) {
      perp = distance(segment[i].x - segment[i - 1].x, segment[i].y - segment[i - 1].y);
    } else {
      const px = segment[i].x - segment[i - 1].x;
      const py = segment[i].y - segment[i - 1].y;
      perp = Math.abs(px * dy - py * dx) / len;
    }
    totalDev += perp;
    countDev += 1;
  }
  const tremorFactor = countDev > 0 ? totalDev / countDev / stepLen : 0;
  return { value: 1 - linear(tremorFactor, 0.05, 0.3), weight: n - 2 };
}

function tremorOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { samples: segment } of prepared) {
    const result = tremorOfSegment(segment);
    if (result) entries.push(result);
  }
  return aggregateWeighted(entries);
}

/**
 * Regularidad del intervalo entre eventos: 1 - CV(intervalos dt > 0).
 * Intervalos constantes -> 1; variabilidad -> 0.
 * Thresholds: CV <= 0.15 -> 1; >= 0.7 -> 0; lineal entre.
 */
function intervalRegularityOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const dts = steps.filter((step) => step.dt > 0).map((step) => step.dt);
    if (dts.length === 0) continue;
    const m = mean(dts);
    if (m <= 1e-9) continue;
    entries.push({ value: 1 - linear(stddev(dts) / m, 0.15, 0.7), weight: dts.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Sobrepaso: fracción REAL del camino que retrocede respecto a la dirección
 * inicial del trayecto (primer paso representativo). Solo cuentan pasos cuya
 * dirección difiere > 120° de esa referencia: la ida y vuelta y la corrección
 * fina tras pasarse del botón.
 *
 * La versión anterior sumaba TODOS los excursionLen al final, de modo que
 * `excursions === totalPath` siempre: cualquier reversión (por mínima que fuera)
 * daba exactamente 1. Ahora el valor es proporcional al retroceso real.
 * Thresholds: sqrt(backtrack / caminoTotal) <= 0.06 -> 0; >= 0.45 -> 1.
 */
function overshootOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < 2) continue;
    const lengths = steps.map((step) => distance(step.dx, step.dy));
    const totalPath = lengths.reduce((acc, length) => acc + length, 0);
    if (totalPath <= 1e-9) continue;
    const med = median(lengths);
    const reference = steps.find((step) => distance(step.dx, step.dy) >= Math.max(1e-9, med));
    if (!reference) continue;
    const forward = Math.atan2(reference.dy, reference.dx);
    let backtrack = 0;
    let reversalRuns = 0;
    let inReverse = false;
    for (let i = 0; i < steps.length; i += 1) {
      if (lengths[i] <= 1e-9) continue;
      const dir = Math.atan2(steps[i].dy, steps[i].dx);
      const reverse = angleDelta(dir, forward) > REVERSAL_RADIANS;
      if (reverse) {
        backtrack += lengths[i];
        if (!inReverse) reversalRuns += 1;
      }
      inReverse = reverse;
    }
    // Varias tandas de corrección son la señal humana fuerte que ya tenía la
    // implementación anterior (valor 1); una SOLA corrección se mide por su
    // peso real sobre el camino para no sobrepuntuar un sobrepaso de 2px.
    const value = reversalRuns >= 2 ? 1 : linear(Math.sqrt(backtrack / totalPath), 0.06, 0.45);
    entries.push({ value, weight: steps.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Suavidad de giros: 1 - max |delta de ángulo| entre pasos consecutivos.
 * Thresholds: delta <= 15° -> 1; >= 90° -> 0; lineal entre.
 */
function turnSmoothnessOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { samples: segment } of prepared) {
    if (segment.length < 3) continue;
    let maxDelta = 0;
    for (let i = 2; i < segment.length; i += 1) {
      const d0x = segment[i - 1].x - segment[i - 2].x;
      const d0y = segment[i - 1].y - segment[i - 2].y;
      const d1x = segment[i].x - segment[i - 1].x;
      const d1y = segment[i].y - segment[i - 1].y;
      const delta = angleDelta(Math.atan2(d0y, d0x), Math.atan2(d1y, d1x));
      if (delta > maxDelta) maxDelta = delta;
    }
    const value = maxDelta <= 1e-9 ? 1 : 1 - linear(maxDelta, Math.PI / 12, Math.PI / 2);
    entries.push({ value, weight: segment.length - 2 });
  }
  return aggregateWeighted(entries);
}

/**
 * Micro-pausas: intervalos dt > max(3 x mediana, 40ms).
 * score = 1 - linear(ratio, 0, 0.3). Documentado en el gestor de detección.
 */
function microPausesOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const dts = steps.map((step) => step.dt);
    if (dts.length === 0) continue;
    const med = median(dts);
    const threshold = Math.max(3 * med, 40);
    let pauses = 0;
    let total = 0;
    for (const dt of dts) {
      if (dt <= 0) continue;
      total += 1;
      if (dt > threshold) pauses += 1;
    }
    if (total === 0) continue;
    entries.push({ value: 1 - linear(pauses / total, 0, 0.3), weight: total });
  }
  return aggregateWeighted(entries);
}

/**
 * Pasos numéricos redondos: ratio de pasos cuya |dx| y |dy| están cerca de enteros.
 * Limitación documentada: mouse humano real también genera coordenadas enteras.
 * Thresholds: ratio >= 0.95 -> 1; <= 0.35 -> 0; lineal entre.
 */
function roundStepsOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length === 0) continue;
    let round = 0;
    let total = 0;
    for (const step of steps) {
      if (distance(step.dx, step.dy) <= 1e-9) continue;
      total += 1;
      if (isRound(step.dx, step.dy)) round += 1;
    }
    if (total === 0) continue;
    entries.push({ value: linear(round / total, 0.35, 0.95), weight: total });
  }
  return aggregateWeighted(entries);
}

// ---------------------------------------------------------------------------
// API pública: misma firma y mismos valores que antes
// ---------------------------------------------------------------------------

export function mouseStraightness(samples: PointerSample[]): number {
  return straightnessOf(prepareSegments(samples));
}

export function mouseTeleport(samples: PointerSample[]): number {
  return teleportOf(prepareSegments(samples));
}

export function mouseSpeedUniformity(samples: PointerSample[]): number {
  return speedUniformityOf(prepareSegments(samples));
}

export function mouseJerk(samples: PointerSample[]): number {
  return jerkOf(prepareSegments(samples));
}

export function mouseTremor(samples: PointerSample[]): number {
  return tremorOf(prepareSegments(samples));
}

export function mouseIntervalRegularity(samples: PointerSample[]): number {
  return intervalRegularityOf(prepareSegments(samples));
}

export function mouseOvershoot(samples: PointerSample[]): number {
  return overshootOf(prepareSegments(samples));
}

export function mouseTurnSmoothness(samples: PointerSample[]): number {
  return turnSmoothnessOf(prepareSegments(samples));
}

export function mouseMicroPauses(samples: PointerSample[]): number {
  return microPausesOf(prepareSegments(samples));
}

export function mouseRoundSteps(samples: PointerSample[]): number {
  return roundStepsOf(prepareSegments(samples));
}

/**
 * Combina las 10 medidas en una sola: la media ponderada por los pesos
 * documentados en scoring/weights, normalizada por su suma.
 * Prepara los segmentos una sola vez para las 10 medidas.
 */
export function extractMouseFeatures(samples: PointerSample[]): MouseFeatures {
  const prepared = prepareSegments(samples);
  return {
    straightness: straightnessOf(prepared),
    teleport: teleportOf(prepared),
    speedUniformity: speedUniformityOf(prepared),
    jerk: jerkOf(prepared),
    tremor: tremorOf(prepared),
    intervalRegularity: intervalRegularityOf(prepared),
    overshoot: overshootOf(prepared),
    turnSmoothness: turnSmoothnessOf(prepared),
    microPauses: microPausesOf(prepared),
    roundSteps: roundStepsOf(prepared),
  };
}

/** Cuenta segmentos kind-0 máximos; kind 1|2 separan segmentos sin unirlos. */
export function countSegments(samples: PointerSample[]): number {
  let count = 0;
  let inSegment = false;
  for (const sample of samples) {
    if (sample.kind === 0) {
      if (!inSegment) {
        count += 1;
        inSegment = true;
      }
    } else {
      inSegment = false;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// MEDIDAS PARCIALES (índices ~ del checklist). Carril nuevo y aditivo.
//
// Se define una interfaz y una tabla de pesos PROPIAS (`MousePartialFeatures`,
// `MOUSE_PARTIAL_FEATURE_WEIGHTS`) en vez de ampliar `MouseFeatures`/`weights`:
// las medidas originales y sus firmas quedan intactas, y todos los pesos del
// carril nuevo son 0, así que ningún score existente cambia. `src/scoring/**`
// no se toca; la integración central se hace en otra etapa.
//
// Todas son funciones puras sobre PointerSample[] (o sobre PreparedSegment,
// derivado de ellos), sin DOM/red/almacenamiento y sin identidad de teclas.
// 1 = más probable IA; evidencia insuficiente -> NEUTRAL = 0.5.
// ---------------------------------------------------------------------------

/** Umbral de giro para contar "cambio de dirección": 30°. */
const DIRECTION_CHANGE_RADIANS = Math.PI / 6;
/** Un salto grande es >= 5x la distancia mediana del segmento (solo distancia,
 *  a diferencia de `teleport`, que exige además velocidad desproporcionada). */
const LARGE_JUMP_RATIO = 5;
/** Mínimos pasos para medir zigzag y su desviación perpendicular (px). */
const ZIGZAG_MIN_STEPS = 4;
const ZIGZAG_PERP_PX = 0.5;
/** Distancia mínima (px) entre una entrada (kind 1) y el último movimiento
 *  conocido para considerar que el cursor "apareció de golpe". */
const ABRUPT_ENTRY_PX = 300;
/** Velocidad media (px/ms): <= 0.2 -> 0, >= 3 -> 1. */
const AVG_SPEED_LOW = 0.2;
const AVG_SPEED_HIGH = 3;
/** Mínimo de pasos para recognecer un perfil de campana. */
const BELL_MIN_STEPS = 5;
/** Velocidad máxima (px/ms): <= 3 -> 0, >= 10 -> 1 (por encima de una mano). */
const IMPOSSIBLE_SPEED_LOW = 3;
const IMPOSSIBLE_SPEED_HIGH = 10;
/** Corrección fina: últimos 3 pasos con longitud <= 0.35x la mediana. */
const FINE_MIN_STEPS = 3;
const FINE_TAIL_STEPS = 3;
const FINE_LENGTH_RATIO = 0.35;
/** Puntería: mínimo de puntos de reposo y dispersión (relativa al paso). */
const CLICK_PRECISION_MIN_ENDPOINTS = 3;
/** Fallo corregido: giro terminal > 90° con el último paso más corto. */
const CORRECTED_MISS_TURN = Math.PI / 2;

/**
 * Medidas parciales de mouse. Ninguna entra en el score actual (pesos 0).
 * 1 = más probable IA, salvo `deviceType`, que es un código normalizado
 * derivado solo de `pointerType` (0 mouse, 1/3 pen, 2/3 touch, 1 desconocido).
 */
export interface MousePartialFeatures {
  curvature: number;
  directionChanges: number;
  largeJumps: number;
  zigzag: number;
  edgeEntries: number;
  averageSpeed: number;
  bellProfile: number;
  speedVariation: number;
  impossibleSpeed: number;
  temporalResolution: number;
  subpixel: number;
  deviceType: number;
  fineCorrection: number;
  clickPrecision: number;
  correctedMisses: number;
}

/** Pesos del carril parcial: TODOS 0, para no alterar ningún score existente. */
// `as const` solo protege en compilación: una página podría mutar la tabla en
// runtime y cambiar el score. Object.freeze la vuelve inmutable de verdad.
export const MOUSE_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  curvature: 0,
  directionChanges: 0,
  largeJumps: 0,
  zigzag: 0,
  edgeEntries: 0,
  averageSpeed: 0,
  bellProfile: 0,
  speedVariation: 0,
  impossibleSpeed: 0,
  temporalResolution: 0,
  subpixel: 0,
  deviceType: 0,
  fineCorrection: 0,
  clickPrecision: 0,
  correctedMisses: 0,
} as const satisfies Readonly<Record<keyof MousePartialFeatures, number>>);

/** L3 Curvatura: giro medio por paso, en radianes, normalizado.
 *  Thresholds: giro medio <= 0.02 rad -> 0; >= 60° (π/3) -> 1; lineal entre.
 *  Un camino recto no curvatura -> 0; giros constantes y amplios -> 1. */
function curvatureOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < 2) continue;
    let totalTurn = 0;
    let count = 0;
    let previous: number | null = null;
    for (const step of significantSteps(steps)) {
      const angle = Math.atan2(step.dy, step.dx);
      if (previous !== null) {
        totalTurn += angleDelta(angle, previous);
        count += 1;
      }
      previous = angle;
    }
    if (count === 0) continue;
    entries.push({ value: linear(totalTurn / count, 0.02, Math.PI / 3), weight: count });
  }
  return aggregateWeighted(entries);
}

/** L4 Cambios de dirección: ratio de pasos que giran más de 30°.
 *  Thresholds: ratio <= 0.05 -> 0; >= 0.4 -> 1; lineal entre. */
function directionChangesOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < 2) continue;
    let changes = 0;
    let count = 0;
    let previous: number | null = null;
    for (const step of significantSteps(steps)) {
      const angle = Math.atan2(step.dy, step.dx);
      if (previous !== null) {
        if (angleDelta(angle, previous) > DIRECTION_CHANGE_RADIANS) changes += 1;
        count += 1;
      }
      previous = angle;
    }
    if (count === 0) continue;
    entries.push({ value: linear(changes / count, 0.05, 0.4), weight: count });
  }
  return aggregateWeighted(entries);
}

/** L7 Saltos grandes: distancia >= 5x la mediana del segmento.
 *  A diferencia de `teleport`, aquí NO se exige velocidad: es puramente espacial.
 *  Thresholds: ratio <= 0.02 -> 0; >= 0.15 -> 1; lineal entre. */
function largeJumpsOf(prepared: PreparedSegment[]): number {
  let jumps = 0;
  let total = 0;
  for (const { steps } of prepared) {
    if (steps.length < 2) continue;
    // Eventos coalescidos pueden compartir timestamp (dt = 0): miden el mismo
    // instante, no un desplazamiento real. Incluirlos deprimía la mediana y
    // convertía los pasos normales siguientes en "saltos grandes" falsos.
    const usable = steps.filter((step) => step.dt > 0);
    if (usable.length < 2) continue;
    const dists = usable.map((step) => distance(step.dx, step.dy));
    const med = median(dists);
    if (med <= JUMP_EPS) continue;
    for (const d of dists) {
      total += 1;
      if (d >= LARGE_JUMP_RATIO * med) jumps += 1;
    }
  }
  return total === 0 ? NEUTRAL : linear(jumps / total, 0.02, 0.15);
}

/** L9 Zigzag: alternancia de signo de la desviación perpendicular respecto a
 *  la recta de ida del segmento. El suelo es RELATIVO al paso mediano (10%) con
 *  un mínimo absoluto de 0.5px: así el mismo temblor no puntúa distinto al
 *  cambiar el zoom del navegador. Thresholds: ratio <= 0.1 -> 0; >= 0.5 -> 1. */
function zigzagOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { samples: segment, steps } of prepared) {
    if (steps.length < ZIGZAG_MIN_STEPS) continue;
    const ax = segment[segment.length - 1].x - segment[0].x;
    const ay = segment[segment.length - 1].y - segment[0].y;
    const net = distance(ax, ay);
    if (net <= 1e-9) continue;
    const perpFloor = Math.max(
      ZIGZAG_PERP_PX,
      0.1 * median(steps.map((step) => distance(step.dx, step.dy))),
    );
    let changes = 0;
    let signs = 0;
    let previous = 0;
    for (const step of steps) {
      // Producto cruzado / |net| = distancia perpendicular con signo (px).
      const perp = (ax * step.dy - ay * step.dx) / net;
      const sign = perp > perpFloor ? 1 : perp < -perpFloor ? -1 : 0;
      if (sign !== 0) {
        if (signs > 0 && sign !== previous) changes += 1;
        previous = sign;
        signs += 1;
      }
    }
    if (signs < 2) {
      // Camino sin desviación lateral: no hay zigzag (0), no es falta de evidencia.
      entries.push({ value: 0, weight: steps.length });
      continue;
    }
    entries.push({ value: linear(changes / (signs - 1), 0.1, 0.5), weight: signs });
  }
  return aggregateWeighted(entries);
}

/** L15 Entradas por el borde: entrada (kind 1) "de golpe" si aparece a >= 300px
 *  del último movimiento conocido. Thresholds: ratio 0 -> 0; >= 0.5 -> 1.
 *  Sin entradas o sin referencia -> NEUTRAL. */
function edgeEntriesOf(raw: PointerSample[]): number {
  const samples = raw.map(sanitize);
  const distances: number[] = [];
  // Coste: buscar hacia atrás por cada entrada era O(n²) con muchas `kind 1`.
  // El último `kind 0` visto es exactamente la misma referencia.
  let lastMovement: PointerSample | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].kind === 0) {
      lastMovement = samples[i];
      continue;
    }
    if (samples[i].kind !== 1 || i === 0) continue;
    const from = lastMovement ?? samples[i - 1];
    distances.push(distance(samples[i].x - from.x, samples[i].y - from.y));
  }
  if (distances.length === 0) return NEUTRAL;
  const abrupt = distances.filter((d) => d >= ABRUPT_ENTRY_PX).length / distances.length;
  return linear(abrupt, 0, 0.5);
}

/** L18 Velocidad promedio: distancia total / tiempo total por segmento (px/ms).
 *  Thresholds: <= 0.2 -> 0; >= 3 -> 1; lineal entre. */
function averageSpeedOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    let path = 0;
    let time = 0;
    let count = 0;
    for (const step of steps) {
      if (step.dt <= 0) continue;
      path += distance(step.dx, step.dy);
      time += step.dt;
      count += 1;
    }
    if (count === 0 || time <= 0) continue;
    entries.push({ value: linear(path / time, AVG_SPEED_LOW, AVG_SPEED_HIGH), weight: count });
  }
  return aggregateWeighted(entries);
}

/** L20 Perfil de campana: un humano acelera, llega a un pico y frena. Se mide
 *  `bell = (pico - media de extremos) / pico`; 1 - bell -> IA (perfil plano).
 *  Thresholds: bell <= 0.1 -> 1; >= 0.5 -> 0; lineal entre. */
function bellProfileOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const speeds = steps
      .filter((step) => step.dt > 0)
      .map((step) => distance(step.dx, step.dy) / step.dt);
    if (speeds.length < BELL_MIN_STEPS) continue;
    let peak = 0;
    for (const speed of speeds) if (speed > peak) peak = speed;
    if (peak <= 1e-9) continue;
    const edges = (speeds[0] + speeds[speeds.length - 1]) / 2;
    const bell = (peak - edges) / peak;
    entries.push({ value: 1 - linear(bell, 0.1, 0.5), weight: speeds.length });
  }
  return aggregateWeighted(entries);
}

/** L25 Variación entre movimientos: CV de la velocidad media de cada segmento.
 *  Velocidad idéntica en todos -> CV 0 -> 1 (IA).
 *  Thresholds: CV <= 0.05 -> 1; >= 0.4 -> 0; lineal entre. */
function speedVariationOf(prepared: PreparedSegment[]): number {
  const speeds: number[] = [];
  for (const { steps } of prepared) {
    const values = steps
      .filter((step) => step.dt > 0)
      .map((step) => distance(step.dx, step.dy) / step.dt);
    if (values.length === 0) continue;
    speeds.push(mean(values));
  }
  if (speeds.length < 2) return NEUTRAL;
  const m = mean(speeds);
  if (m <= 1e-9) return NEUTRAL;
  return 1 - linear(stddev(speeds) / m, 0.05, 0.4);
}

/** L27 Velocidad imposible: mayor velocidad instantánea (px/ms).
 *  Thresholds: <= 3 -> 0; >= 10 -> 1; lineal entre. */
function impossibleSpeedOf(prepared: PreparedSegment[]): number {
  let maxSpeed = 0;
  let count = 0;
  for (const { steps } of prepared) {
    for (const step of steps) {
      if (step.dt <= 0) continue;
      const speed = distance(step.dx, step.dy) / step.dt;
      if (speed > maxSpeed) maxSpeed = speed;
      count += 1;
    }
  }
  return count === 0 ? NEUTRAL : linear(maxSpeed, IMPOSSIBLE_SPEED_LOW, IMPOSSIBLE_SPEED_HIGH);
}

/** L31 Resolución temporal: ratio de intervalos con milisegundos enteros.
 *  Timestamps siempre redondos = reloj cuantizado (señal débil, peso 0).
 *  Thresholds: ratio <= 0.5 -> 0; >= 0.95 -> 1; lineal entre. */
function temporalResolutionOf(prepared: PreparedSegment[]): number {
  let round = 0;
  let total = 0;
  for (const { steps } of prepared) {
    for (const step of steps) {
      if (step.dt <= 0) continue;
      total += 1;
      if (Math.abs(step.dt - Math.round(step.dt)) <= 1e-9) round += 1;
    }
  }
  return total === 0 ? NEUTRAL : linear(round / total, 0.5, 0.95);
}

/** L35 Movimientos subpíxel: ratio de muestras con coordenadas fraccionarias;
 *  coordenadas siempre enteras se consideran sospechosas.
 *  Thresholds: ratio >= 0.5 -> 0 (humano); <= 0.1 -> 1 (IA); lineal entre. */
function subpixelOf(prepared: PreparedSegment[]): number {
  let fractional = 0;
  let total = 0;
  for (const { samples: segment } of prepared) {
    if (segment.length < 2) continue;
    for (const sample of segment) {
      total += 1;
      if (
        Math.abs(sample.x - Math.round(sample.x)) > 0.01 ||
        Math.abs(sample.y - Math.round(sample.y)) > 0.01
      ) {
        fractional += 1;
      }
    }
  }
  return total < 2 ? NEUTRAL : 1 - linear(fractional / total, 0.1, 0.5);
}

/** L36 Tipo de dispositivo: código medio normalizado de `pointerType` SOLAMENTE
 *  (sin UA ni heurísticas de texto): 0 mouse, 1/3 pen, 2/3 touch, 1 otro.
 *  Sin muestras -> NEUTRAL. No es una puntuación de IA. */
export function mouseDeviceType(raw: PointerSample[]): number {
  if (raw.length === 0) return NEUTRAL;
  // Ataque: pointerType fuera de 0..3 (o NaN) hacía que el código medio saliera
  // de [0,1] o fuera NaN. Se acota por muestra antes de promediar.
  let sum = 0;
  for (const sample of raw) {
    const type = Number.isFinite(sample.pointerType) ? clamp(sample.pointerType, 0, 3) : 0;
    sum += type / 3;
  }
  return clamp(sum / raw.length, 0, 1);
}

/** L43 Corrección fina: segmentos que terminan con micro-ajustes (<= 0.35x la
 *  mediana). Ausencia de correcciones -> 1 (IA).
 *  Thresholds: ratio de segmentos con corrección 0 -> 1; >= 0.5 -> 0. */
function fineCorrectionOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINE_MIN_STEPS) continue;
    const lengths = steps.map((step) => distance(step.dx, step.dy));
    const med = median(lengths);
    if (med <= 1e-9) continue;
    const tail = lengths.slice(-FINE_TAIL_STEPS);
    const fine = tail.filter((length) => length <= FINE_LENGTH_RATIO * med).length;
    entries.push({ value: fine > 0 ? 1 : 0, weight: steps.length });
  }
  if (entries.length === 0) return NEUTRAL;
  return 1 - linear(aggregateWeighted(entries), 0, 0.5);
}

/** L46 Precisión del click: dispersión de los puntos de reposo (fin de
 *  segmento, donde se haría el click) respecto al paso medio. Caer siempre
 *  "exactamente en el centro" -> 1. Thresholds: dispersión <= 0.05 -> 1;
 *  >= 0.3 -> 0; lineal entre. */
function clickPrecisionOf(prepared: PreparedSegment[]): number {
  const endpoints: Array<{ x: number; y: number }> = [];
  let totalStep = 0;
  let stepCount = 0;
  for (const { samples: segment, steps } of prepared) {
    if (steps.length < 1) continue;
    endpoints.push(segment[segment.length - 1]);
    for (const step of steps) {
      totalStep += distance(step.dx, step.dy);
      stepCount += 1;
    }
  }
  if (endpoints.length < CLICK_PRECISION_MIN_ENDPOINTS || stepCount === 0) return NEUTRAL;
  const meanStep = totalStep / stepCount;
  if (meanStep <= 1e-9) return NEUTRAL;
  const cx = mean(endpoints.map((point) => point.x));
  const cy = mean(endpoints.map((point) => point.y));
  const deviation = mean(endpoints.map((point) => distance(point.x - cx, point.y - cy)));
  return 1 - linear(deviation / meanStep, 0.05, 0.3);
}

/** L48 Fallos corregidos: giro terminal > 90° con el último paso más corto
 *  (se pasó del objetivo y se volvió). Ausencia -> 1 (IA).
 *  Thresholds: ratio de segmentos con fallo corregido 0 -> 1; >= 0.5 -> 0. */
function correctedMissesOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { samples: segment } of prepared) {
    if (segment.length < 3) continue;
    const n = segment.length;
    const d1x = segment[n - 2].x - segment[n - 3].x;
    const d1y = segment[n - 2].y - segment[n - 3].y;
    const d2x = segment[n - 1].x - segment[n - 2].x;
    const d2y = segment[n - 1].y - segment[n - 2].y;
    const first = distance(d1x, d1y);
    const last = distance(d2x, d2y);
    if (first <= 1e-9 || last <= 1e-9) continue;
    const turn = angleDelta(Math.atan2(d1y, d1x), Math.atan2(d2y, d2x));
    entries.push({ value: turn > CORRECTED_MISS_TURN && last < first ? 1 : 0, weight: 1 });
  }
  if (entries.length === 0) return NEUTRAL;
  return 1 - linear(aggregateWeighted(entries), 0, 0.5);
}

/** L3 Curvatura del camino. */
export function mouseCurvature(samples: PointerSample[]): number {
  return curvatureOf(prepareSegments(samples));
}

/** L4 Cambios de dirección. */
export function mouseDirectionChanges(samples: PointerSample[]): number {
  return directionChangesOf(prepareSegments(samples));
}

/** L7 Saltos grandes por distancia. */
export function mouseLargeJumps(samples: PointerSample[]): number {
  return largeJumpsOf(prepareSegments(samples));
}

/** L9 Zigzag lateral. */
export function mouseZigzag(samples: PointerSample[]): number {
  return zigzagOf(prepareSegments(samples));
}

/** L15 Entradas por el borde "de golpe". */
export function mouseEdgeEntries(samples: PointerSample[]): number {
  return edgeEntriesOf(samples);
}

/** L18 Velocidad promedio. */
export function mouseAverageSpeed(samples: PointerSample[]): number {
  return averageSpeedOf(prepareSegments(samples));
}

/** L20 Perfil de campana de velocidad. */
export function mouseBellProfile(samples: PointerSample[]): number {
  return bellProfileOf(prepareSegments(samples));
}

/** L25 Variación de velocidad entre movimientos. */
export function mouseSpeedVariation(samples: PointerSample[]): number {
  return speedVariationOf(prepareSegments(samples));
}

/** L27 Velocidad imposible. */
export function mouseImpossibleSpeed(samples: PointerSample[]): number {
  return impossibleSpeedOf(prepareSegments(samples));
}

/** L31 Resolución temporal de los eventos. */
export function mouseTemporalResolution(samples: PointerSample[]): number {
  return temporalResolutionOf(prepareSegments(samples));
}

/** L35 Movimientos subpíxel / coordenadas fraccionarias. */
export function mouseSubpixel(samples: PointerSample[]): number {
  return subpixelOf(prepareSegments(samples));
}

/** L43 Corrección fina al llegar. */
export function mouseFineCorrection(samples: PointerSample[]): number {
  return fineCorrectionOf(prepareSegments(samples));
}

/** L46 Precisión del click (puntos de reposo del puntero). */
export function mouseClickPrecision(samples: PointerSample[]): number {
  return clickPrecisionOf(prepareSegments(samples));
}

/** L48 Fallos de puntería corregidos. */
export function mouseCorrectedMisses(samples: PointerSample[]): number {
  return correctedMissesOf(prepareSegments(samples));
}

/** Extrae de una sola pasada todas las medidas parciales de mouse. No altera
 *  `extractMouseFeatures` (10 medidas originales). */
export function extractPartialMouseFeatures(samples: PointerSample[]): MousePartialFeatures {
  const prepared = prepareSegments(samples);
  return {
    curvature: curvatureOf(prepared),
    directionChanges: directionChangesOf(prepared),
    largeJumps: largeJumpsOf(prepared),
    zigzag: zigzagOf(prepared),
    edgeEntries: edgeEntriesOf(samples),
    averageSpeed: averageSpeedOf(prepared),
    bellProfile: bellProfileOf(prepared),
    speedVariation: speedVariationOf(prepared),
    impossibleSpeed: impossibleSpeedOf(prepared),
    temporalResolution: temporalResolutionOf(prepared),
    subpixel: subpixelOf(prepared),
    deviceType: mouseDeviceType(samples),
    fineCorrection: fineCorrectionOf(prepared),
    clickPrecision: clickPrecisionOf(prepared),
    correctedMisses: correctedMissesOf(prepared),
  };
}

// ---------------------------------------------------------------------------
// CARRIL FINAL (índices L10..L52 del checklist). Carril NUEVO y aditivo.
//
// No amplía `MouseFeatures`, `MousePartialFeatures` ni sus tablas: 4 tests
// existentes fijan el número exacto de claves de esas tablas. Se añade una lane
// paralela de pesos 0 (no la usa ningún score actual) con la misma forma:
// interfaz + tabla congelada + extractor masivo. La integración posterior podrá
// activarla con `advancedMeasures` sin tocar la calibración actual.
//
// Todas son puras, numéricas, sin DOM/red/almacenamiento. Solo coordenadas,
// tiempos y (cuando se indica) posiciones de click. 1 = más probable IA;
// evidencia insuficiente -> NEUTRAL = 0.5. Coste O(n log n) o mejor.
// ---------------------------------------------------------------------------

/** Tolerancia para contar un paso como "dirección favorita" (4°, 1/8 de 45°). */
const FINAL_CARDINAL_TOL = Math.PI / 45;
/** Giro total mínimo (rad) para que un camino cuente como "curva" y no recta. */
const FINAL_CURVE_MIN_TURN = 0.25;
/** Mínimo de pasos para medir simetría / curva / deriva / arranque. */
const FINAL_SYMMETRY_MIN_STEPS = 4;
const FINAL_CURVE_MIN_STEPS = 5;
const FINAL_DRIFT_MIN_STEPS = 4;
const FINAL_ACCEL_MIN_STEPS = 3;
/** Radio (px) para considerar que el puntero está "sobre" el destino del click. */
const FINAL_HOVER_RADIUS_PX = 6;
/** Ventana (ms) en la que un click se considera posterior a un reposo del cursor. */
const FINAL_CLICK_WINDOW_MS = 300;
/** Botón principal (0). Los clicks de otros botones no cuentan como puntería. */
const FINAL_PRIMARY_BUTTON = 0;

/** CV finito y acotado (0 si hay < 2 valores o la media es ~0). */
function finalCv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

/** Correlación de Pearson acotada a [-1, 1]; 0 si no hay varianza suficiente. */
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

/** Último índice con t <= target, o -1. `times` debe estar ordenado. */
function lastIndexAtMost(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** ¿Algún tiempo ordenado cae en [lo, hi]? */
function anyInRangeTimes(times: number[], lo: number, hi: number): boolean {
  if (lo > hi) return false;
  let left = 0;
  let right = times.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (times[mid] < lo) left = mid + 1;
    else right = mid;
  }
  return left < times.length && times[left] <= hi;
}

function finalSanitizeClick(sample: ClickSample): ClickSample {
  return {
    ...sample,
    x: bounded(sample.x, MAX_COORD),
    y: bounded(sample.y, MAX_COORD),
    t: bounded(sample.t, MAX_TIME),
    button: Number.isFinite(sample.button) ? sample.button : 0,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

/**
 * Contexto de puntería compartido por L41/L44/L45/L49/L50/L51.
 *
 * Por cada click de botón principal se toma la última muestra kind-0 anterior
 * y el segmento que la contiene. `start` es el primer punto de ese segmento:
 * así "apuntar" es el trayecto completo desde que el cursor empezó a moverse
 * hasta el click, no solo el último paso.
 */
interface Aim {
  distance: number;
  path: number;
  time: number;
  gap: number;
  settle: number;
  visits: number;
  straightness: number;
  x: number;
  y: number;
  t: number;
}

function aimsOf(prepared: PreparedSegment[], rawClicks: ClickSample[]): Aim[] {
  const prefix: number[][] = prepared.map(({ steps }) => {
    const out = [0];
    for (const step of steps) out.push(out[out.length - 1] + distance(step.dx, step.dy));
    return out;
  });
  const timeline: Array<{ sample: PointerSample; seg: number; idx: number }> = [];
  for (let seg = 0; seg < prepared.length; seg += 1) {
    const samples = prepared[seg].samples;
    for (let idx = 0; idx < samples.length; idx += 1) {
      timeline.push({ sample: samples[idx], seg, idx });
    }
  }
  timeline.sort((a, b) => a.sample.t - b.sample.t);
  const times = timeline.map((slot) => slot.sample.t);

  const downs = rawClicks
    .map(finalSanitizeClick)
    .filter((sample) => sample.kind === 0 && sample.button === FINAL_PRIMARY_BUTTON);
  // Solo se usan tiempos, así que ordenar no cambia ninguna decisión y evita
  // que el orden de llegada de los clicks altere la medida.
  downs.sort((a, b) => a.t - b.t);

  const aims: Aim[] = [];
  for (const click of downs) {
    const pos = lastIndexAtMost(times, click.t);
    if (pos < 0) continue;
    const { seg, idx } = timeline[pos];
    const segment = prepared[seg].samples;
    const start = segment[0];
    const net = distance(click.x - start.x, click.y - start.y);
    const path = prefix[seg][idx];
    const time = Math.max(0, click.t - start.t);
    const gap = Math.max(0, click.t - segment[idx].t);

    let visits = 0;
    let inside = false;
    let runStart = -1;
    for (let i = 0; i <= idx; i += 1) {
      const near =
        distance(segment[i].x - click.x, segment[i].y - click.y) <= FINAL_HOVER_RADIUS_PX;
      if (near) {
        if (!inside) {
          visits += 1;
          inside = true;
          runStart = segment[i].t;
        }
      } else {
        inside = false;
      }
    }
    // Si el reposo sigue vivo en el instante del click, se cuenta hasta él.
    const settle = inside && runStart >= 0 ? Math.max(0, click.t - runStart) : 0;

    aims.push({
      distance: net,
      path,
      time,
      gap,
      settle,
      visits,
      straightness: net > 1e-9 && path > 1e-9 ? clamp(net / path, 0, 1) : 0,
      x: click.x,
      y: click.y,
      t: click.t,
    });
  }
  return aims;
}

/**
 * Medidas finales de mouse. Todas en [0, 1] con 1 = más IA; peso 0 por defecto.
 */
export interface MouseFinalPartialFeatures {
  symmetry: number;
  perfectCurves: number;
  favoriteDirections: number;
  movementOrigin: number;
  thinkingDrift: number;
  maxSpeed: number;
  initialAcceleration: number;
  finalBraking: number;
  speedByDistance: number;
  stillBeforeMove: number;
  restStability: number;
  driftAfterRelease: number;
  fittsLaw: number;
  aimTime: number;
  timeToClick: number;
  routeToTarget: number;
  anticipation: number;
  hoverBeforeClick: number;
  hoverIrrelevant: number;
}

/** Tabla de la lane final: TODOS 0 para no alterar ningún score calibrado. */
export const MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS = Object.freeze({
  symmetry: 0,
  perfectCurves: 0,
  favoriteDirections: 0,
  movementOrigin: 0,
  thinkingDrift: 0,
  maxSpeed: 0,
  initialAcceleration: 0,
  finalBraking: 0,
  speedByDistance: 0,
  stillBeforeMove: 0,
  restStability: 0,
  driftAfterRelease: 0,
  fittsLaw: 0,
  aimTime: 0,
  timeToClick: 0,
  routeToTarget: 0,
  anticipation: 0,
  hoverBeforeClick: 0,
  hoverIrrelevant: 0,
} as const satisfies Readonly<Record<keyof MouseFinalPartialFeatures, number>>);

/** L10 · Simetría ida/vuelta: el camino de vuelta calcado al de ida.
 *  Compara el paso i con el paso n-1-i: dirección opuesta (coseno <= -0.9) y
 *  longitud parecida (ratio >= 0.6). Thresholds: ratio <= 0.2 -> 0, >= 0.8 -> 1. */
function symmetryOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const n = steps.length;
    if (n < FINAL_SYMMETRY_MIN_STEPS) continue;
    let matched = 0;
    let pairs = 0;
    for (let i = 0; i < Math.floor(n / 2); i += 1) {
      const a = steps[i];
      const b = steps[n - 1 - i];
      const la = distance(a.dx, a.dy);
      const lb = distance(b.dx, b.dy);
      if (la <= 1e-9 || lb <= 1e-9) continue;
      const cosine = (a.dx * b.dx + a.dy * b.dy) / (la * lb);
      const lengthRatio = Math.min(la, lb) / Math.max(la, lb);
      if (cosine <= -0.9 && lengthRatio >= 0.6) matched += 1;
      pairs += 1;
    }
    if (pairs === 0) continue;
    entries.push({ value: linear(matched / pairs, 0.2, 0.8), weight: pairs });
  }
  return aggregateWeighted(entries);
}

/** L12 · Curvas matemáticas perfectas: giro y longitud de paso constantes.
 *  Se exige giro total >= 0.25 rad para no confundir una recta con una curva.
 *  Thresholds: CV(giro) y CV(longitud) <= 0.03 -> suave, >= 0.2 -> ruidoso. */
function perfectCurvesOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINAL_CURVE_MIN_STEPS) continue;
    const turns: number[] = [];
    const lengths: number[] = [];
    for (let i = 1; i < steps.length; i += 1) {
      const prev = steps[i - 1];
      const curr = steps[i];
      const lp = distance(prev.dx, prev.dy);
      const lc = distance(curr.dx, curr.dy);
      if (lp <= 1e-9 || lc <= 1e-9) continue;
      turns.push(angleDelta(Math.atan2(prev.dy, prev.dx), Math.atan2(curr.dy, curr.dx)));
      lengths.push(lc);
    }
    if (turns.length < FINAL_SYMMETRY_MIN_STEPS) continue;
    const totalTurn = turns.reduce((acc, turn) => acc + turn, 0);
    if (totalTurn < FINAL_CURVE_MIN_TURN) {
      entries.push({ value: 0, weight: turns.length });
      continue;
    }
    const smoothTurn = 1 - linear(finalCv(turns), 0.03, 0.2);
    const smoothLength = 1 - linear(finalCv(lengths), 0.03, 0.2);
    const gate = linear(totalTurn, FINAL_CURVE_MIN_TURN, 0.8);
    entries.push({ value: gate * smoothTurn * smoothLength, weight: turns.length });
  }
  return aggregateWeighted(entries);
}

/** L13 · Direcciones favoritas: pasos ajustados a los 8 ángulos canónicos
 *  (múltiplos de 45°). Solo usa ángulos numéricos, nunca identidad de tecla ni
 *  cadenas. Thresholds: ratio <= 0.25 -> 0, >= 0.85 -> 1. */
function favoriteDirectionsOf(prepared: PreparedSegment[]): number {
  let snapped = 0;
  let total = 0;
  for (const { steps } of prepared) {
    for (const step of steps) {
      if (distance(step.dx, step.dy) <= 1e-9) continue;
      const angle = Math.atan2(step.dy, step.dx);
      const nearest = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      total += 1;
      if (angleDelta(angle, nearest) <= FINAL_CARDINAL_TOL) snapped += 1;
    }
  }
  return total === 0 ? NEUTRAL : linear(snapped / total, 0.25, 0.85);
}

/** L14 · Origen del movimiento: salto entre el último punto conocido y el
 *  primero del siguiente segmento, medido en unidades del paso mediano.
 *  Thresholds: ratio <= 4 -> 0, >= 40 -> 1. Sin segmento previo -> neutro. */
function movementOriginOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  let last: PointerSample | null = null;
  for (const { samples, steps } of prepared) {
    if (samples.length === 0) continue;
    if (last !== null) {
      const jump = distance(samples[0].x - last.x, samples[0].y - last.y);
      const med = median(steps.map((step) => distance(step.dx, step.dy)));
      const scale = med > 1e-9 ? med : 1;
      entries.push({ value: linear(jump / scale, 4, 40), weight: 1 });
    }
    last = samples[samples.length - 1];
  }
  return entries.length === 0 ? NEUTRAL : aggregateWeighted(entries);
}

/** L16 · Deriva al pensar: pasos minúsculos y sin avance neto (vago) dentro
 *  de un segmento. Thresholds: tiny x aimless <= 0.1 -> 0, >= 0.5 -> 1. */
function thinkingDriftOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINAL_DRIFT_MIN_STEPS) continue;
    const lengths = steps.map((step) => distance(step.dx, step.dy));
    const med = median(lengths);
    if (med <= 1e-9) continue;
    const tiny = lengths.filter((length) => length <= 0.5 * med).length / lengths.length;
    const net = distance(
      steps.reduce((acc, step) => acc + step.dx, 0),
      steps.reduce((acc, step) => acc + step.dy, 0),
    );
    const path = lengths.reduce((acc, length) => acc + length, 0);
    const aimless = path > 1e-9 ? 1 - clamp(net / path, 0, 1) : 0;
    entries.push({ value: linear(tiny * aimless, 0.1, 0.5), weight: steps.length });
  }
  return aggregateWeighted(entries);
}

/** L19 · Velocidad máxima instantánea (px/ms). Thresholds: <= 2 -> 0,
 *  >= 8 -> 1. A diferencia de L27 (imposible) aquí se mide el pico, no un
 *  salto aislado desproporcionado frente a sus vecinos. */
function maxSpeedOf(prepared: PreparedSegment[]): number {
  let max = 0;
  let count = 0;
  for (const { steps } of prepared) {
    for (const step of steps) {
      if (step.dt <= 0) continue;
      const speed = distance(step.dx, step.dy) / step.dt;
      if (speed > max) max = speed;
      count += 1;
    }
  }
  return count === 0 ? NEUTRAL : linear(max, 2, 8);
}

/** L21 · Aceleración inicial: velocidad del primer paso frente a la mediana
 *  del resto. Arranque instantáneo a toda velocidad -> IA.
 *  Thresholds: ratio <= 1.5 -> 0, >= 6 -> 1. */
function initialAccelerationOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINAL_ACCEL_MIN_STEPS) continue;
    const speeds = steps
      .filter((step) => step.dt > 0)
      .map((step) => distance(step.dx, step.dy) / step.dt);
    if (speeds.length < FINAL_ACCEL_MIN_STEPS) continue;
    const rest = median(speeds.slice(1));
    if (rest <= 1e-9) continue;
    entries.push({ value: linear(speeds[0] / rest, 1.5, 6), weight: speeds.length });
  }
  return aggregateWeighted(entries);
}

/** L22 · Frenado final: velocidad del último paso frente a la media previa.
 *  Frenar bien (ratio bajo) es humano; mantener el ritmo hasta el final es IA.
 *  Thresholds: ratio <= 0.3 -> 0 (frena), >= 0.95 -> 1 (no frena). */
function finalBrakingOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINAL_ACCEL_MIN_STEPS) continue;
    const speeds = steps
      .filter((step) => step.dt > 0)
      .map((step) => distance(step.dx, step.dy) / step.dt);
    if (speeds.length < FINAL_ACCEL_MIN_STEPS) continue;
    const before = mean(speeds.slice(0, -1));
    if (before <= 1e-9) continue;
    entries.push({
      value: linear(speeds[speeds.length - 1] / before, 0.3, 0.95),
      weight: speeds.length,
    });
  }
  return aggregateWeighted(entries);
}

/** L26 · Velocidad según distancia: correlación entre desplazamiento del
 *  segmento y su velocidad media. La mano es más rápida cuanto más lejos va;
 *  un bot va a la misma velocidad siempre (correlación ~0) -> IA.
 *  Thresholds: correlación <= 0 -> 1, >= 0.6 -> 0. */
function speedByDistanceOf(prepared: PreparedSegment[]): number {
  const distances: number[] = [];
  const speeds: number[] = [];
  for (const { samples: segment, steps } of prepared) {
    if (steps.length === 0) continue;
    let path = 0;
    let time = 0;
    for (const step of steps) {
      if (step.dt <= 0) continue;
      path += distance(step.dx, step.dy);
      time += step.dt;
    }
    if (time <= 0) continue;
    const net = distance(
      segment[segment.length - 1].x - segment[0].x,
      segment[segment.length - 1].y - segment[0].y,
    );
    if (net <= 1e-9) continue;
    distances.push(net);
    speeds.push(path / time);
  }
  if (distances.length < 3) return NEUTRAL;
  return 1 - linear(finalCorrelation(distances, speeds), 0, 0.6);
}

/** L29 · Tiempo parado antes de moverse: primer intervalo frente a la mediana
 *  de intervalos del segmento.Una espera fija y larga antes de arrancar es IA.
 *  Thresholds: ratio <= 2 -> 0, >= 12 -> 1. */
function stillBeforeMoveOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    if (steps.length < FINAL_ACCEL_MIN_STEPS) continue;
    const dts = steps.filter((step) => step.dt > 0).map((step) => step.dt);
    if (dts.length < FINAL_ACCEL_MIN_STEPS) continue;
    const med = median(dts);
    if (med <= 1e-9) continue;
    entries.push({ value: linear(dts[0] / med, 2, 12), weight: dts.length });
  }
  return aggregateWeighted(entries);
}

/** L38 · Estabilidad en reposo: un humano nunca está 100% inmóvil. Mide el
 *  ratio de pasos con desplazamiento exactamente cero.
 *  Thresholds: ratio <= 0.05 -> 0, >= 0.5 -> 1. */
function restStabilityOf(prepared: PreparedSegment[]): number {
  let frozen = 0;
  let total = 0;
  for (const { steps } of prepared) {
    for (const step of steps) {
      total += 1;
      if (distance(step.dx, step.dy) <= 1e-12) frozen += 1;
    }
  }
  return total < 2 ? NEUTRAL : linear(frozen / total, 0.05, 0.5);
}

/** L39 · Deriva al soltar: tras un reposo (>= 2 muestras iguales) la mano
 *  humana sigue con micro-movimientos; un bot salta directo o queda clavado.
 *  Se compara el avance posterior con la mediana de pasos ANTERIORES al reposo.
 *  Thresholds: deriva <= 0.05 -> 1 (IA), >= 0.3 -> 0 (humano). */
function driftAfterReleaseOf(prepared: PreparedSegment[]): number {
  const entries: WeightedValue[] = [];
  for (const { steps } of prepared) {
    const lengths = steps.map((step) => distance(step.dx, step.dy));
    let i = 0;
    while (i < lengths.length) {
      if (lengths[i] > 1e-12) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < lengths.length && lengths[j] <= 1e-12) j += 1;
      const before = lengths.slice(0, i).filter((length) => length > 1e-12);
      if (j - i >= 2 && j < lengths.length && before.length > 0) {
        const scale = median(before);
        if (scale > 1e-9) {
          const after = lengths.slice(j, j + 3);
          const drift = mean(after) / scale;
          entries.push({ value: 1 - linear(drift, 0.05, 0.3), weight: 1 });
        }
      }
      i = j;
    }
  }
  return entries.length === 0 ? NEUTRAL : aggregateWeighted(entries);
}

/** L41 · Ley de Fitts: a mayor distancia, mayor tiempo de apuntado. Se correlaciona
 *  log(1 + distancia) con el tiempo desde el inicio del movimiento hasta el click.
 *  Thresholds: correlación <= 0 -> 1 (tiempo fijo, IA), >= 0.6 -> 0 (humano). */
function fittsLawOf(aims: Aim[]): number {
  const usable = aims.filter((aim) => aim.distance > 1e-9 && aim.time > 0);
  if (usable.length < 4) return NEUTRAL;
  const distances = usable.map((aim) => Math.log1p(aim.distance));
  const times = usable.map((aim) => aim.time);
  return 1 - linear(finalCorrelation(distances, times), 0, 0.6);
}

/** L44 · Tiempo de apuntar: CV de los tiempos desde que empieza el movimiento
 *  hasta el click. Tiempo siempre igual -> IA. Thresholds: CV <= 0.05 -> 1,
 *  >= 0.35 -> 0. */
function aimTimeOf(aims: Aim[]): number {
  const times = aims.map((aim) => aim.time).filter((time) => time > 0);
  if (times.length < 3) return NEUTRAL;
  return 1 - linear(finalCv(times), 0.05, 0.35);
}

/** L45 · Tiempo hasta el click: hueco entre la última muestra de puntero y el
 *  pointerdown. Click instantáneo tras llegar -> IA.
 *  Thresholds: media <= 5ms -> 1, >= 120ms -> 0. */
function timeToClickOf(aims: Aim[]): number {
  if (aims.length < 2) return NEUTRAL;
  return 1 - linear(mean(aims.map((aim) => aim.gap)), 5, 120);
}

/** L49 · Ruta hacia el objetivo: eficiencia (distancia directa / camino) del
 *  trayecto previo al click. Ir siempre recto a un objetivo que acaba de
 *  aparecer es IA. Sin movimiento previo -> NEUTRAL. */
function routeToTargetOf(aims: Aim[]): number {
  const usable = aims.filter((aim) => aim.path > 1e-9);
  if (usable.length < 2) return NEUTRAL;
  return clamp(mean(usable.map((aim) => aim.straightness)), 0, 1);
}

/** L50 · Anticipación: el cursor ya esperaba en el destino mucho antes del
 *  click y además llegó directo. Thresholds: share 0 -> 0, >= 0.5 -> 1. */
function anticipationOf(aims: Aim[]): number {
  if (aims.length < 2) return NEUTRAL;
  const early = aims.filter((aim) => aim.gap >= 300 && aim.straightness >= 0.8).length;
  return linear(early / aims.length, 0, 0.5);
}

/** L51 · Hover antes de clickear: reposo >= 80ms sobre el destino. El bot
 *  clickea al llegar, sin inspeccionar; el humano suele detenerse.
 *  Thresholds: share <= 0.2 -> 1 (sin hover, IA), >= 0.8 -> 0. */
function hoverBeforeClickOf(aims: Aim[]): number {
  if (aims.length < 2) return NEUTRAL;
  const hovered = aims.filter((aim) => aim.settle >= 80 && aim.visits >= 1).length / aims.length;
  return 1 - linear(hovered, 0.2, 0.8);
}

/** L52 · Hover sobre irrelevantes: finales de segmento en reposo que NO van
 *  seguidos de un click (curiosidad humana). El bot solo se detiene donde va a
 *  clickear. Thresholds: ratio <= 0.2 -> 1 (sin curiosidad), >= 0.8 -> 0. */
function hoverIrrelevantOf(prepared: PreparedSegment[], rawClicks: ClickSample[]): number {
  const clickTimes = rawClicks
    .map(finalSanitizeClick)
    .filter((sample) => sample.kind === 0 && sample.button === FINAL_PRIMARY_BUTTON)
    .map((sample) => sample.t)
    .sort((a, b) => a - b);
  let ends = 0;
  let irrelevant = 0;
  for (const { samples, steps } of prepared) {
    if (steps.length < 1 || samples.length < 2) continue;
    const last = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    if (distance(last.x - prev.x, last.y - prev.y) > FINAL_HOVER_RADIUS_PX) continue;
    ends += 1;
    if (!anyInRangeTimes(clickTimes, last.t, last.t + FINAL_CLICK_WINDOW_MS)) irrelevant += 1;
  }
  return ends === 0 ? NEUTRAL : 1 - linear(irrelevant / ends, 0.2, 0.8);
}

/** L10 · Simetría ida/vuelta. */
export function mouseSymmetry(samples: PointerSample[]): number {
  return symmetryOf(prepareSegments(samples));
}
/** L12 · Curvas matemáticas perfectas. */
export function mousePerfectCurves(samples: PointerSample[]): number {
  return perfectCurvesOf(prepareSegments(samples));
}
/** L13 · Direcciones favoritas (solo ángulos numéricos). */
export function mouseFavoriteDirections(samples: PointerSample[]): number {
  return favoriteDirectionsOf(prepareSegments(samples));
}
/** L14 · Origen del movimiento. */
export function mouseMovementOrigin(samples: PointerSample[]): number {
  return movementOriginOf(prepareSegments(samples));
}
/** L16 · Deriva al pensar. */
export function mouseThinkingDrift(samples: PointerSample[]): number {
  return thinkingDriftOf(prepareSegments(samples));
}
/** L19 · Velocidad máxima. */
export function mouseMaxSpeed(samples: PointerSample[]): number {
  return maxSpeedOf(prepareSegments(samples));
}
/** L21 · Aceleración inicial. */
export function mouseInitialAcceleration(samples: PointerSample[]): number {
  return initialAccelerationOf(prepareSegments(samples));
}
/** L22 · Frenado final. */
export function mouseFinalBraking(samples: PointerSample[]): number {
  return finalBrakingOf(prepareSegments(samples));
}
/** L26 · Velocidad según distancia. */
export function mouseSpeedByDistance(samples: PointerSample[]): number {
  return speedByDistanceOf(prepareSegments(samples));
}
/** L29 · Tiempo parado antes de moverse. */
export function mouseStillBeforeMove(samples: PointerSample[]): number {
  return stillBeforeMoveOf(prepareSegments(samples));
}
/** L38 · Estabilidad en reposo. */
export function mouseRestStability(samples: PointerSample[]): number {
  return restStabilityOf(prepareSegments(samples));
}
/** L39 · Deriva al soltar. */
export function mouseDriftAfterRelease(samples: PointerSample[]): number {
  return driftAfterReleaseOf(prepareSegments(samples));
}
/** L41 · Ley de Fitts (requiere contexto de clicks; por defecto sin clicks). */
export function mouseFittsLaw(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return fittsLawOf(aimsOf(prepareSegments(samples), clicks));
}
/** L44 · Tiempo de apuntar (contexto de clicks opcional). */
export function mouseAimTime(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return aimTimeOf(aimsOf(prepareSegments(samples), clicks));
}
/** L45 · Tiempo hasta el click (contexto de clicks opcional). */
export function mouseTimeToClick(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return timeToClickOf(aimsOf(prepareSegments(samples), clicks));
}
/** L49 · Ruta hacia el objetivo (contexto de clicks opcional). */
export function mouseRouteToTarget(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return routeToTargetOf(aimsOf(prepareSegments(samples), clicks));
}
/** L50 · Anticipación (contexto de clicks opcional). */
export function mouseAnticipation(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return anticipationOf(aimsOf(prepareSegments(samples), clicks));
}
/** L51 · Hover antes de clickear (contexto de clicks opcional). */
export function mouseHoverBeforeClick(
  samples: PointerSample[],
  clicks: ClickSample[] = [],
): number {
  return hoverBeforeClickOf(aimsOf(prepareSegments(samples), clicks));
}
/** L52 · Hover sobre irrelevantes (contexto de clicks opcional). */
export function mouseHoverIrrelevant(samples: PointerSample[], clicks: ClickSample[] = []): number {
  return hoverIrrelevantOf(prepareSegments(samples), clicks);
}

/** Extrae las 19 medidas finales en una sola preparación. No altera ningún
 *  extractor ni score existente. Los clicks son opcionales: sin ellos, L41/L44/
 *  L45/L49/L50/L51/L52 devuelven neutro y L52 sigue midiendo reposos sin click. */
export function extractFinalMouseFeatures(
  samples: PointerSample[],
  clicks: ClickSample[] = [],
): MouseFinalPartialFeatures {
  const prepared = prepareSegments(samples);
  const aims = aimsOf(prepared, clicks);
  return {
    symmetry: symmetryOf(prepared),
    perfectCurves: perfectCurvesOf(prepared),
    favoriteDirections: favoriteDirectionsOf(prepared),
    movementOrigin: movementOriginOf(prepared),
    thinkingDrift: thinkingDriftOf(prepared),
    maxSpeed: maxSpeedOf(prepared),
    initialAcceleration: initialAccelerationOf(prepared),
    finalBraking: finalBrakingOf(prepared),
    speedByDistance: speedByDistanceOf(prepared),
    stillBeforeMove: stillBeforeMoveOf(prepared),
    restStability: restStabilityOf(prepared),
    driftAfterRelease: driftAfterReleaseOf(prepared),
    fittsLaw: fittsLawOf(aims),
    aimTime: aimTimeOf(aims),
    timeToClick: timeToClickOf(aims),
    routeToTarget: routeToTargetOf(aims),
    anticipation: anticipationOf(aims),
    hoverBeforeClick: hoverBeforeClickOf(aims),
    hoverIrrelevant: hoverIrrelevantOf(prepared, clicks),
  };
}

// ---------------------------------------------------------------------------
// L11 · Repetición exacta del mismo trayecto (ítem del checklist que no tenía
// medida propia en mouse.ts). OPT-IN y sin peso: no se añade a ninguna tabla ni
// extractor existente, así que ningún score calibrado cambia.
// ---------------------------------------------------------------------------

/** Cuantización de la firma de un trayecto (0.5 px). */
const EXACT_REPEAT_QUANTUM = 0.5;

/**
 * L11 · Repetición exacta: el mismo trayecto aparece dos veces. Se compara la
 * FORMA RELATIVA de cada segmento kind-0 (sus pasos, sin la posición absoluta),
 * cuantizada a 0.5px, con coste O(n) esperado. Un bot que reproduce una macro
 * coincide; un humano que vuelve al mismo botón describe caminos distintos.
 * Thresholds: share de repeticiones 0 -> 0; >= 0.5 -> 1. Menos de dos
 * segmentos comparables -> NEUTRAL.
 */
export function mouseExactRepetition(samples: PointerSample[]): number {
  const signatures = new Map<string, number>();
  let eligible = 0;
  for (const { steps } of prepareSegments(samples)) {
    if (steps.length < FINAL_SYMMETRY_MIN_STEPS) continue;
    let signature = "";
    let meaningful = 0;
    for (const step of steps) {
      const dx = Math.round(step.dx / EXACT_REPEAT_QUANTUM);
      const dy = Math.round(step.dy / EXACT_REPEAT_QUANTUM);
      if (dx !== 0 || dy !== 0) meaningful += 1;
      signature += `${dx},${dy};`;
    }
    if (meaningful < FINAL_SYMMETRY_MIN_STEPS) continue;
    eligible += 1;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  if (eligible < 2) return NEUTRAL;
  let repeats = 0;
  for (const count of signatures.values()) repeats += Math.max(0, count - 1);
  return linear(repeats / eligible, 0, 0.5);
}
