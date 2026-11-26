// Detección de replay/repetición de sesión dentro de la misma sesión.
//
// Solo magnitudes numéricas: coordenadas (x/y, dx/dy), deltas de tiempo y
// atributos enteros (kind, pointerType, trusted, category, inputType...).
// NUNCA se comparan textos, teclas ni `code`/`key`: las categorías de teclado
// ya son números en `types.ts`. Sin DOM, sin red, sin storage, sin reloj.
//
// Todas las señales están en [0,1]; 1 = la sesión anterior se repitió de forma
// idéntica. 0 = no hay evidencia (o no aparece el patrón), NUNCA "humano".
// Entradas hostiles (NaN/Infinity/negativas/enormes) se descartan o saturan.
// Complejidad O(n + k) por comparación, con k = SLOTS fijo (24).
//
// Umbrales documentados:
// - `repeatedPath`: distancia RMS entre vectores de ruta remuestreados y
//   centrados; <=0.08 -> 1, >=1 -> 0. Se requieren >=3 muestras con
//   coordenadas finitas en ambas sesiones.
// - `repeatedTiming`: misma escala sobre los gaps entre eventos, normalizados
//   por su media (un desplazamiento constante de `t` no rompe la igualdad);
//   gaps >60000ms se saturan. RMS <=0.02 -> 1, >=0.3 -> 0 (más estricto que
//   la ruta: dos sesiones distintas pueden compartir la misma cadencia).
//   Se requieren >=3 gaps en ambas.
// - `identicalSequence`: media ponderada de ruta (0.5), timing (0.35) y
//   estructura (0.15) renormalizada según qué medidas tengan evidencia.

import type { ClickSample, InputSample, KeySample, PointerSample, ScrollSample } from "../types";
import { clamp, linear } from "../utils/math";

/** Instantánea numérica de una sesión (solo lo que el detector ya guarda). */
export interface ReplayInput {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
}

/** Tres medidas de repetición, cada una en [0,1] (1 = replay idéntico). */
export interface ReplaySignals {
  repeatedPath: number;
  repeatedTiming: number;
  identicalSequence: number;
}

const SLOTS = 24;
const DEFAULT_HISTORY_SIZE = 8;
const MAX_HISTORY_SIZE = 64;
const MAX_GAP_MS = 60_000;
const MIN_COORD_SAMPLES = 3;
const MIN_GAPS = 3;
const MIN_STRUCTURE_SAMPLES = 2;

type StreamKind = "point" | "click" | "scroll" | "key" | "input";
const STREAM_KINDS: readonly StreamKind[] = ["point", "click", "scroll", "key", "input"];

function emptySignals(): ReplaySignals {
  return { repeatedPath: 0, repeatedTiming: 0, identicalSequence: 0 };
}

/** Número finito o `null`: NaN/Infinity nunca generan patrones. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Copia defensiva de una instantánea: el llamador puede mutar la suya después. */
function snapshotOf(input: ReplayInput | null | undefined): ReplayInput {
  return {
    points: copySamples(input?.points),
    clicks: copySamples(input?.clicks),
    scrolls: copySamples(input?.scrolls),
    keys: copySamples(input?.keys),
    inputs: copySamples(input?.inputs),
  };
}

function copySamples<T>(value: readonly T[] | undefined | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    try {
      out.push({ ...(item as object) } as T);
    } catch {
      // Getters hostiles: conservamos la referencia, las medidas filtran números.
      out.push(item);
    }
  }
  return out;
}

function hasAny(input: ReplayInput): boolean {
  return (
    input.points.length > 0 ||
    input.clicks.length > 0 ||
    input.scrolls.length > 0 ||
    input.keys.length > 0 ||
    input.inputs.length > 0
  );
}

/** Remuestreo a `SLOTS` posiciones por interpolación lineal de índice. */
function resample(values: number[]): number[] {
  const out = new Array<number>(SLOTS).fill(0);
  const n = values.length;
  if (n === 0) return out;
  if (n === 1) {
    out.fill(values[0]);
    return out;
  }
  for (let i = 0; i < SLOTS; i += 1) {
    const pos = (i / (SLOTS - 1)) * (n - 1);
    const lo = Math.floor(pos);
    const hi = lo + 1 < n ? lo + 1 : n - 1;
    const raw = values[lo] + (values[hi] - values[lo]) * (pos - lo);
    // Un par 1e308 puede desbordar al interpolar: se conserva el extremo finito.
    out[i] = Number.isFinite(raw) ? raw : values[lo];
  }
  return out;
}

