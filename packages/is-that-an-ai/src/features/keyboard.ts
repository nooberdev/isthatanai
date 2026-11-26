// Medidas puras de teclado: funciones sobre KeySample[] e InputSample[].
// SIN DOM, SIN eventos, SIN texto. Cada medida en [0,1] donde 1 = más IA.
//
// Umbrales documentados (se saturan con `linear`):
// 1. intervalRegularity     - CV de intervalos keydown->keydown:
//                             <=0.05 -> 1, >=0.35 -> 0. Umbral endurecido:
//                             70-200ms aleatorios (CV ~0.28) apenas puntúa;
//                             solo un ritmo casi perfecto suma.
// 2. holdRegularity         - CV de duraciones keydown->keyup:
//                             <=0.08 -> 1, >=0.5 -> 0. Si la duración media
//                             es < MIN_HOLD_MS (20ms) la medida devuelve 0:
//                             es un artefacto de automatización de prueba
//                             (CDP/agentes que sueltan la tecla al instante),
//                             NO evidencia de bot. Un humano real mantiene la
//                             tecla pulsada > 20ms.
// 3. correctionBursts       - borrados (cat 3) consecutivos en <=300ms y
//                             share de borrados: ambos altos -> 1.
// 4. pasteRatio             - ratio de inputType 1/2 (pegado/drop):
//                             <=0.05 -> 0, >=0.4 -> 1.
// 5. textWithoutKeydown     - ratio de inserciones sin keydown en los 400ms
//                             previos: <=0.15 -> 0, >=0.7 -> 1.
// 6. modifierShortcuts      - modificadores (cat 6) que inician un atajo en
//                             <=300ms, por su share sobre los keydowns.
// 7. noPauses               - pausas (>3x mediana, >=800ms): 0 -> 1,
//                             >=0.3 -> 0. Requiere >=3000ms de ventana o
//                             >=24 keydowns: con 20 letras en ~1.7s un humano
//                             no tiene oportunidad de pausar, así que la
//                             medida devuelve 0 (no infla el score).
// 8. exactRhythm            - intervalos keydown repetidos exactamente
//                             (redondeados a 1ms): <=0.15 -> 0, >=0.6 -> 1.
//
// Las medidas de ritmo devuelven NEUTRAL = 0.5 cuando falta muestra; las de
// patrón (borrados, pegado, texto huérfano, atajos, ritmo exacto) devuelven 0
// cuando el patrón no aparece y `computeKeyboardScore` las OMITE (como hace
// scroll con `largeJumps`). Así un humano con pocos datos no puntúa alto.
//
// PESOS DE SCORE (normalizados por la suma de pesos > 0): intervalRegularity
// 0.30, holdRegularity 0.15, correctionBursts 0.10, pasteRatio 0.15,
// textWithoutKeydown 0.20, modifierShortcuts 0.10, noPauses 0.10,
// exactRhythm 0.15.

import type { InputSample, KeySample } from "../types";
import { linear, mean, median, stddev } from "../utils/math";

/** Valor neutro cuando no hay suficientes muestras de ritmo. */
export const KEYBOARD_NEUTRAL = 0.5;

/** Ventana para asociar una inserción de texto con un keydown previo. */
export const KEYDOWN_LOOKBACK_MS = 400;
/** Hueco entre borrados consecutivos que cuenta como ráfaga. */
export const CORRECTION_GAP_MS = 300;
/** Hueco en el que un modificador inicia un atajo. */
export const SHORTCUT_GAP_MS = 300;
/** Duración mínima de pulsación para que la regularidad del hold puntúe. */
export const MIN_HOLD_MS = 20;
/** CV de intervalos: <= 0.05 -> 1, >= 0.35 -> 0. */
export const INTERVAL_CV_LOW = 0.05;
export const INTERVAL_CV_HIGH = 0.35;
/** Factor y suelo para considerar una pausa entre keydowns. */
export const PAUSE_FACTOR = 3;
export const PAUSE_MIN_MS = 800;
/** Muestra mínima antes de que `noPauses` pueda aportar evidencia de IA. */
export const NO_PAUSES_MIN_WINDOW_MS = 3000;
export const NO_PAUSES_MIN_DOWNS = 24;

