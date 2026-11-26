// Ruido de intervalos: distinguir ruido humano correlacionado de un RNG
// uniforme o de una fórmula determinista. Numérico puro, sin DOM/red/storage.
//
// Todas las medidas están en [0,1] y son finitas. Listas vacías (o con menos
// de 8 intervalos válidos) devuelven 0: no se inventa evidencia. Los valores
// no finitos, no positivos o >1e6 ms se descartan/saturan antes de medir.
// Complejidad O(n log n) como máximo (la mediana usa quickselect O(n)).
//
// Umbrales documentados:
// - `formulaRhythm`: máximo de (pocos valores distintos <=0.15 -> 1, >=0.5
//   -> 0), (CV <=0.02 -> 1, >=0.15 -> 0), (periodo 2..8 con diferencia media
//   relativa <=0.02 -> 1, >=0.15 -> 0) y (tendencia |r| >=0.95 -> 1, <=0.6
//   -> 0). Un metrónomo, un ciclo corto o una rampa lineal dan 1.
// - `noiseHumanity`: 0.55 * autocorrelación lag-1 (r 0.05 -> 0, 0.45 -> 1)
//   + 0.25 * cola pesada (max/mediana 1.5 -> 0, 3.5 -> 1)
//   + 0.20 * dispersión (CV 0.25 -> 0, 0.6 -> 1), multiplicado por
//   (1 - formulaRhythm). El RNG uniforme no tiene correlación ni cola; el
//   tecleo humano sí; la fórmula se anula.

import { clamp, linear, mean, median, stddev } from "../utils/math";

const MIN_INTERVALS = 8;
const MAX_VALUE_MS = 1e6;

/** Intervalos finitos y positivos, saturados a 1e6 ms. Nunca lanza. */
function clean(values: number[]): number[] {
  if (!Array.isArray(values)) return [];
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out.push(Math.min(value, MAX_VALUE_MS));
    }
  }
  return out;
}

/** Correlación de Pearson acotada a [-1,1]; 0 si falta varianza. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += (a[i] - meanA) / (i + 1);
    meanB += (b[i] - meanB) / (i + 1);
  }
  let numerator = 0;
  let squaresA = 0;
  let squaresB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    squaresA += da * da;
    squaresB += db * db;
  }
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(squaresA) ||
    !Number.isFinite(squaresB) ||
    squaresA <= 0 ||
    squaresB <= 0
  ) {
    return 0;
  }
  const denominator = Math.sqrt(squaresA * squaresB);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return clamp(numerator / denominator, -1, 1);
}

/** Coeficiente de variación finito y no negativo. */
function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (!Number.isFinite(average) || average <= 1e-9) return 0;
  const cv = stddev(values) / average;
  return Number.isFinite(cv) && cv >= 0 ? cv : 0;
}

/** Mejor coincidencia con un ciclo corto (2..8 intervalos). */
function periodicScore(values: number[]): number {
  const average = mean(values);
  if (!Number.isFinite(average) || average <= 1e-9) return 1;
  let best = 0;
  for (let period = 2; period <= 8; period += 1) {
    let total = 0;
    let pairs = 0;
    for (let i = 0; i + period < values.length; i += 1) {
      total += Math.abs(values[i] - values[i + period]);
      pairs += 1;
    }
    if (pairs === 0) continue;
    const relative = total / pairs / average;
    const score = 1 - linear(relative, 0.02, 0.15);
    if (score > best) best = score;
  }
  return clamp(best, 0, 1);
}

/**
 * 1 = serie generada por fórmula (metrónomo, ciclo corto o tendencia lineal);
 * 0 = sin patrón de fórmula (o muestra insuficiente).
 */
export function formulaRhythm(intervals: number[]): number {
  const values = clean(intervals);
  if (values.length < MIN_INTERVALS) return 0;
  const uniqueShare = new Set(values.map((value) => Math.round(value))).size / values.length;
  const fewValues = 1 - linear(uniqueShare, 0.15, 0.5);
  const constant = 1 - linear(coefficientOfVariation(values), 0.02, 0.15);
  const index = values.map((_, i) => i);
  const trend = linear(Math.abs(pearson(values, index)), 0.6, 0.95);
  return clamp(Math.max(fewValues, constant, periodicScore(values), trend), 0, 1);
}

/**
 * 1 = ruido con correlación y pausas humanas; 0 = RNG uniforme, fórmula o
 * muestra insuficiente. Nunca devuelve NaN/Infinity ni sale de [0,1].
 */
export function noiseHumanity(intervals: number[]): number {
  const values = clean(intervals);
  if (values.length < MIN_INTERVALS) return 0;
  const formula = formulaRhythm(values);
  const correlation = linear(pearson(values.slice(0, -1), values.slice(1)), 0.05, 0.45);
  const med = median(values);
  let max = 0;
  for (const value of values) if (value > max) max = value;
  const tail = med > 1e-9 ? linear(max / med, 1.5, 3.5) : 0;
  const spread = linear(coefficientOfVariation(values), 0.25, 0.6);
  const raw = 0.55 * correlation + 0.25 * tail + 0.2 * spread;
  const result = raw * (1 - formula);
  return clamp(Number.isFinite(result) ? result : 0, 0, 1);
}
