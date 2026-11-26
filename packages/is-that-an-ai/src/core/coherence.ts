// Coherencia ENTRE señales: funciones puras sobre las instantáneas numéricas
// que el detector ya tiene. SIN DOM, SIN red, SIN storage y SIN cadenas de
// eventos (nunca se lee `event.key`, `code`, textos ni código fuente de nada).
//
// Todas las medidas están en [0,1] (1 = más sospechoso) y devuelven 0 cuando
// no hay evidencia: un 0 significa "no aparece el patrón", NO "humano".
// Las marcas no finitas se descartan (fail-closed: datos corruptos no son
// evidencia en ningún sentido). Las búsquedas de ventana son O(n log n), no
// O(n²): un array enorme no puede bloquear el hilo.
//
// Umbrales documentados:
// - `roboticness`: CV de intervalos <=0.05 -> 1, >=0.35 -> 0; diversidad de
//   intervalos redondeados a 1ms <=0.2 -> patrón de máquina, >=0.65 -> ruido
//   humano. Se toma el MAYOR de ambas medidas (basta un patrón para dudar).
// - `mixedSuspicious`: requiere al menos DOS señales con muestra suficiente;
//   una con roboticness >=0.85 y otra <=0.1 da 1. Sin mezcla (una sola señal,
//   todas humanas o todas robóticas) devuelve 0: eso lo puntúan otros módulos.
// - `actionsWithoutPriorEvent` / `phantomEvents`: ventana de 800ms hacia atrás;
//   ratio <=0.1 -> 0, >=0.6 -> 1.
//   * acción sin evento previo = clic-down o inserción de texto sin ningún
//     evento de OTRO flujo en la ventana (un bucle de clics no se explica a sí
//     mismo).
//   * evento fantasma = clic-down sin movimiento de puntero ni toque previo en
//     la ventana. El teclado solo NO se marca: escribir es normal (accesibilidad).

import type { ClickSample, InputSample, KeySample, PointerSample, ScrollSample } from "../types";
import { clamp, linear, mean, stddev } from "../utils/math";

/** Tres medidas de coherencia, cada una en [0,1] (1 = más sospechoso). */
export interface CoherenceSignals {
  /** Una señal muy humana convive con otra muy robótica (L141). */
  mixedSuspicious: number;
  /** Clics/inserciones sin ningún evento previo que los explique (L145). */
  actionsWithoutPriorEvent: number;
  /** Clics sin movimiento ni toque previo que los explique (L146). */
  phantomEvents: number;
}

/** Ventana hacia atrás para considerar que un evento "explica" una acción. */
export const PRIOR_EVENT_LOOKBACK_MS = 800;

const CV_LOW = 0.05;
const CV_HIGH = 0.35;
const UNIQUE_LOW = 0.2;
const UNIQUE_HIGH = 0.65;
const MIX_ROBOTIC_LOW = 0.55;
const MIX_ROBOTIC_HIGH = 0.85;
const MIX_HUMAN_LOW = 0.1;
const MIX_HUMAN_HIGH = 0.4;
const ORPHAN_LOW = 0.1;
const ORPHAN_HIGH = 0.6;
const PHANTOM_LOW = 0.1;
const PHANTOM_HIGH = 0.6;

type Stream = "pointer" | "click" | "scroll" | "key" | "input";
const STREAMS: readonly Stream[] = ["pointer", "click", "scroll", "key", "input"];

interface MarkedTime {
  readonly t: number;
  readonly stream: Stream;
}

/** Resultado siempre finito en [0,1]: NaN/Infinity se convierten en "sin evidencia". */
function safe01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/** Solo marcas finitas: NaN/Infinity no explican ni generan patrones. */
function finiteTimes(times: number[]): number[] {
  return times.filter((t) => typeof t === "number" && Number.isFinite(t));
}

function downTimes(keys: KeySample[]): number[] {
  const out: number[] = [];
  for (const key of keys) if (key.kind === 0) out.push(key.t);
  return out;
}

function clickDownTimes(clicks: ClickSample[]): number[] {
  const out: number[] = [];
  for (const click of clicks) if (click.kind === 0) out.push(click.t);
  return out;
}

function pointerTimes(samples: PointerSample[]): number[] {
  return samples.map((sample) => sample.t);
}

function pointerMotionTimes(samples: PointerSample[]): number[] {
  const out: number[] = [];
  for (const sample of samples) {
    // Movimiento (kind 0) o cualquier muestra de pluma/táctil (pointerType != 0).
    if (sample.kind === 0 || sample.pointerType !== 0) out.push(sample.t);
  }
  return out;
}

