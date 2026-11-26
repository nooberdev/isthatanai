// Colector de clics. Solo metadata numérica: nunca se guardan eventos ni
// referencias al DOM. Los listeners se registran únicamente dentro de attach()
// y son pasivos. Sin window/document/navigator al importar.

import type { ClickSample, Collector } from "../types";
import { NumericRingBuffer } from "../utils/numeric-ring-buffer";

/** Forma mínima y opcional de un PointerEvent (sirve para targets falsos). */
interface ClickLike {
  clientX?: number;
  clientY?: number;
  timeStamp?: number;
  button?: number;
  isTrusted?: boolean;
}

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

function numeric(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

  function record(event: Event, kind: 0 | 1): void {
    const input = event as unknown as ClickLike;
    const x = numeric(input.clientX, 0);
    const y = numeric(input.clientY, 0);
    const t = numeric(input.timeStamp, 0);
    const button = numeric(input.button, 0);
    const trusted: 0 | 1 = input.isTrusted ? 1 : 0;

    seq += 1;
    buffer.push(seq, x, y, t, kind, button, trusted);
    lastEventAt = t;

    // Un evento = una marca de reloj, sin importar cuántos campos se guardaron.
    const at = now();
    eventTimes.push(at);
    const cutoff = at - 1000;
    while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
  }

  const onDown = (event: Event): void => record(event, 0);
  const onUp = (event: Event): void => record(event, 1);

  function attach(): void {
    if (attached) return;
    target.addEventListener("pointerdown", onDown, LISTENER_OPTIONS);
    target.addEventListener("pointerup", onUp, LISTENER_OPTIONS);
    attached = true;
  }

  function detach(): void {
    if (!attached) return;
    target.removeEventListener("pointerdown", onDown, LISTENER_OPTIONS);
    target.removeEventListener("pointerup", onUp, LISTENER_OPTIONS);
    attached = false;
  }

  return {
    buffer,
    attach,
    detach,
    getSamples: () => buffer.rows().map(toSample),
    discardOldestBefore: (tMin: number) => buffer.discardOldestBefore(tMin, T),
    eventsSince(cutoff: number): number {
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
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