/** Centra y escala por la desviación máxima; invvariante a traslación/escala. */
function centered(values: number[]): number[] {
  let average = 0;
  let count = 0;
  for (const value of values) {
    count += 1;
    average += (value - average) / count;
  }
  let scale = 0;
  for (const value of values) {
    const deviation = Math.abs(value - average);
    if (Number.isFinite(deviation) && deviation > scale) scale = deviation;
  }
  if (!Number.isFinite(scale) || scale <= 1e-9) scale = 1;
  return values.map((value) => (value - average) / scale);
}

/** Similitud 1 - linear(RMS, low, high); idéntico -> 1, muy distinto -> 0. */
function vectorSimilarity(a: number[], b: number[], low = 0.08, high = 1): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let squares = 0;
  for (let i = 0; i < n; i += 1) {
    const delta = a[i] - b[i];
    squares += delta * delta;
  }
  const rms = Math.sqrt(squares / n);
  return Number.isFinite(rms) ? 1 - linear(rms, low, high) : 0;
}

/** Coordenadas finitas intercaladas (x0,y0,x1,y1,...) de un flujo. */
function coordinates(input: ReplayInput, kind: StreamKind): number[] {
  const out: number[] = [];
  if (kind === "point") {
    for (const s of input.points) {
      const x = num(s?.x);
      const y = num(s?.y);
      if (x !== null && y !== null) out.push(x, y);
    }
  } else if (kind === "click") {
    for (const s of input.clicks) {
      const x = num(s?.x);
      const y = num(s?.y);
      if (x !== null && y !== null) out.push(x, y);
    }
  } else if (kind === "scroll") {
    for (const s of input.scrolls) {
      const dx = num(s?.dx);
      const dy = num(s?.dy);
      if (dx !== null && dy !== null) out.push(dx, dy);
    }
  }
  return out;
}

function pathVector(input: ReplayInput): number[] | null {
  const point = coordinates(input, "point");
  const click = coordinates(input, "click");
  const scroll = coordinates(input, "scroll");
  if ((point.length + click.length + scroll.length) / 2 < MIN_COORD_SAMPLES) return null;
  return [
    ...centered(resample(point)),
    ...centered(resample(click)),
    ...centered(resample(scroll)),
  ];
}

/** Gaps positivos entre todas las marcas finitas, ordenadas por tiempo. */
function gapsOf(input: ReplayInput): number[] {
  const times: number[] = [];
  for (const s of input.points) {
    const t = num(s?.t);
    if (t !== null) times.push(t);
  }
  for (const s of input.clicks) {
    const t = num(s?.t);
    if (t !== null) times.push(t);
  }
  for (const s of input.scrolls) {
    const t = num(s?.t);
    if (t !== null) times.push(t);
  }
  for (const s of input.keys) {
    const t = num(s?.t);
    if (t !== null) times.push(t);
  }
  for (const s of input.inputs) {
    const t = num(s?.t);
    if (t !== null) times.push(t);
  }
  times.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const delta = times[i] - times[i - 1];
    if (delta > 0 && Number.isFinite(delta)) gaps.push(Math.min(delta, MAX_GAP_MS));
  }
  return gaps;
}

function timingVector(input: ReplayInput): number[] | null {
  const gaps = gapsOf(input);
  if (gaps.length < MIN_GAPS) return null;
  let average = 0;
  for (let i = 0; i < gaps.length; i += 1) average += (gaps[i] - average) / (i + 1);
  if (!Number.isFinite(average) || average <= 1e-9) return null;
  // Normalizar por la media hace equivalente un replay con `t` desplazado.
  return resample(gaps.map((gap) => Math.min(gap / average, 1e6)));
}

/** Atributos numéricos acotados a [0,1] de una muestra (nunca texto). */
function attributes(input: ReplayInput, kind: StreamKind): number[] {
  const out: number[] = [];
  if (kind === "point") {
    for (const s of input.points) {
      const k = num(s?.kind) ?? 0;
      const pointerType = num(s?.pointerType) ?? 3;
      out.push(
        clamp(k / 2, 0, 1),
        clamp(pointerType / 3, 0, 1),
        num(s?.trusted) === 1 ? 1 : 0,
        k === 0 ? 1 : 0,
      );
    }
  } else if (kind === "click") {
    for (const s of input.clicks) {
      out.push(
        clamp((num(s?.kind) ?? 0) / 1, 0, 1),
        clamp((num(s?.button) ?? 0) / 2, 0, 1),
        num(s?.trusted) === 1 ? 1 : 0,
      );
    }
  } else if (kind === "scroll") {
    for (const s of input.scrolls) {
      const dx = num(s?.dx) ?? 0;
      const dy = num(s?.dy) ?? 0;
      out.push(
        clamp((num(s?.source) ?? 0) / 1, 0, 1),
        num(s?.trusted) === 1 ? 1 : 0,
        dx > 0 ? 1 : dx < 0 ? 0 : 0.5,
        dy > 0 ? 1 : dy < 0 ? 0 : 0.5,
      );
    }
  } else if (kind === "key") {
    for (const s of input.keys) {
      out.push(
        clamp((num(s?.kind) ?? 0) / 1, 0, 1),
        clamp((num(s?.category) ?? 7) / 7, 0, 1),
        num(s?.trusted) === 1 ? 1 : 0,
      );
    }
  } else if (kind === "input") {
    for (const s of input.inputs) {
      out.push(
        clamp((num(s?.kind) ?? 0) / 1, 0, 1),
        clamp((num(s?.inputType) ?? 5) / 5, 0, 1),
        num(s?.trusted) === 1 ? 1 : 0,
      );
    }
  }
  return out;
}