function inputTimes(inputs: InputSample[]): number[] {
  return inputs.map((input) => input.t);
}

/** Intervalos estrictamente positivos entre tiempos ordenados. */
function intervals(times: number[]): number[] {
  const sorted = [...finiteTimes(times)].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i] - sorted[i - 1];
    if (dt > 0 && Number.isFinite(dt)) out.push(dt);
  }
  return out;
}

/**
 * Qué tan "de máquina" parece un flujo por su ritmo. `null` = muestra insuficiente
 * (menos de 4 eventos => menos de 3 intervalos): no inventa evidencia.
 */
function roboticness(times: number[]): number | null {
  const ds = intervals(times);
  if (ds.length < 3) return null;
  const average = mean(ds);
  if (!Number.isFinite(average) || average <= 1e-9) return 1;
  const coefficientOfVariation = stddev(ds) / average;
  const regularity = 1 - linear(coefficientOfVariation, CV_LOW, CV_HIGH);
  const uniqueShare = new Set(ds.map((dt) => Math.round(dt))).size / ds.length;
  const exact = 1 - linear(uniqueShare, UNIQUE_LOW, UNIQUE_HIGH);
  return safe01(Math.max(regularity, exact));
}

/** Primera posición con valor >= `lo` en un array ordenado (lower bound). */
function lowerBound(sorted: number[], lo: number): number {
  let left = 0;
  let right = sorted.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (sorted[mid] < lo) left = mid + 1;
    else right = mid;
  }
  return left;
}

/** ¿Existe una marca en `[t - lookback, t]`? Búsqueda binaria, no escaneo lineal. */
function hasTimeInWindow(sorted: number[], t: number, lookback: number): boolean {
  const index = lowerBound(sorted, t - lookback);
  return index < sorted.length && sorted[index] <= t;
}

/** ¿Hay un evento de OTRO flujo en la ventana previa de la acción? */
function hasPriorOtherStream(
  action: MarkedTime,
  byStream: Record<Stream, number[]>,
  lookback: number,
): boolean {
  for (const stream of STREAMS) {
    if (stream === action.stream) continue;
    if (hasTimeInWindow(byStream[stream], action.t, lookback)) return true;
  }
  return false;
}

/**
 * Medidas de coherencia. Con todas las listas vacías devuelve 0/0/0.
 * Solo lectura: no ordena ni modifica las Arrays que recibe.
 */
export function evaluateCoherence(
  samples: PointerSample[],
  clicks: ClickSample[],
  scrolls: ScrollSample[],
  keys: KeySample[],
  inputs: InputSample[],
): CoherenceSignals {
  const empty =
    samples.length === 0 &&
    clicks.length === 0 &&
    scrolls.length === 0 &&
    keys.length === 0 &&
    inputs.length === 0;
  if (empty) return { mixedSuspicious: 0, actionsWithoutPriorEvent: 0, phantomEvents: 0 };

  // L141: mezcla de personalidades. Cada flujo con muestra suficiente aporta
  // una medida; hace falta que haya al menos un flujo robótico y otro humano.
  const perStream: Array<number | null> = [
    roboticness(pointerMotionTimes(samples)),
    roboticness(clickDownTimes(clicks)),
    roboticness(scrolls.map((scroll) => scroll.t)),
    roboticness(downTimes(keys)),
    roboticness(inputTimes(inputs)),
  ];
  const scores = perStream.filter((value): value is number => value !== null);
  let mixedSuspicious = 0;
  if (scores.length >= 2) {
    let robotic = Number.NEGATIVE_INFINITY;
    let human = Number.POSITIVE_INFINITY;
    for (const score of scores) {
      if (score > robotic) robotic = score;
      if (score < human) human = score;
    }
    mixedSuspicious =
      linear(robotic, MIX_ROBOTIC_LOW, MIX_ROBOTIC_HIGH) *
      (1 - linear(human, MIX_HUMAN_LOW, MIX_HUMAN_HIGH));
  }

  // Todas las marcas, agrupadas por flujo y ordenadas, para las reglas de
  // "evento previo". Las copias se ordenan: las Arrays de entrada intactas.
  const byStream: Record<Stream, number[]> = {
    pointer: finiteTimes(pointerTimes(samples)).sort((a, b) => a - b),
    click: finiteTimes(clicks.map((click) => click.t)).sort((a, b) => a - b),
    scroll: finiteTimes(scrolls.map((scroll) => scroll.t)).sort((a, b) => a - b),
    key: finiteTimes(keys.map((key) => key.t)).sort((a, b) => a - b),
    input: finiteTimes(inputTimes(inputs)).sort((a, b) => a - b),
  };
  const actions: MarkedTime[] = [
    ...finiteTimes(clickDownTimes(clicks)).map((t): MarkedTime => ({ t, stream: "click" })),
    ...finiteTimes(inputTimes(inputs)).map((t): MarkedTime => ({ t, stream: "input" })),
  ];

  // L145: acción sin ningún evento de otro flujo en la ventana previa.
  let orphan = 0;
  for (const action of actions) {
    if (!hasPriorOtherStream(action, byStream, PRIOR_EVENT_LOOKBACK_MS)) orphan += 1;
  }
  const actionsWithoutPriorEvent =
    actions.length === 0 ? 0 : linear(orphan / actions.length, ORPHAN_LOW, ORPHAN_HIGH);

  // L146: clic sin puntero/tacto que lo explique. Un clic sin movimiento previo
  // no es físicamente posible con ratón; el teclado solo NO se marca aquí.
  const motion = finiteTimes(pointerMotionTimes(samples)).sort((a, b) => a - b);
  let phantom = 0;
  const clickDowns = finiteTimes(clickDownTimes(clicks));
  for (const t of clickDowns) {
    if (!hasTimeInWindow(motion, t, PRIOR_EVENT_LOOKBACK_MS)) phantom += 1;
  }
  const phantomEvents =
    clickDowns.length === 0 ? 0 : linear(phantom / clickDowns.length, PHANTOM_LOW, PHANTOM_HIGH);

  return {
    mixedSuspicious: safe01(mixedSuspicious),
    actionsWithoutPriorEvent: safe01(actionsWithoutPriorEvent),
    phantomEvents: safe01(phantomEvents),
  };
}

