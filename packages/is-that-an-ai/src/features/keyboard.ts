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
// CALIBRACIÓN CON SESIÓN HUMANA REAL (`src/calibration/human-typing.ts`):
// - `noPauses`: una pausa >= 1000ms observada en el humano basta para devolver
//   0. Exigir que el 30% de los intervalos sean pausas marcaba esa sesión como
//   "sin pausas" y la dejaba en 0.248, rozando el umbral de HUMAN_MAX (0.25).
// - `exactRhythm`: se mide la DIVERSIDAD de intervalos (valores distintos /
//   total), no si algún valor se repite. El humano tiene 20 distintos de 26;
//   un bot con `setInterval` o un ciclo corto de delays concentra pocos valores.
//
// PESOS DE SCORE (normalizados por la suma de pesos > 0): intervalRegularity
// 0.30, holdRegularity 0.15, correctionBursts 0.10, pasteRatio 0.15,
// textWithoutKeydown 0.20, modifierShortcuts 0.10, noPauses 0.10,
// exactRhythm 0.15.

import {
  EXACT_RHYTHM_UNIQUE_HIGH,
  EXACT_RHYTHM_UNIQUE_LOW,
  HUMAN_PAUSE_MS,
} from "../calibration/human-typing";
import type { DeviceProfile, InputSample, KeySample } from "../types";
import { clamp, linear, mean, median, stddev } from "../utils/math";

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

/**
 * Intervalo mediano por debajo del cual una cadencia ya no es de mando
 * físico: un mando a distancia no produce pulsaciones cada <150 ms de forma
 * sostenida. Por encima, las medidas de ritmo se neutralizan en perfil tv.
 */
export const TV_MIN_INTERVAL_MS = 150;

// ---------------------------------------------------------------------------
// Medidas parciales del checklist (ritmo y comportamiento). Todas son puras,
// numéricas y en [0,1] con 1 = más IA, salvo `autocompleteFalsePositive` (1 =
// "probable autocompletado/contraseña", NO tratar como bot). Se registran en
// `KeyboardFeatures` con peso 0 para no alterar los scores existentes. No leen
// ni guardan cadenas: solo categorías, tiempos, `kind` y `trusted`.
//
// Umbrales documentados de cada medida (se saturan con `linear`):
// 9. intervalDistribution  - share de intervalos dentro de ±15% de la mediana:
//                            <=0.2 -> 0 (distribución ancha, humana),
//                            >=0.65 -> 1 (concentrada/metrónomo). <4 -> NEUTRAL.
// 10. typingSpeed          - teclas imprimibles por segundo:
//                            <=6 -> 0, >=14 -> 1 (imposible a mano). <3 -> NEUTRAL.
// 11. pauseAfterError      - pausa media tras un borrar (ms):
//                            <=80 -> 1 (corrección instantánea, bot),
//                            >=300 -> 0 (humano se detiene). Sin borrar -> 0.
// 12. wordPauses           - share de espacios con pausa >=1.5x el intervalo
//                            entre letras: <=0.2 -> 1 (sin pausa de palabra),
//                            >=0.6 -> 0. <2 espacios -> NEUTRAL.
// 13. sentenceEndPauses    - share de Enter con pausa previa >=1.5x el
//                            intervalo normal: <=0.2 -> 1, >=0.6 -> 0.
//                            Sin Enter -> NEUTRAL.
// 14. selectionDeletion    - borrados sin selección previa (modificador+flecha
//                            en <=300ms): share <=0.1 -> 1, >=0.5 -> 0.
//                            <2 borrados -> 0.
// 15. arrowUsage           - share de flechas durante edición:
//                            <=0.01 -> 1 (borra sin moverse), >=0.08 -> 0.
//                            Sin edición -> 0.
// 16. autocompleteFalsePositive - inserciones huerfanas agrupadas (<=200ms),
//                            sin keydowns y sin pegado: share <=0.5 -> 0,
//                            >=1 -> 1. Dirección INVERSA: 1 =NO bot.
// 17. enterSubmit          - Enters instantáneos (<=60ms) y terminales:
//                            share <=0.3 -> 0, >=0.8 -> 1. Sin Enter -> 0.
// 18. capitalization       - pares modificador+letra con hueco <=5ms (eventos
//                            sintéticos): share <=0.3 -> 0, >=0.8 -> 1.
//                            <2 pares -> 0.
// 19. programmaticKeys     - max(trusted=0, holds<=5ms):
//                            untrusted <=0.05->0, >=0.5->1;
//                            near-zero <=0.3->0, >=0.85->1. Sin datos -> 0.
// ---------------------------------------------------------------------------

/** Banda (fracción de la mediana) para considerar un intervalo "concentrado". */
export const INTERVAL_DISTRIBUTION_BAND = 0.15;
export const INTERVAL_DISTRIBUTION_LOW = 0.2;
export const INTERVAL_DISTRIBUTION_HIGH = 0.65;
/** Teclas imprimibles por segundo: por debajo es humano, por encima imposible. */
export const TYPING_SPEED_LOW = 6;
export const TYPING_SPEED_HIGH = 14;
/** Pausa tras un error (ms): por debajo es corrección instantánea de bot. */
export const ERROR_PAUSE_INSTANT_MS = 80;
export const ERROR_PAUSE_HUMAN_MS = 300;
/** Factor sobre el intervalo normal para una pausa de palabra/frase. */
export const WORD_PAUSE_FACTOR = 1.5;
export const WORD_PAUSE_LOW = 0.2;
export const WORD_PAUSE_HIGH = 0.6;
export const SENTENCE_PAUSE_FACTOR = 1.5;
export const SENTENCE_PAUSE_LOW = 0.2;
export const SENTENCE_PAUSE_HIGH = 0.6;
/** Ventana para asociar modificador+flecha (selección) con un borrado. */
export const SELECTION_GAP_MS = 300;
export const SELECTION_LOW = 0.1;
export const SELECTION_HIGH = 0.5;
/** Share de flechas que indica navegación humana durante la edición. */
export const ARROW_USAGE_LOW = 0.01;
export const ARROW_USAGE_HIGH = 0.08;
/** Ráfaga de inserciones huérfanas típica de autocompletado/contraseña. */
export const AUTOFILL_BURST_MS = 200;
export const AUTOFILL_ORPHAN_LOW = 0.5;
export const AUTOFILL_ORPHAN_HIGH = 1;
/** Enter instantáneo y terminal (envío automático). */
export const ENTER_INSTANT_MS = 60;
export const ENTER_TERMINAL_MS = 300;
export const ENTER_SUBMIT_LOW = 0.3;
export const ENTER_SUBMIT_HIGH = 0.8;
/** Hueco modificador->letra y hueco "instantáneo" de eventos programáticos. */
export const SHIFT_LETTER_GAP_MS = 300;
export const SHIFT_INSTANT_MS = 5;
export const SHIFT_INSTANT_LOW = 0.3;
export const SHIFT_INSTANT_HIGH = 0.8;
/** Umbrales para teclas programáticas (trusted=0 o pulsaciones casi nulas). */
export const PROGRAMMATIC_HOLD_MS = 5;
export const UNTRUSTED_LOW = 0.05;
export const UNTRUSTED_HIGH = 0.5;
export const NEAR_ZERO_HOLD_LOW = 0.3;
export const NEAR_ZERO_HOLD_HIGH = 0.85;