/**
 * Evidencia mínima para puntuar. Cuatro vías independientes:
 * - 20 keydowns en >= 3000ms (ritmo humano observado largo);
 * - 5 inputs con pegado;
 * - ritmo extremo: >= 12 keydowns con exactRhythm >= 0.6 o
 *   intervalRegularity >= 0.9, SIN exigir ventana larga. Un bot que no se
 *   disfraza debe detectarse en pocos segundos (Playwright `type()` a 60ms
 *   o a 16ms caben aquí con 2400ms / 640ms de muestra).
 * - texto huérfano: >= 3 inputs con textWithoutKeydown >= 0.6, sean
 *   `insertText` (`fill()`) o pegado. No guardamos longitud de texto
 *   (privacidad), así que usamos el NÚMERO de mutaciones como mínimo: coste
 *   asumido, un `fill()` de una sola mutación puede librarse.
 * El ritmo humano normal (pausas, jitter) NO abre la vía extrema: con 30
 * teclas pausadas intervalRegularity ~0 y exactRhythm < 0.6.
 */
export const MIN_KEY_DOWNS = 20;
export const MIN_KEY_WINDOW_MS = 3000;
export const MIN_INPUTS_WITH_PASTE = 5;
/** Vía de ritmo extremo: ni ventana ni 20 teclas, pero patrón inhumano. */
export const EXTREME_RHYTHM_MIN_DOWNS = 12;
export const EXTREME_EXACT_RHYTHM = 0.6;
export const EXTREME_INTERVAL_REGULARITY = 0.9;
/** Vía de texto huérfano: 3 mutaciones, sin leer su contenido/longitud. */
export const ORPHAN_TEXT_MIN_INPUTS = 3;
export const ORPHAN_TEXT_RATIO = 0.6;

export interface KeyboardFeatures {
  intervalRegularity: number;
  holdRegularity: number;
  correctionBursts: number;
  pasteRatio: number;
  textWithoutKeydown: number;
  modifierShortcuts: number;
  noPauses: number;
  exactRhythm: number;
}

const BACKSPACE = 3;
const MODIFIER = 6;
const INSERTS = new Set([0, 1, 2, 3]);

function keyDowns(keys: KeySample[]): KeySample[] {
  return keys.filter((sample) => sample.kind === 0);
}

/** Intervalos estrictamente positivos entre keydowns consecutivos. */
function keyIntervals(downs: KeySample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < downs.length; i += 1) {
    const dt = downs[i].t - downs[i - 1].t;
    if (dt > 0) out.push(dt);
  }
  return out;
}

/** Coeficiente de variación: 0 si hay menos de 2 valores o media ~0. */
function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

/** Ventana cubierta por los keydowns (0 con menos de dos). */
export function keyboardWindowMs(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  return downs.length >= 2 ? downs[downs.length - 1].t - downs[0].t : 0;
}

/** Número de keydowns, para la confianza del score combinado. */
export function countKeyDowns(keys: KeySample[]): number {
  return keyDowns(keys).length;
}

/**
 * Evidencia mínima para puntuar la señal de teclado. Sin ella el score es null
 * y el veredicto siguen mandando las demás señales. Cuatro vías, documentadas
 * junto a sus umbrales más arriba: ventana larga, pegado, ritmo extremo y
 * texto huérfano. Las dos nuevas detectan bots en menos de 3 segundos sin
 * relajar el ritmo humano normal.
 */
export function hasKeyboardEvidence(keys: KeySample[], inputs: InputSample[]): boolean {
  const downCount = countKeyDowns(keys);
  const enoughKeys = downCount >= MIN_KEY_DOWNS && keyboardWindowMs(keys) >= MIN_KEY_WINDOW_MS;

  const pastes = inputs.filter((sample) => sample.inputType === 1 || sample.inputType === 2).length;
  const enoughPastes = inputs.length >= MIN_INPUTS_WITH_PASTE && pastes > 0;

  const extremeRhythm =
    downCount >= EXTREME_RHYTHM_MIN_DOWNS &&
    (keyboardExactRhythm(keys) >= EXTREME_EXACT_RHYTHM ||
      keyboardIntervalRegularity(keys) >= EXTREME_INTERVAL_REGULARITY);

  const orphanText =
    inputs.length >= ORPHAN_TEXT_MIN_INPUTS &&
    keyboardTextWithoutKeydown(keys, inputs) >= ORPHAN_TEXT_RATIO;

  return enoughKeys || enoughPastes || extremeRhythm || orphanText;
}

