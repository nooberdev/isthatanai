// Utilidades matemáticas para scoring. Solo números: sin DOM, sin red.
//
// Defensivas por diseño: medidas expuestas reciben muestras hostiles de una
// página (NaN, ±Infinity, 1e308, tiempos invertidos...). Ninguna utilidad debe
// devolver NaN/Infinity: el valor no finito se descarta o se satura. Los valores
// finitos normales siguen la misma cadena de operaciones de siempre, así que
// las puntuaciones calibradas no cambian.

/** Fallback finito para un resultado no finito. */
function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Ajusta `value` a [min, max]. NaN -> min (nunca devuelve NaN). */
export function clamp(value: number, min: number, max: number): number {
  // Ataque: NaN en pointerType/features. Las comparaciones con NaN son falsas
  // y antes se devolvía NaN, contaminando el score.
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Media aritmética. Devuelve 0 en lista vacía. */
export function mean(values: number[]): number {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    // Ataque: un solo NaN/Infinity envenenaba toda la media.
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  if (count === 0) return 0;
  let result = sum / count;
  if (!Number.isFinite(result)) {
    // Ataque: dos valores ~1e308 desbordan la suma a Infinity. Repetimos
    // dividiendo antes de sumar; el resultado sigue siendo finito.
    result = 0;
    for (const value of values) if (Number.isFinite(value)) result += value / count;
  }
  return finite(result);
}

/** Varianza poblacional. < 2 valores -> 0. */
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const d = value - m;
    acc += d * d;
    count += 1;
  }
  if (count < 2) return 0;
  let result = acc / count;
  if (!Number.isFinite(result)) {
    // Ataque: (1e308)^2 desborda a Infinity. Escalamos por la desviación
    // máxima; la varianza real puede exceder el rango de un double, así que
    // la saturamos al máximo finito en lugar de devolver Infinity.
    let scale = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      const d = Math.abs(value - m);
      if (d > scale) scale = d;
    }
    if (scale <= 0) return 0;
    if (scale > Math.sqrt(Number.MAX_VALUE)) return Number.MAX_VALUE;
    let scaled = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      scaled += ((value - m) / scale) ** 2;
    }
    result = scale * scale * (scaled / count);
  }
  return finite(result);
}

export function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

/**
 * k-ésimo valor ordenado (quickselect in-place). Mismo resultado que ordenar,
 * pero O(n) en vez de O(n log n); `values` no se modifica.
 */
function select(a: number[], k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i += 1;
      while (a[j] > pivot) j -= 1;
      if (i <= j) {
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[lo];
}

/**
 * Mediana. < 1 valor -> 0. Devuelve exactamente lo mismo que ordenar el array
 * (los dos valores centrales se suman en el mismo orden), sin el coste del sort.
 */
export function median(values: number[]): number {
  // Ataque: NaN rompe las comparaciones de quickselect y ±Infinity contamina
  // el promedio de los dos centrales. Se descartan antes de seleccionar.
  const clean = values.filter((value) => Number.isFinite(value));
  const n = clean.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return finite(select(clean, Math.floor(n / 2)));
  const left = select(clean, n / 2 - 1);
  const right = select(clean, n / 2);
  const mid = (left + right) / 2;
  // Ataque: 1e308 + 1e308 desborda. Dividir antes mantiene el resultado finito.
  return finite(Number.isFinite(mid) ? mid : left / 2 + right / 2);
}

/**
 * Interpolación lineal: 0 cuando value <= low, 1 cuando value >= high,
 * interpolado en medio. Valores fuera de rango se ajustan a 0 o 1.
 */
export function linear(value: number, low: number, high: number): number {
  // Ataque: un ratio NaN (Infinity/Infinity) llegaba hasta aquí y se
  // propagaba a todas las medidas. Se trunca a 0, extremo seguro y finito.
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 0;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return finite((value - low) / (high - low));
}

/** Distancia euclídea en 2D. */
export function distance(dx: number, dy: number): number {
  // Ataque: NaN en dx/dy y desbordamiento al elevar al cuadrado (1e308).
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  const result = Math.sqrt(dx * dx + dy * dy);
  if (Number.isFinite(result)) return result;
  const scale = Math.max(Math.abs(dx), Math.abs(dy));
  return finite(scale * Math.sqrt((dx / scale) ** 2 + (dy / scale) ** 2));
}
