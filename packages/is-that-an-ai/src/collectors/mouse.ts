// Colector de puntero. Solo metadata numérica: nunca se guardan eventos ni
// referencias al DOM. Los listeners se registran únicamente dentro de attach().

import type { Collector, PointerSample } from "../types";
import { RingBuffer } from "../utils/ring-buffer";

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

/** Tope de muestras coalesced por evento: un `length` hostil no puede bloquear el hilo. */
const MAX_COALESCED_EVENTS = 64;

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

function pointerTypeCode(value: unknown): PointerSample["pointerType"] {
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

  function clock(): number | null {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function recordCoalesced(
    input: object,
    x: number,
    y: number,
    t: number,
    kind: PointerSample["kind"],
    pointerType: PointerSample["pointerType"],
    trusted: 0 | 1,
  ): void {
    const getCoalesced = read(input, "getCoalescedEvents");
    if (typeof getCoalesced !== "function") return;
    try {
      const coalesced = getCoalesced.call(input) as unknown;
      if (!Array.isArray(coalesced)) return;
      const count = Math.min(coalesced.length, MAX_COALESCED_EVENTS);
      for (let i = 0; i < count; i += 1) {
        const item = coalesced[i];
        if (!item || typeof item !== "object") continue;
        const itemType = read(item, "pointerType");
        append(
          numeric(item, "clientX", x),
          numeric(item, "clientY", y),
          numeric(item, "timeStamp", t),
          kind,
          itemType !== undefined ? pointerTypeCode(itemType) : pointerType,
          typeof read(item, "isTrusted") === "boolean" ? trustedOf(item) : trusted,
        );
      }
    } catch {
      // Coalesced malformed: se conserva SOLO la muestra principal.
    }
  }

  function record(event: Event, kind: PointerSample["kind"]): void {
    if (!attached) return;
    const input = event as unknown as object;
    const x = numeric(input, "clientX", 0);
    const y = numeric(input, "clientY", 0);
    const t = numeric(input, "timeStamp", 0);
    const pointerType = pointerTypeCode(read(input, "pointerType"));
    const trusted = trustedOf(input);

    recordCoalesced(input, x, y, t, kind, pointerType, trusted);
    // La muestra principal siempre se guarda, incluso cuando hay coalesced.
    append(x, y, t, kind, pointerType, trusted);

    // Un evento = una marca de tiempo, sin importar cuántas muestras produjo.
    const at = clock();
    if (at !== null) {
      eventTimes.push(at);
      const cutoff = at - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
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
    let resolved: EventTarget;
    try {
      const withDocument = target as EventTarget & { document?: EventTarget };
      resolved = withDocument.document ?? target;
    } catch {
      resolved = target;
    }
    boundary = resolved;
    attached = true;
    try {
      target.addEventListener("pointermove", onMove, MOVE_LISTENER_OPTIONS);
      resolved.addEventListener("pointerenter", onEnter, BOUNDARY_LISTENER_OPTIONS);
      resolved.addEventListener("pointerleave", onLeave, BOUNDARY_LISTENER_OPTIONS);
    } catch {
      // Registro parcial: se desmonta lo que se hubiera añadido (fail-closed).
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("pointermove", onMove, MOVE_LISTENER_OPTIONS);
    } catch {
      // target hostil: no se puede hacer más.
    }
    try {
      boundary?.removeEventListener("pointerenter", onEnter, BOUNDARY_LISTENER_OPTIONS);
      boundary?.removeEventListener("pointerleave", onLeave, BOUNDARY_LISTENER_OPTIONS);
    } catch {
      // boundary hostil: no se puede hacer más.
    }
    boundary = null;
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
      if (typeof cutoff !== "number" || !Number.isFinite(cutoff)) return 0;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
      return eventTimes.length;
    },
  };
}
