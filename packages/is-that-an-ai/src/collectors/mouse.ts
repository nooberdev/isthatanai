// Colector de puntero. Solo metadata numérica: nunca se guardan eventos ni
// referencias al DOM. Los listeners se registran únicamente dentro de attach().

import type { Collector, PointerSample } from "../types";
import { RingBuffer } from "../utils/ring-buffer";

/** Forma mínima y opcional de un PointerEvent (sirve para targets falsos en tests). */
interface PointerLike {
  clientX?: number;
  clientY?: number;
  timeStamp?: number;
  pointerType?: string;
  isTrusted?: boolean;
  getCoalescedEvents?: () => PointerLike[];
}

export interface MouseCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la función (nunca al importar). */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la función. */
  now?: () => number;
  bufferSize?: number;
  /** Permite compartir el buffer con el detector. */
  buffer?: RingBuffer;
}

export interface MouseCollector extends Collector {
  readonly buffer: RingBuffer;
  readonly lastEventAt: number;
  getSamples(): PointerSample[];
  /** Cuenta eventos de puntero (no muestras coalesced) desde `cutoff`. */
  eventsSince(cutoff: number): number;
}

const MOVE_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
// pointerenter/pointerleave no burbujean: con capture: true en document se
// recibirían los cruces de cada elemento hijo. Sin capture solo se disparan
// al cruzar la frontera del propio boundary.
const BOUNDARY_LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };

function numeric(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pointerTypeCode(value: string | undefined): PointerSample["pointerType"] {
  switch (value) {
    case "mouse":
      return 0;
    case "pen":
      return 1;
    case "touch":
      return 2;
    default:
      return 3;
  }
}

export function createMouseCollector({
  target = window,
  now = performance.now,
  bufferSize = 2048,
  buffer = new RingBuffer(bufferSize),
}: MouseCollectorOptions = {}): MouseCollector {
  let attached = false;
  let boundary: EventTarget | null = null;
  let seq = 0;
  let lastEventAt = 0;
  const eventTimes: number[] = [];

  function append(
    x: number,
    y: number,
    t: number,
    kind: PointerSample["kind"],
    pointerType: PointerSample["pointerType"],
    trusted: 0 | 1,
  ): void {
    seq += 1;
    buffer.push(seq, x, y, t, kind, pointerType, trusted);
  }

  function record(event: Event, kind: PointerSample["kind"]): void {
    const input = event as unknown as PointerLike;
    const x = numeric(input.clientX, 0);
    const y = numeric(input.clientY, 0);
    const t = numeric(input.timeStamp, 0);
    const pointerType = pointerTypeCode(input.pointerType);
    const trusted: 0 | 1 = input.isTrusted ? 1 : 0;

    const getCoalesced = input.getCoalescedEvents;
    const coalesced = typeof getCoalesced === "function" ? getCoalesced.call(input) : undefined;
    if (coalesced && coalesced.length > 0) {
      for (let i = 0; i < coalesced.length; i += 1) {
        const item = coalesced[i];
        append(
          numeric(item.clientX, x),
          numeric(item.clientY, y),
          numeric(item.timeStamp, t),
          kind,
          item.pointerType !== undefined ? pointerTypeCode(item.pointerType) : pointerType,
          typeof item.isTrusted === "boolean" ? (item.isTrusted ? 1 : 0) : trusted,
        );
      }
    }
    // La muestra principal siempre se guarda, incluso cuando hay coalesced.
    append(x, y, t, kind, pointerType, trusted);

    // Un evento = una marca de tiempo, sin importar cuántas muestras produjo.
    const at = now();
    eventTimes.push(at);
    const cutoff = at - 1000;
    while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
      eventTimes.shift();
    }
    lastEventAt = t;
  }

  const onMove = (event: Event): void => record(event, 0);
  const onEnter = (event: Event): void => record(event, 1);
  const onLeave = (event: Event): void => record(event, 2);

  function attach(): void {
    if (attached) return;
    // Resolver la frontera aquí: en el navegador es `document`; con un target
    // inyectado que no expone `.document`, se usa el propio target.
    const withDocument = target as EventTarget & { document?: EventTarget };
    boundary = withDocument.document ?? target;
    target.addEventListener("pointermove", onMove, MOVE_LISTENER_OPTIONS);
    boundary.addEventListener("pointerenter", onEnter, BOUNDARY_LISTENER_OPTIONS);
    boundary.addEventListener("pointerleave", onLeave, BOUNDARY_LISTENER_OPTIONS);
    attached = true;
  }

  function detach(): void {
    if (!attached) return;
    target.removeEventListener("pointermove", onMove, MOVE_LISTENER_OPTIONS);
    boundary?.removeEventListener("pointerenter", onEnter, BOUNDARY_LISTENER_OPTIONS);
    boundary?.removeEventListener("pointerleave", onLeave, BOUNDARY_LISTENER_OPTIONS);
    boundary = null;
    attached = false;
  }

  return {
    buffer,
    attach,
    detach,
    getSamples: () => buffer.snapshot(),
    get lastEventAt(): number {
      return lastEventAt;
    },
    eventsSince(cutoff: number): number {
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
      return eventTimes.length;
    },
  };
}
