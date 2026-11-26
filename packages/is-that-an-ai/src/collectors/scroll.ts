// Colector de scroll. Solo metadata numérica; listeners registrados únicamente
// dentro de attach() y siempre pasivos. Sin DOM al importar.
//
// Dos fuentes: `wheel` (source 0) y `scroll` real del documento (source 1).
// El listener `scroll` se registra en `window` (el target por defecto) con
// capture: true + passive: true, y lee SOLO dentro del listener las propiedades
// scrollX/scrollY, que son estado de scroll del documento, NO geometría de
// layout: no se llama a getBoundingClientRect ni a ninguna medición.

import type { Collector, ScrollSample } from "../types";
import { NumericRingBuffer } from "../utils/numeric-ring-buffer";

export interface ScrollCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la función. */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la función. */
  now?: () => number;
  bufferSize?: number;
}

export interface ScrollCollector extends Collector {
  readonly buffer: NumericRingBuffer;
  readonly lastEventAt: number;
  getSamples(): ScrollSample[];
  discardOldestBefore(tMin: number): number;
  eventsSince(cutoff: number): number;
  clear(): void;
}

const WHEEL_LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };
const SCROLL_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Aproximación documentada para normalizar `deltaMode` a píxeles SIN leer
 * layout (no se consulta innerHeight ni ninguna geometría del documento):
 * - modo 1 (líneas): 16 px por línea (altura típica de una línea de texto).
 * - modo 2 (páginas): 800 px por página (viewport típico de escritorio).
 * El modo 0 ya viene en píxeles. La constante es deliberadamente burda: el
 * scoring compara ratios relativos, no magnitudes absolutas.
 */
export const LINES_TO_PX = 16;
export const PAGES_TO_PX = 800;

const SEQ = 0;
const DX = 1;
const DY = 2;
const T = 3;
const TRUSTED = 4;
const SOURCE = 5;
const FIELDS = 6;

/** Lectura defensiva: un getter que lanza se trata como propiedad ausente. */
function read(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function numeric(object: object, key: string, fallback: number): number {
  const value = read(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Solo `true` cuenta como confiable: `1`, `"true"` o un getter hostil no. */
function trustedOf(object: object): 0 | 1 {
  return read(object, "isTrusted") === true ? 1 : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function toPixels(value: number, mode: number): number {
  const pixels = mode === 1 ? value * LINES_TO_PX : mode === 2 ? value * PAGES_TO_PX : value;
  // Un delta hostil no puede introducir Infinity/NaN en el buffer.
  return Number.isFinite(pixels) ? pixels : 0;
}

function toSample(row: Float64Array): ScrollSample {
  return {
    seq: row[SEQ],
    dx: row[DX],
    dy: row[DY],
    t: row[T],
    trusted: row[TRUSTED] as 0 | 1,
    source: row[SOURCE] as 0 | 1,
  };
}

export function createScrollCollector({
  target = window,
  now = performance.now,
  bufferSize = 1024,
}: ScrollCollectorOptions = {}): ScrollCollector {
  const buffer = new NumericRingBuffer(bufferSize, FIELDS);
  let attached = false;
  let seq = 0;
  let lastEventAt = 0;
  let lastScrollX: number | null = null;
  let lastScrollY: number | null = null;
  const eventTimes: number[] = [];

  function clock(): number | null {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function append(dx: number, dy: number, t: number, trusted: 0 | 1, source: 0 | 1): void {
    seq += 1;
    buffer.push(seq, dx, dy, t, trusted, source);
    lastEventAt = t;
    const at = clock();
    if (at !== null) {
      eventTimes.push(at);
      const cutoff = at - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
    }
  }

  function recordWheel(event: Event): void {
    if (!attached) return;
    const input = event as unknown as object;
    const mode = numeric(input, "deltaMode", 0);
    append(
      toPixels(numeric(input, "deltaX", 0), mode),
      toPixels(numeric(input, "deltaY", 0), mode),
      numeric(input, "timeStamp", 0),
      trustedOf(input),
      0,
    );
  }

  function recordScroll(event: Event): void {
    if (!attached) return;
    // Estado de scroll, leído AQUÍ (nunca al importar ni en el constructor).
    const host = target as unknown as object;
    const x = numeric(host, "scrollX", 0);
    const y = numeric(host, "scrollY", 0);
    const dx = lastScrollX === null ? 0 : x - lastScrollX;
    const dy = lastScrollY === null ? 0 : y - lastScrollY;
    lastScrollX = x;
    lastScrollY = y;
    append(
      finite(dx),
      finite(dy),
      numeric(event as unknown as object, "timeStamp", 0),
      trustedOf(event as unknown as object),
      1,
    );
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      target.addEventListener("wheel", recordWheel, WHEEL_LISTENER_OPTIONS);
      target.addEventListener("scroll", recordScroll, SCROLL_LISTENER_OPTIONS);
    } catch {
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("wheel", recordWheel, WHEEL_LISTENER_OPTIONS);
      target.removeEventListener("scroll", recordScroll, SCROLL_LISTENER_OPTIONS);
    } catch {
      // target hostil: no se puede hacer más.
    }
  }

  return {
    buffer,
    attach,
    detach,
    getSamples: () => buffer.rows().map(toSample),
    discardOldestBefore: (tMin: number) => buffer.discardOldestBefore(tMin, T),
    eventsSince(cutoff: number): number {
      if (typeof cutoff !== "number" || !Number.isFinite(cutoff)) return 0;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
      return eventTimes.length;
    },
    clear(): void {
      buffer.clear();
      eventTimes.length = 0;
      lastScrollX = null;
      lastScrollY = null;
      lastEventAt = 0;
    },
    get lastEventAt(): number {
      return lastEventAt;
    },
  };
}
