// Recalibración LOCAL y OPCIONAL a partir de una sesión que el propio usuario
// recolecta (checklist L224). Contrato de seguridad:
//
//  - POR SESIÓN: el objeto de entrada se interpreta y se olvida; no se guarda
//    nada entre llamadas, ni en memoria global, ni en almacenamiento.
//  - EN MEMORIA: sin red, sin cookies, sin localStorage/sessionStorage.
//  - ACOTADA: los factores siempre están en [0.8, 1.2] (±20 %) y los umbrales
//    resultantes en rangos seguros absolutos. Sesiones distintas producen
//    ajustes distintos dentro de esos límites; no hay valores constantes.
//  - FAIL-CLOSED: NINGÚN campo puede fijar un veredicto ni desactivar una
//    compuerta de evidencia. El resultado solo contiene dos factores numéricos
//    que ajustan umbrales; no existe `state`, `verdict`, `trusted`, `bypass`.
//    Una sesión sin evidencia (`applied: false`) deja los umbrales intactos:
//    la recalibración NUNCA puede convertir "sin evidencia" en "humano".
//
// Todo es numérico: se leen tiempos y categorías, nunca teclas, texto ni
// contenido. Ningún acceso a DOM (tampoco al importar).

import { clamp, mean, median } from "../utils/math";

/** Sesión cruda, ya anonimizada por los colectores (solo números). */
export interface CalibrationSession {
  keys?: Array<{ t: number; kind: number; category: number; trusted?: number }>;
  inputs?: Array<{ t: number; inputType: number; trusted?: number }>;
  points?: Array<{ t: number; x: number; y: number; trusted?: number }>;
  clicks?: Array<{ t: number; x: number; y: number; trusted?: number }>;
  scrolls?: Array<{ t: number; dx: number; dy: number; trusted?: number }>;
}

/**
 * Resultado de la recalibración. `adjustments.pauseMs` y
 * `adjustments.rhythmTolerance` son MULTIPLICADORES en [0.8, 1.2], donde 1 es
 * neutro. `applied` solo indica que hubo muestras suficientes para estimar un
 * ritmo; NO es un veredicto ni una autorización.
 */
export interface CalibrationResult {
  applied: boolean;
  samples: number;
  adjustments: Record<string, number>;
  reasons: string[];
}

/** Mínimos para estimar un ritmo con robustez. */
const MIN_KEY_DOWNS = 12;
const MIN_POINTER_SAMPLES = 20;
/** Tope de lectura por array: evita que una entrada hostil haga trabajo infinito. */
const MAX_ARRAY = 4096;

/** Cota de los factores: ±20 %. */
const FACTOR_MIN = 0.8;
const FACTOR_MAX = 1.2;
/** Sensibilidad del ajuste a la desviación del ritmo respecto de la referencia. */
const RHYTHM_SLOPE = 0.4;
/** Decimales con los que se publican los factores (determinismo). */
const FACTOR_PRECISION = 1000;

// Referencias humanas (p50, ms): perfil de tecleo calibrado y muestreo de
// puntero habitual. No son umbrales de decisión, solo escalas de comparación.
const KEY_INTERVAL_REF = 190;
const KEY_HOLD_REF = 90;
const POINTER_INTERVAL_REF = 45;

/** Umbrales absolutos de los parámetros que se pueden ajustar. */
const PAUSE_MIN = 400;
const PAUSE_MAX = 3000;
const RHYTHM_MIN = 0.1;
const RHYTHM_MAX = 0.9;
/** Defaults neutrales para bases ausentes o no finitas. */
const PAUSE_DEFAULT = 1000;
const RHYTHM_DEFAULT = 0.5;

interface ParsedKey {
  t: number;
  kind: 0 | 1;
  category: number | null;
}

/** Lectura propia y segura: un Proxy/hostil que lanza se resuelve como ausente. */
function read(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    if (!Object.hasOwn(value, key)) return undefined;
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Array acotado: nunca confiamos en `length` ni en getters de un objeto hostil. */
function limitedArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const size = Math.min(value.length, MAX_ARRAY);
    const out: unknown[] = [];
    for (let i = 0; i < size; i += 1) {
      out.push(value[i]);
    }
    return out;
  } catch {
    return [];
  }
}

