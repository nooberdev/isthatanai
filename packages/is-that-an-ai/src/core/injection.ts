// Señales ligadas al entorno y a las trampas: eventos creados por código (L149),
// dispositivo declarado vs. comportamiento (L150), eventos inyectados (L213) y
// "humanización" por fórmula (L215).
//
// SIN DOM al importar, SIN red, SIN storage. NUNCA se lee el código fuente del
// evento ni cadenas (`key`, `code`, `inputType` como texto): todo son números.
// Las señales de inyección usan SOLO `trusted === 0` y precisión temporal
// implausible (intervalos idénticos al redondear a 1ms, holds de 0ms).
//
// Todas las funciones devuelven [0,1], 1 = más sospechoso; 0 con datos vacíos
// o sin patrón (no se inventa evidencia). Las marcas de tiempo no finitas se
// descartan: son datos corruptos, NO evidencia de IA (fail-closed).
//
// Umbrales documentados (todos interpolados con `linear`):
// - `injectionRisk`: share de eventos no confiables 0.02 -> 0, 0.3 -> 1;
//   share de intervalos repetidos exactamente 0.2 -> 0, 0.6 -> 1; share de
//   holds keydown->keyup de <1ms 0.05 -> 0, 0.3 -> 1. Se combinan como unión
//   probabilística: 1-(1-untrusted)*(1-precision).
// - `humanizationRisk`: ciclo de 2..8 intervalos que se repite con jitter <=2ms;
//   match >=0.4 -> 0, >=0.8 -> 1; jitter medio 1ms -> 1, 4ms -> 0. Exige 8+
//   intervalos, 2..8 valores distintos (un metrónomo no es "humanización").
//   Ruido demasiado uniforme: spread/mediana <=0.25 y 60%+ de valores
//   distintos -> hasta 1.
// - `declaredVsBehavior`: `auto` o sin datos -> 0; perfil coincidente -> 0;
//   contradicción dura (ratón declarado táctil, texto declarado mando, etc.)
//   -> 1; cualquier otra discrepancia -> 0.75.

import type { InputSample, KeySample, PointerSample } from "../types";
import { clamp, linear, mean } from "../utils/math";
import { inferDeviceProfile } from "./device-profile";

const UNTRUSTED_LOW = 0.02;
const UNTRUSTED_HIGH = 0.3;
const REPEAT_LOW = 0.2;
const REPEAT_HIGH = 0.6;
const ZERO_HOLD_LOW = 0.05;
const ZERO_HOLD_HIGH = 0.3;
const MIN_HOLD_MS = 1;

const MIN_HUMANIZATION_INTERVALS = 8;
const MAX_CYCLE_DISTINCT = 8;
const PERIOD_MIN = 2;
/** Un ciclo de 7 u 8 intervalos cabe en el límite de 8 valores distintos. */
const PERIOD_MAX = MAX_CYCLE_DISTINCT;
const MATCH_TOLERANCE_MS = 2;
const MATCH_LOW = 0.4;
const MATCH_HIGH = 0.8;
const JITTER_LOW = 1;
const JITTER_HIGH = 4;
const UNIFORM_SPREAD_LOW = 0.25;
const UNIFORM_SPREAD_HIGH = 0.6;
const UNIFORM_RICH_LOW = 0.6;
const UNIFORM_RICH_HIGH = 0.9;

/** Resultado siempre finito en [0,1]: NaN/Infinity se convierten en "sin evidencia". */
function safe01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/** Solo marcas finitas: NaN/Infinity no generan intervalos ni patrones falsos. */
function finiteTimes(times: number[]): number[] {
  return times.filter((t) => typeof t === "number" && Number.isFinite(t));
}

/** Intervalos positivos entre tiempos ordenados (copia, sin mutar la entrada). */
function intervals(times: number[]): number[] {
  const sorted = [...finiteTimes(times)].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i] - sorted[i - 1];
    if (dt > 0 && Number.isFinite(dt)) out.push(dt);
  }
  return out;
}

function keyDownTimes(keys: KeySample[]): number[] {
  const out: number[] = [];
  for (const key of keys) if (key.kind === 0) out.push(key.t);
  return out;
}

function pointerMoveTimes(samples: PointerSample[]): number[] {
  const out: number[] = [];
  for (const sample of samples) if (sample.kind === 0) out.push(sample.t);
  return out;
}

