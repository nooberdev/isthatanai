// Colector de clics. Solo metadata numérica: nunca se guardan eventos ni
// referencias al DOM. Los listeners se registran únicamente dentro de attach()
// y son pasivos. Sin window/document/navigator al importar.

import type { ClickSample, Collector } from "../types";
import { NumericRingBuffer } from "../utils/numeric-ring-buffer";

export interface ClickCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la función. */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la función. */
  now?: () => number;
  bufferSize?: number;
}

export interface ClickCollector extends Collector {
  readonly buffer: NumericRingBuffer;
  readonly lastEventAt: number;
  getSamples(): ClickSample[];
  discardOldestBefore(tMin: number): number;
  eventsSince(cutoff: number): number;
  clear(): void;
}

const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };

const SEQ = 0;
const X = 1;
const Y = 2;
const T = 3;
const KIND = 4;
const BUTTON = 5;
const TRUSTED = 6;
const FIELDS = 7;

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

function toSample(row: Float64Array): ClickSample {
  return {
    seq: row[SEQ],
    x: row[X],
    y: row[Y],
    t: row[T],
    kind: row[KIND] as 0 | 1,
    button: row[BUTTON],
    trusted: row[TRUSTED] as 0 | 1,
  };
}

export function createClickCollector({
  target = window,
  now = performance.now,
  bufferSize = 512,
}: ClickCollectorOptions = {}): ClickCollector {
  const buffer = new NumericRingBuffer(bufferSize, FIELDS);
  let attached = false;
  let seq = 0;
  let lastEventAt = 0;
  const eventTimes: number[] = [];

  function clock(): number | null {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function record(event: Event, kind: 0 | 1): void {
    if (!attached) return;
    const input = event as unknown as object;
    const x = numeric(input, "clientX", 0);
    const y = numeric(input, "clientY", 0);
    const t = numeric(input, "timeStamp", 0);
    const button = numeric(input, "button", 0);
    const trusted = trustedOf(input);

    seq += 1;
    buffer.push(seq, x, y, t, kind, button, trusted);
    lastEventAt = t;

    // Un evento = una marca de reloj, sin importar cuántos campos se guardaron.
    const at = clock();
    if (at !== null) {
      eventTimes.push(at);
      const cutoff = at - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
    }
  }

  const onDown = (event: Event): void => record(event, 0);
  const onUp = (event: Event): void => record(event, 1);

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      target.addEventListener("pointerdown", onDown, LISTENER_OPTIONS);
      target.addEventListener("pointerup", onUp, LISTENER_OPTIONS);
    } catch {
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("pointerdown", onDown, LISTENER_OPTIONS);
      target.removeEventListener("pointerup", onUp, LISTENER_OPTIONS);
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
      lastEventAt = 0;
    },
    get lastEventAt(): number {
      return lastEventAt;
    },
  };
}