/** Tiempo utilizable: finito, no negativo y número (no cadena ni booleano). */
function finiteTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Intervalos consecutivos de una serie ordenada de marcas de tiempo. */
function intervals(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i] - sorted[i - 1];
    if (Number.isFinite(delta) && delta >= 0) out.push(delta);
  }
  return out;
}

/** Factor acotado a ±20 % y redondeado (sin ruido de coma flotante). */
function boundedFactor(raw: number): number {
  const bounded = clamp(raw, FACTOR_MIN, FACTOR_MAX);
  const rounded = Math.round(bounded * FACTOR_PRECISION) / FACTOR_PRECISION;
  // El redondeo no puede sacarlo del rango (0.8/1.2 ya son múltiplos).
  return clamp(rounded, FACTOR_MIN, FACTOR_MAX);
}

/**
 * Deriva ajustes acotados de una sesión anonimizada.
 *
 * Se estiman tres distribuciones robustas (medianas): intervalos entre
 * keydowns, duraciones de pulsación (hold) e intervalos de puntero (points +
 * clicks + scrolls). Cada mediana se compara con su referencia humana; la
 * media de esas razones decide cuánto se estrecha o se abre cada umbral.
 * Un ritmo muy rápido/mecánico produce factores MÁS ESTRICTOS, nunca una
 * dispensa. Todo campo ajeno al contrato se ignora.
 */
export function calibrationFromSession(session: unknown): CalibrationResult {
  const keys: ParsedKey[] = [];
  const pointerTimes: number[] = [];
  let invalid = 0;

  for (const raw of limitedArray(read(session, "keys"))) {
    const t = finiteTime(read(raw, "t"));
    const kind = read(raw, "kind");
    const category = read(raw, "category");
    if (t === null || (kind !== 0 && kind !== 1)) {
      invalid += 1;
      continue;
    }
    const cat = typeof category === "number" && Number.isFinite(category) ? category : null;
    keys.push({ t, kind, category: cat });
  }

  for (const field of ["points", "clicks", "scrolls"] as const) {
    for (const raw of limitedArray(read(session, field))) {
      const t = finiteTime(read(raw, "t"));
      if (t === null) {
        invalid += 1;
        continue;
      }
      pointerTimes.push(t);
    }
  }

  // `inputs` participa en el conteo de muestras válidas, pero no altera los
  // ritmos: su inputType es categoría, no tiempo de pulsación.
  let inputCount = 0;
  for (const raw of limitedArray(read(session, "inputs"))) {
    if (finiteTime(read(raw, "t")) === null) invalid += 1;
    else inputCount += 1;
  }

  const keyDownTimes: number[] = [];
  const holds: number[] = [];
  const lastDown = new Map<number, number>();

  // Ordenar primero: empareja holds aunque la sesión llegue desordenada.
  keys.sort((a, b) => a.t - b.t);
  for (const sample of keys) {
    if (sample.kind === 0) {
      keyDownTimes.push(sample.t);
      if (sample.category !== null) lastDown.set(sample.category, sample.t);
      continue;
    }
    if (sample.category === null) continue;
    const down = lastDown.get(sample.category);
    if (down === undefined) continue;
    const hold = sample.t - down;
    if (Number.isFinite(hold) && hold >= 0) holds.push(hold);
    lastDown.delete(sample.category);
  }

  const pointerCount = pointerTimes.length;
  const validSamples = keys.length + pointerCount + inputCount;
  const enoughKeys = keyDownTimes.length >= MIN_KEY_DOWNS;
  const enoughPointer = pointerCount >= MIN_POINTER_SAMPLES;

  const reasons: string[] = [];
  if (invalid > 0) reasons.push("ignored-invalid-samples");
  if (!enoughKeys && !enoughPointer) {
    reasons.push("insufficient-samples");
    return { applied: false, samples: validSamples, adjustments: {}, reasons };
  }

  // Una mediana con al menos dos intervalos es robusta; razón 0 (marcas
  // idénticas) es máximamente estricta, no neutra.
  const ratios: number[] = [];
  if (keyDownTimes.length >= 3) {
    ratios.push(median(intervals(keyDownTimes)) / KEY_INTERVAL_REF);
  }
  if (holds.length >= 2) {
    ratios.push(median(holds) / KEY_HOLD_REF);
  }
  if (pointerCount >= 3) {
    ratios.push(median(intervals(pointerTimes)) / POINTER_INTERVAL_REF);
  }

  const averaged = ratios.length > 0 ? mean(ratios) : 1;
  const ratio = Number.isFinite(averaged) && averaged > 0 ? averaged : 0;
  const deviation = ratio - 1;

  // Ritmo: más veloz que lo humano -> tolerancia MÁS estrecha (factor < 1).
  // Pausa: más veloz que lo humano -> umbral de pausa MÁS alto (factor > 1),
  // para que un bot no gane pausas "humanas" por acortar el umbral.
  const rhythmFactor = boundedFactor(1 + deviation * RHYTHM_SLOPE);
  const pauseFactor = boundedFactor(1 - deviation * RHYTHM_SLOPE);

  if (enoughKeys) reasons.push("calibrated-from-keys");
  if (enoughPointer) reasons.push("calibrated-from-pointer");
  if (holds.length >= 2) reasons.push("hold-median-used");
  reasons.push("bounded-adjustments");

  return {
    applied: true,
    samples: validSamples,
    adjustments: { pauseMs: pauseFactor, rhythmTolerance: rhythmFactor },
    reasons,
  };
}