// ---------------------------------------------------------------------------
// Checklist final (L137-L144): medidas adicionales, PURAMENTE NUMÉRICAS.
//
// Se reutilizan los helpers privados de arriba (finiteTimes, intervals,
// roboticness, lowerBound, linear, safe01): ninguna función lee DOM/red/storage,
// guarda texto de teclas ni modifica las Arrays de entrada. Todas las medidas
// están en [0,1] (1 = más sospechoso); 0 = "no aparece el patrón", NO "humano".
//
// Umbrales documentados (todos lineales, extremo bajo -> 0, alto -> 1):
// - L137 `mouseKeyboardOverlap`: fracción de momentos de escritura (keydown o
//   input) con una muestra de puntero a ±5ms (sincronización imposible para
//   una persona). <=0.2 -> 0, >=0.8 -> 1.
// - L138 `clickBeforeTyping`: de los ráfagas de escritura (huecos >1500ms),
//   fracción sin click-down en los 3000ms previos (nadie enfocó el campo).
//   <=0.2 -> 0, >=0.8 -> 1. Ojo: autofocus/Tab pueden dar falsos positivos:
//   señal débil, nunca decide por sí sola.
// - L139 `pointerBeforeAction`: fracción de click-downs sin movimiento de
//   puntero en los 400ms previos. PROXY NUMÉRICO de "mirar antes de actuar":
//   no hay mirada/cursor real, solo movimiento previo del puntero. <=0.1 -> 0,
//   >=0.6 -> 1. Es más estricto que `phantomEvents` (800ms y cualquier puntero).
// - L142 `temporalConsistency`: diferencia de `roboticness` entre la primera y
//   la segunda mitad del flujo con más eventos (teclas > clics > movimiento >
//   scrolls; en empate gana el primero de la lista).
//   Cambio de "personalidad" a mitad de sesión: <=0.4 -> 0, >=0.9 -> 1.
// - L143 `sessionVariety`: con una sola sesión disponible, "variedad entre
//   sesiones" se aproxima por diversidad de intervalos DENTRO de la sesión:
//   bots repiten los mismos retardos. Unique-share (redondeo a 1ms) <=0.2 -> 1,
//   >=0.7 -> 0.
// - L144 `actionOrder`: fracción de eventos "up" (keyup/click-up) sin un "down"
//   del mismo flujo en los 5000ms previos (up sin down = orden invertido).
//   <=0.1 -> 0, >=0.6 -> 1.
//
// `now`, si es finito, es el horizonte: las muestras con `t > now` se descartan
// por corruptas. Omitirlo equivale a no filtrar.
// ---------------------------------------------------------------------------