// Correcciones de calibración derivadas de trazas reales de teclado (ver
// tests/real-world/keyboard.test.ts). Todas pertenecen a medidas opt-in con
// peso 0 (lane parcial / lane final): no alteran los scores existentes.
/** Pausa cognitiva (palabra/frase/corrección) a partir de la cual no se mide
 *  la ventaja de cambiar de mano: es ruido, no efecto del dedo. */
export const HAND_SWITCH_OUTLIER_FACTOR = 2;
/** Exceso de repeticiones de categoría sobre el azar para L77. */
export const REPEAT_EXCESS_LOW = 0.1;
export const REPEAT_EXCESS_HIGH = 0.5;
/** Share mínimo de borrados para que L91/L92 tengan contexto de edición. */
export const EDIT_SHARE_MIN = 0.15;
/** Share de borrados sin selección previa que separa humano de bot en L91. */
export const NO_SELECTION_LOW = 0.1;
export const NO_SELECTION_HIGH = 0.4;

export interface KeyboardFeatures {
  intervalRegularity: number;
  holdRegularity: number;
  correctionBursts: number;
  pasteRatio: number;
  textWithoutKeydown: number;
  modifierShortcuts: number;
  noPauses: number;
  exactRhythm: number;
  // Checklist parcial (peso 0): no afectan al score actual.
  intervalDistribution: number;
  typingSpeed: number;
  pauseAfterError: number;
  wordPauses: number;
  sentenceEndPauses: number;
  selectionDeletion: number;
  arrowUsage: number;
  autocompleteFalsePositive: number;
  enterSubmit: number;
  capitalization: number;
  programmaticKeys: number;
}

const LETTER = 0;
const DIGIT = 1;
const SPACE = 2;
const BACKSPACE = 3;
const ENTER = 4;
const ARROW = 5;
const MODIFIER = 6;
const OTHER = 7;
/** Categorías que representan una tecla imprimible (texto). */
const PRINTABLE = new Set([LETTER, DIGIT, SPACE, OTHER]);
/** inputType que representan una inserción de texto (no borrado). */
const INSERTS = new Set([0, 1, 2, 3]);

// Ataque: t/category/inputType hostiles (NaN, ±Infinity, 1e308) desbordaban
// intervalos, CV y la ventana. Cotas muy por encima de un tecleo real: los
// valores normales pasan sin cambios.
const MAX_KEY_TIME = 1e15;

function boundedTime(t: number): number {
  return Number.isFinite(t) ? clamp(t, -MAX_KEY_TIME, MAX_KEY_TIME) : 0;
}