/**
 * Aplica los factores NUEVAMENTE acotados y clampa los umbrales a rangos
 * seguros. Devuelve SOLO dos números: no hay veredicto, ni bandera, ni forma
 * de desactivar una compuerta. Un resultado no aplicado (o hostil) deja los
 * umbrales base intactos, dentro de los rangos.
 */
export function applyCalibration(
  base: { pauseMs: number; rhythmTolerance: number },
  result: CalibrationResult,
): { pauseMs: number; rhythmTolerance: number } {
  let pauseMs = PAUSE_DEFAULT;
  let rhythmTolerance = RHYTHM_DEFAULT;
  try {
    if (base && typeof base === "object") {
      const rawPause = (base as { pauseMs?: unknown }).pauseMs;
      const rawRhythm = (base as { rhythmTolerance?: unknown }).rhythmTolerance;
      if (typeof rawPause === "number" && Number.isFinite(rawPause)) pauseMs = rawPause;
      if (typeof rawRhythm === "number" && Number.isFinite(rawRhythm)) {
        rhythmTolerance = rawRhythm;
      }
    }
  } catch {
    // Bases hostiles -> defaults neutrales.
  }

  let pauseFactor = 1;
  let rhythmFactor = 1;
  try {
    if (result && typeof result === "object" && result.applied === true) {
      const adjustments = result.adjustments as Record<string, unknown> | undefined;
      if (adjustments && typeof adjustments === "object") {
        const rawPause = adjustments.pauseMs;
        const rawRhythm = adjustments.rhythmTolerance;
        // Re-clamp: un resultado forjado con factores fuera de rango no puede
        // sortear los límites ni conceder una dispensa.
        if (typeof rawPause === "number" && Number.isFinite(rawPause)) {
          pauseFactor = clamp(rawPause, FACTOR_MIN, FACTOR_MAX);
        }
        if (typeof rawRhythm === "number" && Number.isFinite(rawRhythm)) {
          rhythmFactor = clamp(rawRhythm, FACTOR_MIN, FACTOR_MAX);
        }
      }
    }
  } catch {
    // Resultado hostil -> factores neutros.
  }

  return {
    pauseMs: clamp(pauseMs * pauseFactor, PAUSE_MIN, PAUSE_MAX),
    rhythmTolerance: clamp(rhythmTolerance * rhythmFactor, RHYTHM_MIN, RHYTHM_MAX),
  };
}