/** Medidas detalladas de coherencia (L137-L144), cada una en [0,1] (1 = sospechoso). */
export interface CoherenceDetailed {
  /** L137: escritura sincronizada con el puntero de forma no humana. */
  mouseKeyboardOverlap: number;
  /** L138: ráfaga de escritura sin clic previo que enfocara el campo. */
  clickBeforeTyping: number;
  /** L139: clic sin movimiento de puntero previo (proxy de "mirar antes de actuar"). */
  pointerBeforeAction: number;
  /** L142: cambio de personalidad rítmica entre la primera y segunda mitad. */
  temporalConsistency: number;
  /** L143: repetición de intervalos (poca variedad entre sesiones). */
  sessionVariety: number;
  /** L144: orden invertido: eventos "up" sin su "down" previo. */
  actionOrder: number;
}

const DETAIL_OVERLAP_MS = 5;
const DETAIL_OVERLAP_LOW = 0.2;
const DETAIL_OVERLAP_HIGH = 0.8;
const DETAIL_TYPING_BURST_GAP_MS = 1500;
const DETAIL_CLICK_BEFORE_MS = 3000;
const DETAIL_CLICK_LOW = 0.2;
const DETAIL_CLICK_HIGH = 0.8;
const DETAIL_AIM_MS = 400;
const DETAIL_AIM_LOW = 0.1;
const DETAIL_AIM_HIGH = 0.6;
const DETAIL_HALF_MIN = 4;
const DETAIL_CONSISTENCY_LOW = 0.4;
const DETAIL_CONSISTENCY_HIGH = 0.9;
const DETAIL_VARIETY_LOW = 0.2;
const DETAIL_VARIETY_HIGH = 0.7;
const DETAIL_ORDER_LOOKBACK_MS = 5000;
const DETAIL_ORDER_LOW = 0.1;
const DETAIL_ORDER_HIGH = 0.6;

/** Copia de muestras con marca finita y no posterior al horizonte `now`. */
function detailInHorizon<T extends { t: number }>(values: T[], horizon: number): T[] {
  if (!Array.isArray(values)) return [];
  const out: T[] = [];
  for (const value of values) {
    if (value && typeof value.t === "number" && Number.isFinite(value.t) && value.t <= horizon) {
      out.push(value);
    }
  }
  return out;
}

/** ¿Hay una marca en `[t - window, t + window]`? Búsqueda binaria, O(log n). */
function detailHasNear(sorted: number[], t: number, window: number): boolean {
  const index = lowerBound(sorted, t - window);
  return index < sorted.length && sorted[index] <= t + window;
}

/** ¿Hay una marca en `[t - window, t)`? (estrictamente antes). */
function detailHasBefore(sorted: number[], t: number, window: number): boolean {
  const index = lowerBound(sorted, t - window);
  return index < sorted.length && sorted[index] < t;
}

/** Marca de escritura: keydown o mutación de texto, ambas ya finitas. */
function detailTypingTimes(keys: KeySample[], inputs: InputSample[]): number[] {
  return [...finiteTimes(downTimes(keys)), ...finiteTimes(inputTimes(inputs))];
}

/** Inicios de ráfaga: primera marca tras un hueco > `DETAIL_TYPING_BURST_GAP_MS`. */
function detailBurstStarts(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const starts: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const t of sorted) {
    if (t - last > DETAIL_TYPING_BURST_GAP_MS) starts.push(t);
    last = t;
  }
  return starts;
}

/** Número de "up" sin ningún "down" del mismo flujo en la ventana previa. */
function detailInvertedUps(downs: number[], ups: number[]): number {
  const sorted = [...downs].sort((a, b) => a - b);
  let inverted = 0;
  for (const up of ups) {
    if (!detailHasBefore(sorted, up, DETAIL_ORDER_LOOKBACK_MS)) inverted += 1;
  }
  return inverted;
}

/** Diferencia de roboticness entre mitades; `null` = muestra insuficiente. */
function detailPersonalityShift(times: number[]): number | null {
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length < DETAIL_HALF_MIN * 2) return null;
  const middle = Math.floor(sorted.length / 2);
  const first = roboticness(sorted.slice(0, middle));
  const second = roboticness(sorted.slice(middle));
  if (first === null || second === null) return null;
  return linear(Math.abs(first - second), DETAIL_CONSISTENCY_LOW, DETAIL_CONSISTENCY_HIGH);
}

/** Poca diversidad de intervalos -> bot que se repite (L143). */
function detailRepetition(times: number[]): number {
  const ds = intervals(times);
  if (ds.length < 3) return 0;
  const uniqueShare = new Set(ds.map((dt) => Math.round(dt))).size / ds.length;
  return 1 - linear(uniqueShare, DETAIL_VARIETY_LOW, DETAIL_VARIETY_HIGH);
}