function sanitizeKey(sample: KeySample): KeySample {
  return {
    ...sample,
    t: boundedTime(sample.t),
    category: Number.isFinite(sample.category)
      ? (clamp(sample.category, 0, 7) as KeySample["category"])
      : OTHER,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

function sanitizeInput(sample: InputSample): InputSample {
  return {
    ...sample,
    t: boundedTime(sample.t),
    inputType: Number.isFinite(sample.inputType)
      ? (clamp(sample.inputType, 0, 5) as InputSample["inputType"])
      : 5,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

function sanitized(keys: KeySample[]): KeySample[] {
  return keys.map(sanitizeKey);
}

function sanitizedInputs(inputs: InputSample[]): InputSample[] {
  return inputs.map(sanitizeInput);
}

function keyDowns(keys: KeySample[]): KeySample[] {
  return sanitized(keys).filter((sample) => sample.kind === 0);
}

// Ataque de coste: `indexOf` dentro de un bucle y dobles bucles sobre las
// muestras convertían 50k eventos en O(n²). Estos helpers son exactos: el mapa
// conserva la primera aparición por referencia y la búsqueda binaria solo se
// usa cuando los tiempos están ordenados (caso real); si no, se mantiene el
// recorrido original para no cambiar ningún resultado.
function firstIndices<T>(items: T[]): Map<T, number> {
  const map = new Map<T, number>();
  for (let i = 0; i < items.length; i += 1) {
    if (!map.has(items[i])) map.set(items[i], i);
  }
  return map;
}

function sortedByTime(items: ReadonlyArray<{ t: number }>): boolean {
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].t < items[i - 1].t) return false;
  }
  return true;
}

/** Último índice con t <= target, o -1. Requiere `items` ordenado por t. */
function lastAtMost(items: ReadonlyArray<{ t: number }>, target: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].t <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Primer tiempo > target en un array ordenado, o `times.length`. */
function firstAfterNumber(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** ¿Algún tiempo ordenado cae en [lo, hi]? */
function anyInRange(times: number[], lo: number, hi: number): boolean {
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

/** Intervalos estrictamente positivos entre keydowns consecutivos. */
function keyIntervals(downs: KeySample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < downs.length; i += 1) {
    const dt = downs[i].t - downs[i - 1].t;
    if (dt > 0) out.push(dt);
  }
  return out;
}

/**
 * Descarta intervalosOUTLIER (> `factor` x mediana): pausas de palabra, frase
 * o corrección que no forman parte del ritmo de tecleo. Evita que un humano
 * que piensa parezca un metrónomo o que no "caliente".
 */
function trimCognitivePauses(intervals: number[], factor = HAND_SWITCH_OUTLIER_FACTOR): number[] {
  if (intervals.length < 4) return intervals;
  const cutoff = factor * median(intervals);
  return intervals.filter((dt) => dt <= cutoff);
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

  const cleanInputs = sanitizedInputs(inputs);
  const pastes = cleanInputs.filter(
    (sample) => sample.inputType === 1 || sample.inputType === 2,
  ).length;
  const enoughPastes = cleanInputs.length >= MIN_INPUTS_WITH_PASTE && pastes > 0;

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
  const clean = sanitized(keys);
  const holds: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 1) {
    if (clean[i].kind !== 0 || clean[i + 1].kind !== 1) continue;
    const duration = clean[i + 1].t - clean[i].t;
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
  const clean = sanitizedInputs(inputs);
  const pastes = clean.filter((sample) => sample.inputType === 1 || sample.inputType === 2).length;
  return linear(pastes / clean.length, 0.05, 0.4);
}

/** Inserciones de texto sin ningún keydown en la ventana previa. */
export function keyboardTextWithoutKeydown(keys: KeySample[], inputs: InputSample[]): number {
  const inserts = sanitizedInputs(inputs).filter((sample) => INSERTS.has(sample.inputType));
  if (inserts.length === 0) return 0;
  const downs = keyDowns(keys);
  const sorted = sortedByTime(downs);
  let orphan = 0;
  for (const input of inserts) {
    let preceded = false;
    if (sorted) {
      const idx = lastAtMost(downs, input.t);
      if (idx >= 0) preceded = input.t - downs[idx].t <= KEYDOWN_LOOKBACK_MS;
    } else {
      for (let i = downs.length - 1; i >= 0; i -= 1) {
        const dt = input.t - downs[i].t;
        if (dt < 0) continue;
        preceded = dt <= KEYDOWN_LOOKBACK_MS;
        break;
      }
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
  const indices = firstIndices(downs);
  let shortcuts = 0;
  for (const modifier of modifiers) {
    const index = indices.get(modifier) ?? 0;
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
 * Además, una pausa >= HUMAN_PAUSE_MS (1000ms, calibrada con la sesión real)
 * basta para devolver 0: no hace falta que el 30% de los intervalos sean
 * pausas para reconocer a un humano que se detuvo a pensar.
 */
export function keyboardNoPauses(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const intervals = keyIntervals(downs);
  if (intervals.length < 2) return 0;
  if (keyboardWindowMs(keys) < NO_PAUSES_MIN_WINDOW_MS && downs.length < NO_PAUSES_MIN_DOWNS) {
    return 0;
  }
  if (intervals.some((dt) => dt >= HUMAN_PAUSE_MS)) return 0;
  const threshold = Math.max(PAUSE_FACTOR * median(intervals), PAUSE_MIN_MS);
  const pauses = intervals.filter((dt) => dt > threshold).length / intervals.length;
  return 1 - linear(pauses, 0, 0.3);
}

/**
 * Diversidad de intervalos: un bot con `setInterval` (o un ciclo corto de
 * delays) concentra los intervalos en muy pocos valores. Un humano con jitter
 * también repite alguno al redondear a 1ms (20 distintos de 26 en la sesión
 * calibrada), así que contar cualquier repetición daba un falso positivo.
 */
export function keyboardExactRhythm(keys: KeySample[]): number {
  const intervals = keyIntervals(keyDowns(keys));
  if (intervals.length < 4) return 0;
  const distinct = new Set(intervals.map((dt) => Math.round(dt))).size;
  return 1 - linear(distinct / intervals.length, EXACT_RHYTHM_UNIQUE_LOW, EXACT_RHYTHM_UNIQUE_HIGH);
}

/**
 * L71 · Distribución del intervalo. Un humano concentra muchos intervalos
 * cortos y unos pocos largos (cola derecha); un metrónomo concentra casi
 * todos en una banda estrecha alrededor de la mediana. Alto = bot.
 * Devuelve NEUTRAL con < 4 intervalos.
 */
export function keyboardIntervalDistribution(keys: KeySample[]): number {
  const intervals = keyIntervals(keyDowns(keys));
  if (intervals.length < 4) return KEYBOARD_NEUTRAL;
  const m = median(intervals);
  if (m <= 1e-9) return 0;
  const narrow = intervals.filter(
    (dt) => Math.abs(dt - m) <= INTERVAL_DISTRIBUTION_BAND * m,
  ).length;
  return linear(narrow / intervals.length, INTERVAL_DISTRIBUTION_LOW, INTERVAL_DISTRIBUTION_HIGH);
}

/**
 * L78 · Velocidad de escritura promedio (teclas imprimibles por segundo sobre
 * la ventana de keydowns). Por encima de ~14 keys/s no es posible a mano.
 * Devuelve NEUTRAL con < 3 keydowns o ventana nula.
 */
export function keyboardTypingSpeed(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length < 3) return KEYBOARD_NEUTRAL;
  const window = keyboardWindowMs(keys);
  if (window <= 0) return KEYBOARD_NEUTRAL;
  const printed = downs.filter((sample) => PRINTABLE.has(sample.category)).length;
  const rate = (printed / window) * 1000;
  return linear(rate, TYPING_SPEED_LOW, TYPING_SPEED_HIGH);
}

/**
 * L83 · Pausa después de un error. Tras un borrar, el humano se detiene a
 * corregir; el bot encadena la corrección al instante. Alto = bot (pausa media
 * <= 80ms). Sin borrados devuelve 0 (sin patrón que juzgar).
 */
export function keyboardPauseAfterError(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const errors = downs.filter((sample) => sample.category === BACKSPACE);
  if (errors.length === 0) return 0;
  const indices = firstIndices(downs);
  const gaps: number[] = [];
  for (const err of errors) {
    const index = indices.get(err) ?? 0;
    if (index >= downs.length - 1) continue;
    const gap = downs[index + 1].t - err.t;
    if (gap >= 0) gaps.push(gap);
  }
  if (gaps.length === 0) return KEYBOARD_NEUTRAL;
  return 1 - linear(mean(gaps), ERROR_PAUSE_INSTANT_MS, ERROR_PAUSE_HUMAN_MS);
}

/**
 * L84 · Pausas entre palabras. El humano marca el espacio con una pausa
 * respecto al ritmo entre letras; el bot es uniforme. El intervalo de
 * referencia excluye los espacios para no contaminarse. Alto = bot.
 * Devuelve NEUTRAL con < 2 espacios o referencia insuficiente.
 */
export function keyboardWordPauses(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const spaces = downs.filter((sample) => sample.category === SPACE);
  if (spaces.length < 2) return KEYBOARD_NEUTRAL;
  const letterIntervals: number[] = [];
  for (let i = 1; i < downs.length; i += 1) {
    if (downs[i].category === SPACE || downs[i - 1].category === SPACE) continue;
    const dt = downs[i].t - downs[i - 1].t;
    if (dt > 0) letterIntervals.push(dt);
  }
  if (letterIntervals.length < 2) return KEYBOARD_NEUTRAL;
  const reference = median(letterIntervals);
  const indices = firstIndices(downs);
  let paused = 0;
  let total = 0;
  for (const space of spaces) {
    const index = indices.get(space) ?? 0;
    if (index >= downs.length - 1) continue;
    const gap = downs[index + 1].t - space.t;
    if (gap < 0) continue;
    total += 1;
    if (gap >= WORD_PAUSE_FACTOR * reference) paused += 1;
  }
  if (total === 0) return KEYBOARD_NEUTRAL;
  return 1 - linear(paused / total, WORD_PAUSE_LOW, WORD_PAUSE_HIGH);
}

/**
 * L85 · Pausas al final de frase. Usamos Enter como fin de frase (no hay
 * cadenas para identificar un punto). El humano pausa antes de Enter; el bot
 * lo encadena. Alto = bot. Devuelve NEUTRAL sin Enter o referencia corta.
 */
export function keyboardSentenceEndPauses(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const enters = downs.filter((sample) => sample.category === ENTER);
  if (enters.length === 0) return KEYBOARD_NEUTRAL;
  const references: number[] = [];
  for (let i = 1; i < downs.length; i += 1) {
    if (downs[i].category === ENTER) continue;
    const dt = downs[i].t - downs[i - 1].t;
    if (dt > 0) references.push(dt);
  }
  if (references.length < 2) return KEYBOARD_NEUTRAL;
  const reference = median(references);
  const indices = firstIndices(downs);
  let paused = 0;
  let total = 0;
  for (const enter of enters) {
    const index = indices.get(enter) ?? 0;
    if (index === 0) continue;
    const gap = enter.t - downs[index - 1].t;
    if (gap < 0) continue;
    total += 1;
    if (gap >= SENTENCE_PAUSE_FACTOR * reference) paused += 1;
  }
  if (total === 0) return KEYBOARD_NEUTRAL;
  return 1 - linear(paused / total, SENTENCE_PAUSE_LOW, SENTENCE_PAUSE_HIGH);
}

/**
 * L91 · Selección y borrado. El humano selecciona (modificador+flecha) antes
 * de borrar; el bot encadena borrados sin seleccionar. Alto = bot. Sin al
 * menos dos borrados devuelve 0 (sin edición que juzgar).
 */
export function keyboardSelectionDeletion(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const backs = downs.filter((sample) => sample.category === BACKSPACE);
  if (backs.length < 2) return 0;
  const arrows = downs.filter((sample) => sample.category === ARROW);
  const modifiers = downs.filter((sample) => sample.category === MODIFIER);
  if (arrows.length === 0 || modifiers.length === 0) {
    // FIX: devolver 1 aquí acusaba a cualquier humano que corrige con
    // backspace sin seleccionar (lo habitual). Sin evidencia de selección,
    // el único proxy fiable es la FRECUENCIA de borrados: un bot que solo
    // borra encadena borrados; un humano intercala un par entre mucho texto.
    return linear(backs.length / downs.length, NO_SELECTION_LOW, NO_SELECTION_HIGH);
  }
  // Ataque de coste: la forma ingenua era O(backs × mods × arrows). Solo
  // importan los tiempos, así que ordenamos y buscamos por intervalos: la
  // decisión (existe mod dentro de GAP de algún arrow previo) es idéntica.
  const modTimes = modifiers.map((sample) => sample.t).sort((a, b) => a - b);
  const arrowTimes = arrows.map((sample) => sample.t).sort((a, b) => a - b);
  let selected = 0;
  for (const back of backs) {
    const loBound = back.t - SELECTION_GAP_MS;
    let ai = 0;
    let ah = arrowTimes.length;
    while (ai < ah) {
      const mid = (ai + ah) >>> 1;
      if (arrowTimes[mid] < loBound) ai = mid + 1;
      else ah = mid;
    }
    let mergedLo = Number.POSITIVE_INFINITY;
    let mergedHi = Number.NEGATIVE_INFINITY;
    let found = false;
    for (let i = ai; i < arrowTimes.length && arrowTimes[i] <= back.t; i += 1) {
      const lo = arrowTimes[i] - SELECTION_GAP_MS;
      const hi = arrowTimes[i] + SELECTION_GAP_MS;
      if (lo > mergedHi) {
        if (mergedHi >= mergedLo && anyInRange(modTimes, mergedLo, Math.min(mergedHi, back.t))) {
          found = true;
          break;
        }
        mergedLo = lo;
        mergedHi = hi;
      } else if (hi > mergedHi) {
        mergedHi = hi;
      }
    }
    if (
      !found &&
      mergedHi >= mergedLo &&
      anyInRange(modTimes, mergedLo, Math.min(mergedHi, back.t))
    ) {
      found = true;
    }
    if (found) selected += 1;
  }
  return 1 - linear(selected / backs.length, SELECTION_LOW, SELECTION_HIGH);
}

/**
 * L92 · Uso de flechas. Durante la edición (hay borrados), el humano se mueve
 * con flechas; un bot que solo borra y reescribe no. Alto = bot. Sin contexto
 * de edición devuelve 0.
 */
export function keyboardArrowUsage(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length < 5) return 0;
  const edits = downs.filter((sample) => sample.category === BACKSPACE).length;
  if (edits === 0) return 0;
  // FIX: un par de backspaces en un párrafo largo no es "editar sin flechas":
  // es una corrección anecdótica. Sin volumen de edición no hay evidencia.
  if (edits / downs.length < EDIT_SHARE_MIN) return 0;
  const arrows = downs.filter((sample) => sample.category === ARROW).length;
  return 1 - linear(arrows / downs.length, ARROW_USAGE_LOW, ARROW_USAGE_HIGH);
}

/**
 * L96 · Autocompletado / gestor de contraseñas (ANTI falso positivo).
 * Dirección INVERSA al resto: 1 = "probable autocompletado", es decir, NO
 * tratar como bot. Se detecta cuando aparecen inserciones huérfanas y
 * agrupadas (ráfaga <= 200ms), sin ningún keydown y sin pegado: la firma de
 * un relleno automático. Sin esa firma devuelve 0 (no es autocompletado).
 */
export function keyboardAutocompleteFalsePositive(
  keys: KeySample[],
  inputs: InputSample[],
): number {
  const clean = sanitizedInputs(inputs);
  const inserts = clean.filter((sample) => sample.inputType === 0 || sample.inputType === 3);
  if (inserts.length < 2) return 0;
  const pasted = clean.some((sample) => sample.inputType === 1 || sample.inputType === 2);
  if (pasted) return 0;
  if (keyDowns(keys).length > 0) return 0;
  if (inserts.length <= 256) {
    let clustered = 0;
    for (const insert of inserts) {
      if (
        inserts.some(
          (other) => other !== insert && Math.abs(other.t - insert.t) <= AUTOFILL_BURST_MS,
        )
      ) {
        clustered += 1;
      }
    }
    return linear(clustered / inserts.length, AUTOFILL_ORPHAN_LOW, AUTOFILL_ORPHAN_HIGH);
  }
  // Ataque de coste: el doble bucle era O(n²). Con tiempos ordenados basta
  // mirar los vecinos inmediatos (el más cercano está a distancia <= 200ms).
  const ordered = inserts.map((sample) => ({ sample, t: sample.t })).sort((a, b) => a.t - b.t);
  let clustered = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const insert = ordered[i].sample;
    const before = ordered[i - 1];
    const after = ordered[i + 1];
    if (
      (before && before.sample !== insert && insert.t - before.t <= AUTOFILL_BURST_MS) ||
      (after && after.sample !== insert && after.t - insert.t <= AUTOFILL_BURST_MS)
    ) {
      clustered += 1;
    }
  }
  return linear(clustered / inserts.length, AUTOFILL_ORPHAN_LOW, AUTOFILL_ORPHAN_HIGH);
}

/**
 * L98 · Enter para enviar. Un bot dispara Enter apenas termina de teclear y
 * no sigue escribiendo (envío automático). El humano pausa o continúa.
 * Alto = bot (Enter instantáneo <= 60ms y terminal). Sin Enter devuelve 0.
 */
export function keyboardEnterSubmit(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const enters = downs.filter((sample) => sample.category === ENTER);
  if (enters.length === 0) return 0;
  const indices = firstIndices(downs);
  const downTimes = downs.map((sample) => sample.t).sort((a, b) => a - b);
  let instantTerminal = 0;
  for (const enter of enters) {
    const index = indices.get(enter) ?? 0;
    const previous = index > 0 ? downs[index - 1] : null;
    const gapBefore = previous ? enter.t - previous.t : Number.POSITIVE_INFINITY;
    // Coste: `downs.some` por Enter era O(n²). `followed` solo depende de los
    // tiempos, así que una copia ordenada da exactamente el mismo resultado.
    const next = firstAfterNumber(downTimes, enter.t);
    const followed = next < downTimes.length && downTimes[next] - enter.t <= ENTER_TERMINAL_MS;
    if (gapBefore >= 0 && gapBefore <= ENTER_INSTANT_MS && !followed) instantTerminal += 1;
  }
  return linear(instantTerminal / enters.length, ENTER_SUBMIT_LOW, ENTER_SUBMIT_HIGH);
}

/**
 * L100 · Mayúsculas. El humano mantiene Shift unos ms antes de la letra; los
 * eventos sintéticos disparan modificador y letra en el mismo instante
 * (hueco ~0). Mide el share de pares modificador->letra "instantáneos".
 * Alto = bot. Con < 2 pares devuelve 0 (sin evidencia).
 */
export function keyboardCapitalization(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  const letters = downs.filter((sample) => sample.category === LETTER);
  const modifiers = downs.filter((sample) => sample.category === MODIFIER);
  if (letters.length < 3 || modifiers.length === 0) return 0;
  // Coste: antes se comparaba cada letra con cada modificador (O(n²)).
  // El mejor hueco es el del modificador más reciente a cada letra.
  const modTimes = modifiers.map((sample) => ({ t: sample.t }));
  const gaps: number[] = [];
  for (const letter of letters) {
    let best = Number.POSITIVE_INFINITY;
    const idx = lastAtMost(modTimes, letter.t);
    if (idx >= 0) {
      const gap = letter.t - modTimes[idx].t;
      if (gap >= 0 && gap <= SHIFT_LETTER_GAP_MS) best = gap;
    }
    if (best !== Number.POSITIVE_INFINITY) gaps.push(best);
  }
  if (gaps.length < 2) return 0;
  const instant = gaps.filter((gap) => gap <= SHIFT_INSTANT_MS).length / gaps.length;
  return linear(instant, SHIFT_INSTANT_LOW, SHIFT_INSTANT_HIGH);
}

/**
 * L101 · Teclas físicas vs programáticas. Solo usa `trusted` y tiempos:
 * eventos programáticos suelen tener `trusted = 0` y pulsaciones casi nulas
 * (holds <= 5ms). Nunca mira cadenas de tecla. Alto = bot. Sin datos -> 0.
 */
export function keyboardProgrammaticKeys(keys: KeySample[]): number {
  if (keys.length === 0) return 0;
  const clean = sanitized(keys);
  const untrusted = clean.filter((sample) => sample.trusted === 0).length / clean.length;
  const holds: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 1) {
    if (clean[i].kind !== 0 || clean[i + 1].kind !== 1) continue;
    const duration = clean[i + 1].t - clean[i].t;
    if (duration >= 0) holds.push(duration);
  }
  const nearZero =
    holds.length > 0
      ? holds.filter((hold) => hold <= PROGRAMMATIC_HOLD_MS).length / holds.length
      : 0;
  return Math.max(
    linear(untrusted, UNTRUSTED_LOW, UNTRUSTED_HIGH),
    linear(nearZero, NEAR_ZERO_HOLD_LOW, NEAR_ZERO_HOLD_HIGH),
  );
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
    intervalDistribution: keyboardIntervalDistribution(keys),
    typingSpeed: keyboardTypingSpeed(keys),
    pauseAfterError: keyboardPauseAfterError(keys),
    wordPauses: keyboardWordPauses(keys),
    sentenceEndPauses: keyboardSentenceEndPauses(keys),
    selectionDeletion: keyboardSelectionDeletion(keys),
    arrowUsage: keyboardArrowUsage(keys),
    autocompleteFalsePositive: keyboardAutocompleteFalsePositive(keys, inputs),
    enterSubmit: keyboardEnterSubmit(keys),
    capitalization: keyboardCapitalization(keys),
    programmaticKeys: keyboardProgrammaticKeys(keys),
  };
}

/**
 * Ajuste de medidas para el perfil de dispositivo ANTES de `computeKeyboardScore`.
 *
 * En `tv` las pulsaciones del D-pad/Enter no son tecleo: `intervalRegularity` y
 * `exactRhythm` no tienen sentido y se ponen a 0 para cadencias de mando reales
 * (mediana de intervalos >= TV_MIN_INTERVAL_MS). El resto de medidas y las
 * compuertas de evidencia (`hasKeyboardEvidence`) NO se tocan.
 *
 * La única excepción deliberada es una cadencia imposible para un mando
 * (mediana < 150 ms con al menos 4 intervalos): ahí se conservan esas dos
 * medidas para que un bot rápido y regular de flechas SIGA detectándose. TV no
 * es un pase libre: sin evidencia suficiente la señal sigue siendo null y el
 * veredicto `measuring`.
 */
export function keyboardFeaturesForDevice(
  features: KeyboardFeatures,
  keys: KeySample[],
  device: DeviceProfile,
): KeyboardFeatures {
  if (device !== "tv") return features;
  const intervals = keyIntervals(keyDowns(keys));
  const medianInterval = intervals.length > 0 ? median(intervals) : Number.POSITIVE_INFINITY;
  if (intervals.length >= 3 && medianInterval >= TV_MIN_INTERVAL_MS) {
    return { ...features, intervalRegularity: 0, exactRhythm: 0 };
  }
  return features;
}

/** Pesos documentados en el encabezado (se normalizan al sumar). */
// `as const` es solo compile-time: una página podría mutar la tabla en runtime.
export const KEYBOARD_FEATURE_WEIGHTS = Object.freeze({
  intervalRegularity: 0.3,
  holdRegularity: 0.15,
  correctionBursts: 0.1,
  pasteRatio: 0.15,
  textWithoutKeydown: 0.2,
  modifierShortcuts: 0.1,
  noPauses: 0.1,
  exactRhythm: 0.15,
  // Checklist parcial: peso 0 para no alterar los scores existentes.
  intervalDistribution: 0,
  typingSpeed: 0,
  pauseAfterError: 0,
  wordPauses: 0,
  sentenceEndPauses: 0,
  selectionDeletion: 0,
  arrowUsage: 0,
  autocompleteFalsePositive: 0,
  enterSubmit: 0,
  capitalization: 0,
  programmaticKeys: 0,
} as const satisfies Readonly<Record<keyof KeyboardFeatures, number>>);

/** Medidas de patrón: un 0 significa "no aparece", no "humano": se omiten. */
const PATTERN_FEATURES = new Set<keyof KeyboardFeatures>([
  "correctionBursts",
  "pasteRatio",
  "textWithoutKeydown",
  "modifierShortcuts",
  "exactRhythm",
  // Nuevas medidas donde 0 = "patrón ausente" (no hay error/selección/Enter/
  // autocompletado/programación), no "humano".
  "pauseAfterError",
  "selectionDeletion",
  "arrowUsage",
  "autocompleteFalsePositive",
  "enterSubmit",
  "capitalization",
  "programmaticKeys",
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
    // Checklist parcial (peso 0): razones listas si se activan en el futuro.
    intervalDistribution: "Intervalos de tecleo demasiado concentrados",
    typingSpeed: "Velocidad de tecleo imposible a mano",
    pauseAfterError: "Correcciones encadenadas sin pausa",
    wordPauses: "Sin pausas entre palabras",
    sentenceEndPauses: "Sin pausas al final de frase",
    selectionDeletion: "Borrados sin selección previa",
    arrowUsage: "Edición sin uso de flechas",
    autocompleteFalsePositive: "Inserciones agrupadas (probable autocompletado)",
    enterSubmit: "Envíos automáticos con Enter",
    capitalization: "Mayúsculas generadas con eventos instantáneos",
    programmaticKeys: "Teclas programáticas (no confiables)",
  };
  return (Object.keys(features) as Array<keyof KeyboardFeatures>)
    .map((key) => ({ key, value: features[key], weight: KEYBOARD_FEATURE_WEIGHTS[key] }))
    .filter((entry) => entry.weight > 0 && entry.value >= 0.55)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, top)
    .map((entry) => texts[entry.key]);
}