/** Ritmo de keydowns casi perfecto (CV <= 0.05) es la única prueba fuerte. */
export function keyboardIntervalRegularity(keys: KeySample[]): number {
  const intervals = keyIntervals(keyDowns(keys));
  if (intervals.length < 3) return KEYBOARD_NEUTRAL;
  return 1 - linear(cv(intervals), INTERVAL_CV_LOW, INTERVAL_CV_HIGH);
}

/**
 * Duración de pulsación constante (CV <= 0.08). Los holds casi nulos se
 * descartan: son artefactos de CDP/agentes, no una conducta de bot detectably
 * humana. Un 0 aquí baja el score en vez de inflarlo.
 */
export function keyboardHoldRegularity(keys: KeySample[]): number {
  const holds: number[] = [];
  for (let i = 0; i + 1 < keys.length; i += 1) {
    if (keys[i].kind !== 0 || keys[i + 1].kind !== 1) continue;
    const duration = keys[i + 1].t - keys[i].t;
    if (duration >= 0) holds.push(duration);
  }
  if (holds.length < 3) return KEYBOARD_NEUTRAL;
  if (mean(holds) < MIN_HOLD_MS) return 0;
  return 1 - linear(cv(holds), 0.08, 0.5);
}

/** Ráfaga de correcciones: borrados agrupados y frecuentes. */
export function keyboardCorrectionBursts(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const backs = downs.filter((sample) => sample.category === BACKSPACE);
  if (backs.length < 2) return 0;
  let rapid = 0;
  for (let i = 1; i < backs.length; i += 1) {
    if (backs[i].t - backs[i - 1].t <= CORRECTION_GAP_MS) rapid += 1;
  }
  const burst = rapid / (backs.length - 1);
  const share = backs.length / downs.length;
  return linear(burst, 0.2, 0.8) * linear(share, 0.05, 0.3);
}

/** Ratio de mutaciones que son pegado o arrastre. */
export function keyboardPasteRatio(inputs: InputSample[]): number {
  if (inputs.length === 0) return 0;
  const pastes = inputs.filter((sample) => sample.inputType === 1 || sample.inputType === 2).length;
  return linear(pastes / inputs.length, 0.05, 0.4);
}

/** Inserciones de texto sin ningún keydown en la ventana previa. */
export function keyboardTextWithoutKeydown(keys: KeySample[], inputs: InputSample[]): number {
  const inserts = inputs.filter((sample) => INSERTS.has(sample.inputType));
  if (inserts.length === 0) return 0;
  const downs = keyDowns(keys);
  let orphan = 0;
  for (const input of inserts) {
    let preceded = false;
    for (let i = downs.length - 1; i >= 0; i -= 1) {
      const dt = input.t - downs[i].t;
      if (dt < 0) continue;
      preceded = dt <= KEYDOWN_LOOKBACK_MS;
      break;
    }
    if (!preceded) orphan += 1;
  }
  return linear(orphan / inserts.length, 0.15, 0.7);
}

/** Modificadores que inician atajos y peso de los modificadores en el ritmo. */
export function keyboardModifierShortcuts(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const modifiers = downs.filter((sample) => sample.category === MODIFIER);
  if (modifiers.length < 3) return 0;
  let shortcuts = 0;
  for (const modifier of modifiers) {
    const index = downs.indexOf(modifier);
    for (let j = index + 1; j < downs.length; j += 1) {
      const dt = downs[j].t - modifier.t;
      if (dt > SHORTCUT_GAP_MS) break;
      if (downs[j].category !== MODIFIER) {
        shortcuts += 1;
        break;
      }
    }
  }
  return (
    linear(modifiers.length / downs.length, 0.05, 0.25) *
    linear(shortcuts / modifiers.length, 0.4, 0.9)
  );
}

/**
 * Ausencia de pausas largas entre keydowns. Solo aporta con >=3000ms de
 * ventana o >=24 keydowns; con muestras más cortas un humano que escribe
 * seguido no ha tenido ocasión de pausar, así que devuelve 0 en vez de
 * marcar "sin pausas" (era la causa del falso positivo del E2E).
 */