/**
 * Las seis medidas de coherencia adicionales. Con todas las listas vacías (o
 * sin evidencia útil) devuelve 0 en cada campo. Solo lectura: ordena copias.
 */
export function evaluateCoherenceDetailed(input: {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
  now?: number;
}): CoherenceDetailed {
  const horizon =
    typeof input?.now === "number" && Number.isFinite(input.now)
      ? input.now
      : Number.POSITIVE_INFINITY;
  const points = detailInHorizon(input?.points, horizon);
  const clicks = detailInHorizon(input?.clicks, horizon);
  const scrolls = detailInHorizon(input?.scrolls, horizon);
  const keys = detailInHorizon(input?.keys, horizon);
  const inputs = detailInHorizon(input?.inputs, horizon);

  // L137: sincronización estrecha entre escritura y puntero.
  const pointerTimesSorted = finiteTimes(pointerTimes(points)).sort((a, b) => a - b);
  const typingTimes = detailTypingTimes(keys, inputs);
  let synchronized = 0;
  for (const t of typingTimes) {
    if (detailHasNear(pointerTimesSorted, t, DETAIL_OVERLAP_MS)) synchronized += 1;
  }
  const mouseKeyboardOverlap =
    typingTimes.length === 0
      ? 0
      : linear(synchronized / typingTimes.length, DETAIL_OVERLAP_LOW, DETAIL_OVERLAP_HIGH);

  // L138: cada ráfaga de escritura debería tener un clic previo que enfocara.
  const clickDowns = finiteTimes(clickDownTimes(clicks)).sort((a, b) => a - b);
  const bursts = detailBurstStarts(typingTimes);
  let withoutClick = 0;
  for (const start of bursts) {
    if (!detailHasBefore(clickDowns, start, DETAIL_CLICK_BEFORE_MS)) withoutClick += 1;
  }
  const clickBeforeTyping =
    bursts.length === 0
      ? 0
      : linear(withoutClick / bursts.length, DETAIL_CLICK_LOW, DETAIL_CLICK_HIGH);

  // L139: proxy de "mirar antes de actuar": movimiento de puntero antes del clic.
  const motion = finiteTimes(pointerMotionTimes(points)).sort((a, b) => a - b);
  let withoutAim = 0;
  for (const t of clickDowns) {
    if (!detailHasBefore(motion, t, DETAIL_AIM_MS)) withoutAim += 1;
  }
  const pointerBeforeAction =
    clickDowns.length === 0
      ? 0
      : linear(withoutAim / clickDowns.length, DETAIL_AIM_LOW, DETAIL_AIM_HIGH);

  // L142/L143: flujo con más muestras; se prefieren teclas, luego clics, luego
  // movimiento de puntero y, como último recurso, scrolls (el ritmo de teclas
  // es el más representativo; en empate gana el primero de la lista).
  let rhythmSource: number[] = [];
  for (const candidate of [
    finiteTimes(downTimes(keys)),
    finiteTimes(clickDownTimes(clicks)),
    finiteTimes(pointerMotionTimes(points)),
    finiteTimes(scrolls.map((scroll) => scroll.t)),
  ]) {
    if (candidate.length > rhythmSource.length) rhythmSource = candidate;
  }
  const temporalConsistency = detailPersonalityShift(rhythmSource) ?? 0;
  const sessionVariety = detailRepetition(rhythmSource);

  // L144: "up" sin "down" previo del mismo flujo (teclas y clics por separado).
  const clickUps = finiteTimes(clicks.filter((c) => c.kind === 1).map((c) => c.t));
  const keyUps = finiteTimes(keys.filter((k) => k.kind === 1).map((k) => k.t));
  const totalUps = clickUps.length + keyUps.length;
  const invertedUps =
    detailInvertedUps(finiteTimes(clickDownTimes(clicks)), clickUps) +
    detailInvertedUps(finiteTimes(downTimes(keys)), keyUps);
  const actionOrder =
    totalUps === 0 ? 0 : linear(invertedUps / totalUps, DETAIL_ORDER_LOW, DETAIL_ORDER_HIGH);

  return {
    mouseKeyboardOverlap: safe01(mouseKeyboardOverlap),
    clickBeforeTyping: safe01(clickBeforeTyping),
    pointerBeforeAction: safe01(pointerBeforeAction),
    temporalConsistency: safe01(temporalConsistency),
    sessionVariety: safe01(sessionVariety),
    actionOrder: safe01(actionOrder),
  };
}
