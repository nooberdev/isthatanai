// Utilidades matemáticas para scoring. Solo números: sin DOM, sin red.

/** Ajusta `value` a [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Media aritmética. Devuelve 0 en lista vacía. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Varianza poblacional. < 2 valores -> 0. */
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - m) * (value - m);
  return acc / values.length;
}

export function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

/** Mediana. < 1 valor -> 0. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Interpolación lineal: 0 cuando value <= low, 1 cuando value >= high,
 * interpolado en medio. Valores fuera de rango se ajustan a 0 o 1.
 */
export function linear(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

/** Distancia euclídea en 2D. */
export function distance(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}