export function keyboardNoPauses(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const intervals = keyIntervals(downs);
  if (intervals.length < 2) return 0;
  if (keyboardWindowMs(keys) < NO_PAUSES_MIN_WINDOW_MS && downs.length < NO_PAUSES_MIN_DOWNS) {
    return 0;
  }
  const threshold = Math.max(PAUSE_FACTOR * median(intervals), PAUSE_MIN_MS);
  const pauses = intervals.filter((dt) => dt > threshold).length / intervals.length;
  return 1 - linear(pauses, 0, 0.3);
}

/** Repetición exacta de intervalos (bots con `setInterval`). */
export function keyboardExactRhythm(keys: KeySample[]): number {
  const intervals = keyIntervals(keyDowns(keys));
  if (intervals.length < 4) return 0;
  const counts = new Map<number, number>();
  for (const dt of intervals) {
    const rounded = Math.round(dt);
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }
  let repeated = 0;
  for (const amount of counts.values()) if (amount > 1) repeated += amount;
  return linear(repeated / intervals.length, 0.15, 0.6);
}

export function extractKeyboardFeatures(
  keys: KeySample[],
  inputs: InputSample[],
): KeyboardFeatures {
  return {
    intervalRegularity: keyboardIntervalRegularity(keys),
    holdRegularity: keyboardHoldRegularity(keys),
    correctionBursts: keyboardCorrectionBursts(keys),
    pasteRatio: keyboardPasteRatio(inputs),
    textWithoutKeydown: keyboardTextWithoutKeydown(keys, inputs),
    modifierShortcuts: keyboardModifierShortcuts(keys),
    noPauses: keyboardNoPauses(keys),
    exactRhythm: keyboardExactRhythm(keys),
  };
}

/** Pesos documentados en el encabezado (se normalizan al sumar). */
export const KEYBOARD_FEATURE_WEIGHTS = {
  intervalRegularity: 0.3,
  holdRegularity: 0.15,
  correctionBursts: 0.1,
  pasteRatio: 0.15,
  textWithoutKeydown: 0.2,
  modifierShortcuts: 0.1,
  noPauses: 0.1,
  exactRhythm: 0.15,
} as const satisfies Readonly<Record<keyof KeyboardFeatures, number>>;

/** Medidas de patrón: un 0 significa "no aparece", no "humano": se omiten. */
const PATTERN_FEATURES = new Set<keyof KeyboardFeatures>([
  "correctionBursts",
  "pasteRatio",
  "textWithoutKeydown",
  "modifierShortcuts",
  "exactRhythm",
]);

/** Score de la señal de teclado (1 = IA). */
export function computeKeyboardScore(features: KeyboardFeatures): number {
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(KEYBOARD_FEATURE_WEIGHTS) as Array<keyof KeyboardFeatures>) {
    const weight = KEYBOARD_FEATURE_WEIGHTS[key];
    const value = features[key];
    if (weight <= 0 || typeof value !== "number" || !Number.isFinite(value)) continue;
    if (PATTERN_FEATURES.has(key) && value <= 0) continue;
    weighted += weight * Math.min(1, Math.max(0, value));
    total += weight;
  }
  return total > 0 ? weighted / total : KEYBOARD_NEUTRAL;
}

/** Razones legibles, ordenadas por contribución (máximo `top`). */
export function keyboardReasons(features: KeyboardFeatures, top = 2): string[] {
  const texts: Record<keyof KeyboardFeatures, string> = {
    intervalRegularity: "Ritmo de tecleo demasiado regular",
    holdRegularity: "Pulsaciones de igual duración",
    correctionBursts: "Ráfagas de borrado repetidas",
    pasteRatio: "Texto insertado mediante pegado",
    textWithoutKeydown: "Aparece texto sin teclas previas",
    modifierShortcuts: "Atajos de teclado repetidos",
    noPauses: "Sin pausas al teclear",
    exactRhythm: "Intervalos de tecleo idénticos",
  };
  return (Object.keys(features) as Array<keyof KeyboardFeatures>)
    .map((key) => ({ key, value: features[key], weight: KEYBOARD_FEATURE_WEIGHTS[key] }))
    .filter((entry) => entry.weight > 0 && entry.value >= 0.55)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, top)
    .map((entry) => texts[entry.key]);
}