function countOf(input: ReplayInput, kind: StreamKind): number {
  if (kind === "point") return input.points.length;
  if (kind === "click") return input.clicks.length;
  if (kind === "scroll") return input.scrolls.length;
  if (kind === "key") return input.keys.length;
  return input.inputs.length;
}

/** Acuerdo de estructura: conteo por flujo + atributos remuestreados. */
function structureScore(a: ReplayInput, b: ReplayInput): number | null {
  let total = 0;
  let weight = 0;
  for (const kind of STREAM_KINDS) {
    const ca = countOf(a, kind);
    const cb = countOf(b, kind);
    if (ca === 0 && cb === 0) continue;
    if (ca < MIN_STRUCTURE_SAMPLES || cb < MIN_STRUCTURE_SAMPLES) {
      // Un flujo con 1 sola muestra no basta para afirmar repetición.
      total += 0;
      weight += 1;
      continue;
    }
    const countAgreement = Math.min(ca, cb) / Math.max(ca, cb);
    const similarity = vectorSimilarity(
      resample(attributes(a, kind)),
      resample(attributes(b, kind)),
    );
    total += countAgreement * similarity;
    weight += 1;
  }
  return weight === 0 ? null : clamp(total / weight, 0, 1);
}

/**
 * Compara dos instantáneas. `1` = la sesión anterior se repitió idéntica;
 * `0` = sin evidencia o sin patrón. No muta ni conserva referencias.
 */
export function detectReplay(a: ReplayInput, b: ReplayInput): ReplaySignals {
  const first = snapshotOf(a);
  const second = snapshotOf(b);
  if (!hasAny(first) || !hasAny(second)) return emptySignals();

  const firstPath = pathVector(first);
  const secondPath = pathVector(second);
  const path =
    firstPath !== null && secondPath !== null ? vectorSimilarity(firstPath, secondPath) : null;
  const firstTiming = timingVector(first);
  const secondTiming = timingVector(second);
  // El ritmo es más discriminante que la ruta: dos sesiones distintas pueden
  // compartir cadencia (p. ej. 32ms ± jitter), así que exigimos mayor control.
  const timing =
    firstTiming !== null && secondTiming !== null
      ? vectorSimilarity(firstTiming, secondTiming, 0.02, 0.3)
      : null;
  const structure = structureScore(first, second);

  let sum = 0;
  let weight = 0;
  if (path !== null) {
    sum += path * 0.5;
    weight += 0.5;
  }
  if (timing !== null) {
    sum += timing * 0.35;
    weight += 0.35;
  }
  if (structure !== null) {
    sum += structure * 0.15;
    weight += 0.15;
  }

  return {
    repeatedPath: path === null ? 0 : clamp(path, 0, 1),
    repeatedTiming: timing === null ? 0 : clamp(timing, 0, 1),
    identicalSequence: weight === 0 ? 0 : clamp(sum / weight, 0, 1),
  };
}

/**
 * Historial acotado de instantáneas. `signals()` toma el par más parecido del
 * historial (máximo de `identicalSequence`), que es lo que delata un replay
 * aunque la copia no sea la última muestra. Sin dos muestras -> todo 0.
 */
export class ReplayTracker {
  private readonly limit: number;
  private readonly history: ReplayInput[] = [];

  constructor(options?: { historySize?: number }) {
    const raw = options?.historySize;
    this.limit =
      typeof raw === "number" && Number.isFinite(raw)
        ? clamp(Math.floor(raw), 1, MAX_HISTORY_SIZE)
        : DEFAULT_HISTORY_SIZE;
  }

  push(snapshot: ReplayInput): void {
    this.history.push(snapshotOf(snapshot));
    if (this.history.length > this.limit) {
      this.history.splice(0, this.history.length - this.limit);
    }
  }

  signals(): ReplaySignals {
    let best = emptySignals();
    for (let i = 0; i < this.history.length; i += 1) {
      for (let j = i + 1; j < this.history.length; j += 1) {
        const candidate = detectReplay(this.history[i], this.history[j]);
        if (candidate.identicalSequence > best.identicalSequence) best = candidate;
      }
    }
    return best;
  }

  reset(): void {
    this.history.length = 0;
  }
}