// ---------------------------------------------------------------------------
// CARRIL FINAL (índices L74..L97 del checklist). Aditivo, con pesos 0.
//
// No amplía `KeyboardFeatures` ni `KEYBOARD_FEATURE_WEIGHTS`: hay tests que
// fijan el objeto literal exacto de esa tabla. Se crea una lane propia con la
// misma forma (interfaz + tabla congelada + extractor). Solo usa tiempos y
// `category` numérico (nunca cadenas de tecla ni contenido). Todas en [0,1],
// 1 = más IA; evidencia insuficiente -> KEYBOARD_NEUTRAL = 0.5. Coste O(n log n).
// ---------------------------------------------------------------------------

/** Correlación de Pearson acotada a [-1, 1]; 0 sin varianza suficiente. */
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

/** Medidas finales de teclado. Peso 0 por defecto; 1 = más IA. */
export interface KeyboardFinalFeatures {
  keyOverlap: number;
  letterPairs: number;
  handSwitch: number;
  repeatedKey: number;
  warmupAcceleration: number;
  firstKeyPause: number;
  rhythmByTextLength: number;
  zeroErrorsLongText: number;
  tabUsage: number;
}

/** Tabla de la lane final: TODOS 0 (ningún score existente la consulta). */
export const KEYBOARD_FINAL_FEATURE_WEIGHTS = Object.freeze({
  keyOverlap: 0,
  letterPairs: 0,
  handSwitch: 0,
  repeatedKey: 0,
  warmupAcceleration: 0,
  firstKeyPause: 0,
  rhythmByTextLength: 0,
  zeroErrorsLongText: 0,
  tabUsage: 0,
} as const satisfies Readonly<Record<keyof KeyboardFinalFeatures, number>>);

