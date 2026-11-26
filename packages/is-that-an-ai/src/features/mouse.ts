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

import type { PointerSample } from "../types";
import { distance, linear, mean, median, stddev } from "../utils/math";

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

function stepsOf(segment: PointerSample[]): Array<{ dx: number; dy: number; dt: number }> {
  const out: Array<{ dx: number; dy: number; dt: number }> = [];
  for (let i = 1; i < segment.length; i += 1) {
    out.push({
      dx: segment[i].x - segment[i - 1].x,
      dy: segment[i].y - segment[i - 1].y,
      dt: segment[i].t - segment[i - 1].t,
    });
  }
  return out;
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

function pathLength(steps: Array<{ dx: number; dy: number }>): number {
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

// ---------------------------------------------------------------------------
// Medidas exportadas
// ---------------------------------------------------------------------------

/**
 * Eficiencia del camino: D / P, D = |p_end - p_start|, P = suma de pasos.
 * 1 = camino perfectamente recto; ~0.5 = muy meandroso.
 * Thresholds: D/P >= 0.95 -> 1; <= 0.55 -> 0; lineal entre.
 */
export function mouseStraightness(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const steps = stepsOf(segment);
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
function isRelativeJump(
  step: { dx: number; dy: number; dt: number },
  medDist: number,
  medSpeed: number,
): boolean {
  const d = distance(step.dx, step.dy);
  const v = step.dt > 0 ? d / step.dt : 0;
  // Un paso sin movimiento nunca es salto; además evita 0/0 si la mediana es 0.
  if (d <= JUMP_EPS || v <= JUMP_EPS) return false;
  return d >= JUMP_DIST_RATIO * medDist && v >= JUMP_SPEED_RATIO * medSpeed;
}

export function mouseTeleport(samples: PointerSample[]): number {
  let jumps = 0;
  let stepsTotal = 0;
  for (const segment of segmentsOf(samples)) {
    const steps = stepsOf(segment);
    if (steps.length === 0) continue;
    const medDist = median(steps.map((step) => distance(step.dx, step.dy)));
    const medSpeed = median(
      steps.filter((step) => step.dt > 0).map((step) => distance(step.dx, step.dy) / step.dt),
    );
    jumps += steps.filter((step) => isRelativeJump(step, medDist, medSpeed)).length;
    stepsTotal += steps.length;
  }
  return stepsTotal === 0 ? NEUTRAL : linear(jumps / stepsTotal, 0.02, 0.15);
}

/**
 * Uniformidad de velocidad: 1 - CV(velocidades).
 * Velocidad constante -> CV ~ 0 -> 1; variable -> 0.
 * Thresholds: CV <= 0.15 -> 1; >= 0.7 -> 0; lineal entre.
 */
export function mouseSpeedUniformity(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const speeds = stepsOf(segment)
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
export function mouseJerk(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const entriesStep = stepsOf(segment)
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

export function mouseTremor(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
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
export function mouseIntervalRegularity(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const dts = stepsOf(segment)
      .filter((step) => step.dt > 0)
      .map((step) => step.dt);
    if (dts.length === 0) continue;
    const m = mean(dts);
    if (m <= 1e-9) continue;
    entries.push({ value: 1 - linear(stddev(dts) / m, 0.15, 0.7), weight: dts.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Sobrepaso: reversión real. Detecta cambios de dirección > 120° y suma la
 * longitud del camino de cada ventana de reversión; el resultado es
 * min(1, excursiones / caminoTotal). Sin reversión -> 0.
 */
export function mouseOvershoot(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const steps = stepsOf(segment);
    if (steps.length < 2) continue;
    let totalPath = 0;
    let excursions = 0;
    let currentDir: number | null = null;
    let excursionLen = 0;
    let hasReversal = false;
    for (const step of steps) {
      const stepLen = distance(step.dx, step.dy);
      totalPath += stepLen;
      const dir = Math.atan2(step.dy, step.dx);
      if (currentDir !== null && angleDelta(dir, currentDir) > REVERSAL_RADIANS) {
        hasReversal = true;
        excursions += excursionLen;
        excursionLen = 0;
      }
      excursionLen += stepLen;
      currentDir = dir;
    }
    excursions += excursionLen;
    const value = hasReversal && totalPath > 1e-9 ? Math.min(1, excursions / totalPath) : 0;
    entries.push({ value, weight: steps.length });
  }
  return aggregateWeighted(entries);
}

/**
 * Suavidad de giros: 1 - max |delta de ángulo| entre pasos consecutivos.
 * Thresholds: delta <= 15° -> 1; >= 90° -> 0; lineal entre.
 */
export function mouseTurnSmoothness(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
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
export function mouseMicroPauses(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const dts = stepsOf(segment).map((step) => step.dt);
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
export function mouseRoundSteps(samples: PointerSample[]): number {
  const entries: WeightedValue[] = [];
  for (const segment of segmentsOf(samples)) {
    const steps = stepsOf(segment);
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

/**
 * Combina las 10 medidas en una sola: la media ponderada por los pesos
 * documentados en scoring/weights, normalizada por su suma.
 */
export function extractMouseFeatures(samples: PointerSample[]): MouseFeatures {
  return {
    straightness: mouseStraightness(samples),
    teleport: mouseTeleport(samples),
    speedUniformity: mouseSpeedUniformity(samples),
    jerk: mouseJerk(samples),
    tremor: mouseTremor(samples),
    intervalRegularity: mouseIntervalRegularity(samples),
    overshoot: mouseOvershoot(samples),
    turnSmoothness: mouseTurnSmoothness(samples),
    microPauses: mouseMicroPauses(samples),
    roundSteps: mouseRoundSteps(samples),
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