function inputTimes(inputs: InputSample[]): number[] {
  return inputs.map((input) => input.t);
}

/**
 * Share de intervalos redondeados a 1ms que repiten un valor ya visto. Un
 * `setInterval` concentra casi todos; el jitter humano reparte los valores.
 */
function repeatedIntervalShare(times: number[]): number | null {
  const ds = intervals(times);
  if (ds.length < 3) return null;
  const seen = new Set<number>();
  let repeats = 0;
  for (const dt of ds) {
    const rounded = Math.round(dt);
    if (seen.has(rounded)) repeats += 1;
    seen.add(rounded);
  }
  return repeats / ds.length;
}

/** Holds keydown->keyup de menos de 1ms: artefacto de despacho sintético. */
function zeroHoldShare(keys: KeySample[]): number | null {
  let holds = 0;
  let zero = 0;
  for (let i = 0; i + 1 < keys.length; i += 1) {
    if (keys[i].kind !== 0 || keys[i + 1].kind !== 1) continue;
    const start = keys[i].t;
    const end = keys[i + 1].t;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const duration = end - start;
    if (duration < 0 || !Number.isFinite(duration)) continue;
    holds += 1;
    if (duration < MIN_HOLD_MS) zero += 1;
  }
  return holds === 0 ? null : zero / holds;
}

/**
 * Riesgo de evento creado por código / inyectado (L149, L213). No mira el
 * código fuente ni el tipo de evento: solo confianza y precisión temporal.
 * Con listas vacías devuelve 0. Las muestras con `t` no finito se ignoran.
 */
export function injectionRisk(
  keys: KeySample[],
  inputs: InputSample[],
  samples: PointerSample[],
): number {
  const validKeys = keys.filter((key) => Number.isFinite(key.t));
  const validInputs = inputs.filter((input) => Number.isFinite(input.t));
  const validSamples = samples.filter((sample) => Number.isFinite(sample.t));
  if (validKeys.length === 0 && validInputs.length === 0 && validSamples.length === 0) return 0;

  let total = 0;
  let untrusted = 0;
  for (const key of validKeys) {
    total += 1;
    if (key.trusted === 0) untrusted += 1;
  }
  for (const input of validInputs) {
    total += 1;
    if (input.trusted === 0) untrusted += 1;
  }
  for (const sample of validSamples) {
    total += 1;
    if (sample.trusted === 0) untrusted += 1;
  }
  const untrustedScore = total === 0 ? 0 : linear(untrusted / total, UNTRUSTED_LOW, UNTRUSTED_HIGH);

  const repeatShares = [
    repeatedIntervalShare(pointerMoveTimes(validSamples)),
    repeatedIntervalShare(keyDownTimes(validKeys)),
    repeatedIntervalShare(inputTimes(validInputs)),
  ].filter((value): value is number => value !== null);
  const repeatScore =
    repeatShares.length === 0
      ? 0
      : linear(
          repeatShares.reduce((sum, value) => sum + value, 0) / repeatShares.length,
          REPEAT_LOW,
          REPEAT_HIGH,
        );

  const holdShare = zeroHoldShare(validKeys);
  const holdScore = holdShare === null ? 0 : linear(holdShare, ZERO_HOLD_LOW, ZERO_HOLD_HIGH);

  const precisionScore = Math.max(repeatScore, holdScore);
  return safe01(1 - (1 - untrustedScore) * (1 - precisionScore));
}

/** Puntuación de un ciclo/jitter periódico en una serie de intervalos. */
function cycleScore(intervalsMs: number[]): number {
  const n = intervalsMs.length;
  if (n < MIN_HUMANIZATION_INTERVALS) return 0;
  const rounded = intervalsMs.map((dt) => Math.round(dt));
  const distinct = new Set(rounded).size;
  // 1 valor = metrónomo (lo detecta `injectionRisk`); >8 = ruido demasiado
  // variado para ser una fórmula de ciclo corto.
  if (distinct < 2 || distinct > MAX_CYCLE_DISTINCT) return 0;

  let best = 0;
  for (let period = PERIOD_MIN; period <= PERIOD_MAX; period += 1) {
    let pairs = 0;
    let matches = 0;
    let jitterSum = 0;
    for (let i = 0; i + period < n; i += 1) {
      pairs += 1;
      const diff = Math.abs(rounded[i] - rounded[i + period]);
      if (diff <= MATCH_TOLERANCE_MS) {
        matches += 1;
        jitterSum += diff;
      }
    }
    if (pairs === 0) continue;
    const matchShare = matches / pairs;
    const meanJitter = matches === 0 ? Number.POSITIVE_INFINITY : jitterSum / matches;
    const score =
      linear(matchShare, MATCH_LOW, MATCH_HIGH) * (1 - linear(meanJitter, JITTER_LOW, JITTER_HIGH));
    if (score > best) best = score;
  }
  return best;
}