/** L74 · Solapamiento de teclas: el humano a veces pulsa la siguiente antes de
 *  soltar la anterior; un bot encadena eventos estrictamente secuenciales.
 *  Thresholds: share <= 0.01 -> 1 (sin solape, IA), >= 0.15 -> 0 (humano). */
export function keyboardKeyOverlap(keys: KeySample[]): number {
  const clean = sanitized(keys);
  if (clean.length === 0) return KEYBOARD_NEUTRAL;
  const order = clean
    .map((sample, index) => ({ sample, index }))
    .sort((a, b) => a.sample.t - b.sample.t);

  // Empareja cada keyup con el keydown más antiguo aún sin soltar y guarda el
  // tiempo de subida indexado por la posición del down.
  const upByDown = new Map<number, number>();
  const pending: number[] = [];
  // Cabecera en vez de `shift()`: O(n) total, también con miles de teclas
  // solapadas (donde `shift()` sería O(n²)).
  let pendingHead = 0;
  for (const { sample, index } of order) {
    if (sample.kind === 0) pending.push(index);
    else if (pendingHead < pending.length) {
      upByDown.set(pending[pendingHead], sample.t);
      pendingHead += 1;
    }
  }

  const downs = order.filter((entry) => entry.sample.kind === 0);
  if (downs.length === 0) return KEYBOARD_NEUTRAL;
  let prefixMaxUp = Number.NEGATIVE_INFINITY;
  let overlapping = 0;
  for (const { sample, index } of downs) {
    if (prefixMaxUp > sample.t) overlapping += 1;
    const up = upByDown.get(index);
    if (up !== undefined && up > prefixMaxUp) prefixMaxUp = up;
  }
  return 1 - linear(overlapping / downs.length, 0.01, 0.15);
}

