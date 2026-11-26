// Utilidades de forma de datos para el modo "solo agregados" (checklist L205,
// L206, L207). Funciones puras y numéricas: SIN red, SIN almacenamiento, SIN
// DOM al importar y SIN guardar identidad de teclas ni texto.
//
// El redondeo elimina la precisión que permitiría usar un timing como
// identificador. Los agregados solo exponen conteos y tiempos redondeados: las
// marcas crudas (timestamps) y cualquier dato de identidad se descartan.

/** Paso de redondeo por defecto, en milisegundos. */
const DEFAULT_STEP = 50;

/**
 * Redondea un tiempo a múltiplos de `step` (50 ms por defecto).
 *
 * Defensivo: no finito (NaN/±Infinity) -> 0; negativo -> 0; paso no finito o
 * no positivo -> paso por defecto; un resultado que desbordara -> 0. Nunca
 * devuelve NaN/Infinity, para que un valor hostil no se convierta en un
 * identificador ni contamine un agregado.
 */
export function roundTiming(t: number, step = DEFAULT_STEP): number {
  if (!Number.isFinite(t)) return 0;
  const safeStep = Number.isFinite(step) && step > 0 ? step : DEFAULT_STEP;
  const value = Math.max(t, 0);
  const rounded = Math.round(value / safeStep) * safeStep;
  return Number.isFinite(rounded) ? rounded : 0;
}

// Claves que NUNCA se publican: marcas crudas, identificadores y contenido.
// Se comprueban PRIMERO (fail-closed); `key(?!count)` permite `keyCount` (un
// conteo agregado) pero descarta `key`/`keyId` (identidad de tecla).
const FORBIDDEN_KEY =
  /timestamp|eventat|last.*at|epoch|raw|identity|identit|letter|char|text|value|code|key(?!count)|payload|clipboard|secret|password/i;

// Claves que representan agregados numéricos legítimos.
//  - conteo: entero no negativo de eventos/muestras (jamás una identidad);
//  - timing: duración, intervalo o percentil en ms (jamás una marca absoluta).
// Las razones, fill ratios y tasas NO son ni conteos ni tiempos: se excluyen.
const COUNT_KEY = /(count|total|^n$)/i;
const TIMING_KEY =
  /ms|duration|interval|mean|median|average|avg|p10|p50|p90|sd|stddev|hold|pause|elapsed|wpm/i;

type AggregateKind = "count" | "timing" | null;

function classify(key: string): AggregateKind {
  if (typeof key !== "string") return null;
  if (FORBIDDEN_KEY.test(key)) return null;
  if (COUNT_KEY.test(key)) return "count";
  if (TIMING_KEY.test(key)) return "timing";
  return null;
}

/**
 * Proyecta un objeto de estadísticas a SOLO dos clases de dato (modo "solo
 * agregados", L205):
 *
 *  EXPUESTO:
 *    - conteos -> enteros no negativos (`...Count`, `total...`, `n`);
 *    - tiempos agregados -> duraciones/intervalos/percentiles redondeados a
 *      múltiplos de 50 ms (`...Ms`, `duration...`, `mean...`, `p50...`, ...).
 *
 *  NUNCA EXPUESTO:
 *    - marcas de tiempo crudas (`timestamp`, `timeStamp`, `lastEventAt`,
 *      `eventAt`, `epoch`, `rawT`, `t`): son identificadores de sesión;
 *    - identidad o contenido (`key`, `keyId`, `letter`, `char`, `text`,
 *      `value`, `code`, `data`, `clipboard`, `password`, `secret`);
 *    - razones/tasas y cualquier valor no numérico, array u objeto anidado.
 *
 * Un nombre ambiguo se resuelve fail-closed: si coincide con una prohibición
 * se descarta aunque también parezca un conteo/tiempo. Los getters que lanzan
 * se ignoran: no pueden derribar al llamador ni filtrar un valor (L206).
 */
export function aggregatesOnlyStats(stats: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stats || typeof stats !== "object") return out;

  let keys: string[];
  try {
    keys = Object.keys(stats);
  } catch {
    return out;
  }

  for (const key of keys) {
    const kind = classify(key);
    if (kind === null) continue;

    let value: unknown;
    try {
      value = stats[key];
    } catch {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;

    if (kind === "count") {
      const rounded = Math.floor(value);
      out[key] = Number.isFinite(rounded) && rounded >= 0 ? rounded : 0;
    } else {
      out[key] = roundTiming(value);
    }
  }
  return out;
}

/** Valor que activa DNT (cabecera/propiedad estándar "1", o 1/true). */
function isDnt(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

/**
 * ¿El entorno pide "no rastrear"? (checklist L207).
 *
 * Si se inyecta una pista (`hints.doNotTrack`) se usa esa y NO se consulta el
 * navegador. En su defecto se lee `navigator.doNotTrack` / `msDoNotTrack`,
 * ÚNICAMENTE dentro de la llamada (nunca al importar ni en un constructor).
 * Cualquier valor desconocido, getter que lanza o entorno SSR -> false.
 */
export function doNotTrack(hints?: { doNotTrack?: unknown }): boolean {
  if (hints && typeof hints === "object") {
    try {
      if (Object.hasOwn(hints, "doNotTrack")) {
        return isDnt((hints as { doNotTrack?: unknown }).doNotTrack);
      }
    } catch {
      return false;
    }
  }

  try {
    const nav = globalThis.navigator as
      | { doNotTrack?: unknown; msDoNotTrack?: unknown }
      | undefined;
    if (!nav || typeof nav !== "object") return false;

    let value: unknown;
    try {
      value = nav.doNotTrack;
    } catch {
      value = undefined;
    }
    if (isDnt(value)) return true;
    try {
      value = nav.msDoNotTrack;
    } catch {
      return false;
    }
    return isDnt(value);
  } catch {
    return false;
  }
}