/**
 * Ruido aleatorio "demasiado uniforme": muchos valores distintos pero dentro
 * de una banda estrecha. Es la otra forma de humanización falsa: no hay ciclo,
 * pero la distribución es plana y no tiene las pausas del tecleo humano.
 */
function uniformNoiseScore(intervalsMs: number[]): number {
  if (intervalsMs.length < MIN_HUMANIZATION_INTERVALS) return 0;
  const average = mean(intervalsMs);
  if (!Number.isFinite(average) || average <= 1e-9) return 0;
  // Bucles en vez de `Math.max(...xs)`: un array enorme no desborda la pila.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const dt of intervalsMs) {
    if (dt < min) min = dt;
    if (dt > max) max = dt;
  }
  const spread = (max - min) / average;
  // Cuantizar a 0.1 ms, no a 1 ms: redondear a 1 ms colapsa el jitter de banda
  // estrecha (p. ej. `100 + Math.random()*20`) a ~20 valores enteros y `rich`
  // cae bajo el umbral aunque cada retardo sea distinto. El metrónomo sigue
  // dando un solo valor (rich ~ 0) y el ruido irregular sigue teniendo spread
  // alto, así que ninguno se confunde con humanización falsa.
  const rich = new Set(intervalsMs.map((dt) => Math.round(dt * 10))).size / intervalsMs.length;
  return (
    (1 - linear(spread, UNIFORM_SPREAD_LOW, UNIFORM_SPREAD_HIGH)) *
    linear(rich, UNIFORM_RICH_LOW, UNIFORM_RICH_HIGH)
  );
}

/** Humanización falsa detectada SOLO con intervalos numéricos (L215). */
function fakeHumanizationScore(intervalsMs: number[]): number {
  return Math.max(cycleScore(intervalsMs), uniformNoiseScore(intervalsMs));
}

/**
 * Riesgo de "humanización" por fórmula: jitter periódico de ciclo corto o ruido
 * uniforme de banda estrecha. Teclado y mutaciones de texto se analizan por
 * separado y se toma el mayor; con menos de 8 intervalos devuelve 0.
 */
export function humanizationRisk(keys: KeySample[], inputs: InputSample[]): number {
  const keyScore = fakeHumanizationScore(intervals(keyDownTimes(keys)));
  const inputScore = fakeHumanizationScore(intervals(inputTimes(inputs)));
  return safe01(Math.max(keyScore, inputScore));
}

/**
 * Discrepancia entre el dispositivo declarado y el inferido de las muestras
 * (L150). Usa `inferDeviceProfile` en modo solo lectura. `auto`, datos vacíos
 * y perfiles coincidentes son neutros (0): no se penaliza la inferencia.
 */
export function declaredVsBehavior(
  device: string,
  samples: PointerSample[],
  keys: KeySample[],
  inputs: InputSample[],
): number {
  if (device === "auto") return 0;
  if (samples.length === 0 && keys.length === 0 && inputs.length === 0) return 0;
  if (device !== "desktop" && device !== "touch" && device !== "tv") {
    return 0; // Declaración desconocida: no hay comparación posible.
  }

  const inferred = inferDeviceProfile(samples, keys, inputs);
  if (inferred === device) return 0;

  // Contradicciones duras: el comportamiento muestra la modalidad opuesta a la
  // declarada, no solo una ausencia de evidencia.
  const hasMouseMovement = samples.some((sample) => sample.kind === 0 && sample.pointerType === 0);
  const hasNonMousePointer = samples.some((sample) => sample.pointerType !== 0);
  const hardContradiction =
    (device === "touch" && hasMouseMovement) ||
    (device === "desktop" && hasNonMousePointer) ||
    (device === "tv" && inputs.length > 0);

  return hardContradiction ? 1 : 0.75;
}