/** L75 · Pares de letras: la velocidad depende del par de categorías (mano y
 *  dedo); un bot usa el mismo intervalo para todos. Solo claves numéricas
 *  `prev * 8 + curr` derivadas de `category`, nunca cadenas de tecla.
 *  Thresholds: CV <= 0.05 -> 1, >= 0.3 -> 0. */
export function keyboardLetterPairs(keys: KeySample[]): number {
  const intervals = keyIntervals(keyDowns(keys));
  if (intervals.length < 6) return KEYBOARD_NEUTRAL;
  const downs = keyDowns(keys);
  const groups = new Map<number, number[]>();
  for (let i = 1; i < downs.length; i += 1) {
    const dt = downs[i].t - downs[i - 1].t;
    if (dt <= 0) continue;
    // `category` ya está sanitizado a 0..7 por `keyDowns`.
    const pair = downs[i - 1].category * 8 + downs[i].category;
    const bucket = groups.get(pair);
    if (bucket) bucket.push(dt);
    else groups.set(pair, [dt]);
  }
  const means: number[] = [];
  for (const values of groups.values()) if (values.length >= 2) means.push(mean(values));
  if (means.length < 3) return KEYBOARD_NEUTRAL;
  const m = mean(means);
  if (m <= 1e-9) return 0;
  return 1 - linear(stddev(means) / m, 0.05, 0.3);
}

/** L76 · Cambio de mano entre teclas. Proxy puramente numérico: se considera
 *  "cambio" cuando cambia la paridad de `category` (nunca se lee la tecla).
 *  El humano es más rápido en el cambio; el bot no distingue.
 *  Thresholds: ratio(switch/stay) <= 0.9 -> 0 (humano), >= 1.05 -> 1. */
export function keyboardHandSwitch(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length < 5) return KEYBOARD_NEUTRAL;
  const all = keyIntervals(downs);
  if (all.length < 4) return KEYBOARD_NEUTRAL;
  // FIX: las pausas de palabra/frase/corrección son cognitivas, no un efecto
  // de cambiar de mano. Incluirlas hacía que un párrafo humano (letras +
  // espacios + algún backspace) puntuara 1 = bot. Se descartan los intervalos
  // fuera de la banda normal (>{factor x} mediana) antes de clasificar.
  const cutoff = HAND_SWITCH_OUTLIER_FACTOR * median(all);
  const switchTimes: number[] = [];
  const stayTimes: number[] = [];
  for (let i = 1; i < downs.length; i += 1) {
    const dt = downs[i].t - downs[i - 1].t;
    if (dt <= 0 || dt > cutoff) continue;
    const changed = downs[i - 1].category % 2 !== downs[i].category % 2;
    (changed ? switchTimes : stayTimes).push(dt);
  }
  if (switchTimes.length < 2 || stayTimes.length < 2) return KEYBOARD_NEUTRAL;
  const stay = mean(stayTimes);
  if (stay <= 1e-9) return 0;
  return linear(mean(switchTimes) / stay, 0.9, 1.05);
}

/** L77 · Misma tecla repetida (por categoría): un bot repite categoría con más
 *  frecuencia. Thresholds: share <= 0.2 -> 0, >= 0.7 -> 1. */
export function keyboardRepeatedKey(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length < 4) return KEYBOARD_NEUTRAL;
  const counts = new Map<KeySample["category"], number>();
  for (const sample of downs) counts.set(sample.category, (counts.get(sample.category) ?? 0) + 1);
  let repeated = 0;
  for (let i = 1; i < downs.length; i += 1) {
    if (downs[i].category === downs[i - 1].category) repeated += 1;
  }
  // FIX: "categoría repetida" no es "tecla repetida": todas las letras son
  // categoría 0, así que escribir palabras normales daba ~0.83 (bot). Si solo
  // aparece una categoría no hay forma de distinguirlo (se mantiene el 1
  // degenerado de la calibración); con varias, se mide el EXCESO sobre el
  // azar de encontrar la misma categoría por yuxtaposición.
  if (counts.size <= 1) return 1;
  const n = downs.length;
  let chance = 0;
  for (const count of counts.values()) chance += (count / n) * (count / n);
  return linear(repeated / (n - 1) - chance, REPEAT_EXCESS_LOW, REPEAT_EXCESS_HIGH);
}

/** L80 · Aceleración al calentar: el humano reduce el intervalo en la segunda
 *  mitad; el bot mantiene el mismo ritmo. Thresholds: ratio(first/last)
 *  <= 1.0 -> 1 (sin mejora, IA), >= 1.5 -> 0 (calienta). */
export function keyboardWarmupAcceleration(keys: KeySample[]): number {
  const raw = keyIntervals(keyDowns(keys));
  if (raw.length < 6) return KEYBOARD_NEUTRAL;
  // FIX: una pausa de pensamiento al final del párrafo duplicaba la media de
  // la segunda mitad y acusaba "sin calentamiento" a un humano real.
  const intervals = trimCognitivePauses(raw);
  if (intervals.length < 4) return KEYBOARD_NEUTRAL;
  const half = Math.floor(intervals.length / 2);
  const first = mean(intervals.slice(0, half));
  const last = mean(intervals.slice(half));
  if (last <= 1e-9) return 0;
  return 1 - linear(first / last, 1, 1.5);
}

/** L82 · Pausa antes de la primera tecla. `t` es `event.timeStamp` (ms desde
 *  la navegación), así que sirve como proxy de la espera inicial: un bot
 *  empieza a teclear casi al cargar. Thresholds: t <= 100ms -> 1,
 *  >= 1500ms -> 0. */
export function keyboardFirstKeyPause(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length === 0) return KEYBOARD_NEUTRAL;
  return 1 - linear(downs[0].t, 100, 1500);
}

/** L86 · Ritmo según cantidad de texto: correlación entre el orden del
 *  intervalo (proxy de texto acumulado, sin guardar contenido) y su duración.
 *  Un bot con intervalo fijo da correlación 0 -> IA.
 *  Thresholds: |correlación| <= 0 -> 1, >= 0.5 -> 0. */
export function keyboardRhythmByTextLength(keys: KeySample[]): number {
  const raw = keyIntervals(keyDowns(keys));
  if (raw.length < 5) return KEYBOARD_NEUTRAL;
  // FIX: las pausas cognitivas dispersas anulaban la correlación de un humano
  // que sí cambia de ritmo según avanza el texto.
  const intervals = trimCognitivePauses(raw);
  if (intervals.length < 4) return KEYBOARD_NEUTRAL;
  const index = intervals.map((_, i) => i);
  return 1 - linear(Math.abs(finalCorrelation(index, intervals)), 0, 0.5);
}

/** L90 · Cero errores en texto largo: el número de mutaciones de texto es un
 *  proxy de la cantidad (nunca se lee el contenido). Sin borrar en texto largo
 *  es firma de bot. Thresholds: inputs <= 2 -> 0, >= 8 -> 1. */
export function keyboardZeroErrorsLongText(keys: KeySample[], inputs: InputSample[]): number {
  if (inputs.length === 0 || keys.length === 0) return KEYBOARD_NEUTRAL;
  const backs = keyDowns(keys).filter((sample) => sample.category === BACKSPACE).length;
  if (backs > 0) return 0;
  return linear(sanitizedInputs(inputs).length, 2, 8);
}

/** L97 · Tab para cambiar de campo: `category === 7` ("otra tecla") es el
 *  único proxy disponible sin identidad de tecla. Se exige que aparezca con
 *  frecuencia y a intervalos regulares (navegación por lista de tareas).
 *  Thresholds: share <= 0 -> 0, >= 0.08 -> 1; CV de huecos <= 0.02 -> 1,
 *  >= 0.2 -> 0. Sin category 7 -> 0. */
export function keyboardTabUsage(keys: KeySample[]): number {
  const downs = keyDowns(keys);
  if (downs.length === 0) return KEYBOARD_NEUTRAL;
  const tabs = downs.filter((sample) => sample.category === OTHER);
  if (tabs.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < tabs.length; i += 1) {
    const dt = tabs[i].t - tabs[i - 1].t;
    if (dt > 0) gaps.push(dt);
  }
  if (gaps.length < 2) return 0;
  const share = linear(tabs.length / downs.length, 0, 0.08);
  const m = mean(gaps);
  if (m <= 1e-9) return share;
  return share * (1 - linear(stddev(gaps) / m, 0.02, 0.2));
}

/** Extrae las 9 medidas finales de teclado sin alterar `extractKeyboardFeatures`. */
export function extractFinalKeyboardFeatures(
  keys: KeySample[],
  inputs: InputSample[] = [],
): KeyboardFinalFeatures {
  return {
    keyOverlap: keyboardKeyOverlap(keys),
    letterPairs: keyboardLetterPairs(keys),
    handSwitch: keyboardHandSwitch(keys),
    repeatedKey: keyboardRepeatedKey(keys),
    warmupAcceleration: keyboardWarmupAcceleration(keys),
    firstKeyPause: keyboardFirstKeyPause(keys),
    rhythmByTextLength: keyboardRhythmByTextLength(keys),
    zeroErrorsLongText: keyboardZeroErrorsLongText(keys, inputs),
    tabUsage: keyboardTabUsage(keys),
  };
}
