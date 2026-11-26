// Colector de atencion: visibilidad de pestana, foco, tamano de ventana e
// inactividad. Solo numeros: seq, marca de tiempo, codigo de evento y trusted.
// Sin window/document/navigator a nivel de modulo (SSR-safe): las heuristicas
// de document se resuelven DENTRO de attach() y se limpian en detach().
//
// kind: 0 visible, 1 hidden, 2 focus, 3 blur, 4 resize, 5 idle, 6 active.
// trusted: 1 solo si isTrusted === true de forma estricta.

import { clamp } from "../utils/math";

/** Muestra de atencion: exclusivamente numeros, sin texto ni teclas. */
export interface AttentionSample {
  seq: number;
  t: number;
  kind: number;
  trusted: 0 | 1;
}

export interface AttentionCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la funcion (nunca al importar). */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la funcion. */
  now?: () => number;
  bufferSize?: number;
}

export interface AttentionCollector {
  attach(): void;
  detach(): void;
  getSamples(): AttentionSample[];
  clear(): void;
  eventsSince(cutoff: number): number;
  readonly lastEventAt: number;
}

const DEFAULT_BUFFER_SIZE = 512;
const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };
/** Umbral de inactividad: 30 s sin actividad senala idle (heuristica en attach). */
const IDLE_MS = 30_000;
const MAX_TIME = 1e15;

const SEQ = 0;
const T = 1;
const KIND = 2;
const TRUSTED = 3;
const FIELDS = 4;

class AttentionRing {
  readonly capacity: number;
  private readonly data: Float64Array;
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
    this.data = new Float64Array(this.capacity * FIELDS);
  }

  push(seq: number, t: number, kind: number, trusted: number): void {
    const index = (this.start + this.count) % this.capacity;
    const base = index * FIELDS;
    this.data[base + SEQ] = seq;
    this.data[base + T] = t;
    this.data[base + KIND] = kind;
    this.data[base + TRUSTED] = trusted;
    if (this.count === this.capacity) this.start = (this.start + 1) % this.capacity;
    else this.count += 1;
  }

  snapshot(): AttentionSample[] {
    const result: AttentionSample[] = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const base = ((this.start + i) % this.capacity) * FIELDS;
      result[i] = {
        seq: this.data[base + SEQ],
        t: this.data[base + T],
        kind: this.data[base + KIND],
        trusted: this.data[base + TRUSTED] as 0 | 1,
      };
    }
    return result;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}

/** Lectura defensiva: un getter/proxy que lanza se trata como propiedad ausente. */
function read(object: object | null, key: string): unknown {
  if (object === null) return undefined;
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function numeric(object: object | null, key: string, fallback: number): number {
  const value = read(object, key);
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, clamp(value, -MAX_TIME, MAX_TIME))
    : fallback;
}

/** Solo `true` estricto cuenta como confiable. */
function trustedOf(object: object | null): 0 | 1 {
  return read(object, "isTrusted") === true ? 1 : 0;
}

export function createAttentionCollector({
  target = window,
  now = performance.now,
  bufferSize = DEFAULT_BUFFER_SIZE,
}: AttentionCollectorOptions = {}): AttentionCollector {
  const ring = new AttentionRing(bufferSize);
  let attached = false;
  let seq = 0;
  let lastEventAt = 0;
  let doc: EventTarget | null = null;
  let idle = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const eventTimes: number[] = [];

  /** Heuristica de document: se resuelve en attach(), nunca al importar. */
  function resolveDocument(): EventTarget | null {
    try {
      if (typeof document !== "undefined" && document !== null) return document;
    } catch {
      // Entorno sin document: se continua con el target inyectado.
    }
    try {
      const candidate = (target as EventTarget & { document?: EventTarget }).document;
      return candidate !== null && typeof candidate === "object" ? candidate : null;
    } catch {
      return null;
    }
  }

  function clock(): number | null {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function emit(kind: number, event: Event | null): void {
    if (!attached) return;
    try {
      const input = (event ?? null) as unknown as object | null;
      const at = clock();
      const t = event ? numeric(input, "timeStamp", at ?? 0) : (at ?? 0);
      const trusted = event ? trustedOf(input) : 0;
      seq += 1;
      ring.push(seq, t, kind, trusted);
      lastEventAt = t;
      if (at !== null) {
        eventTimes.push(at);
        const cutoff = at - 1000;
        while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
      }
    } catch {
      // Nunca propagar excepciones de eventos hostiles fuera del listener.
    }
  }

  function visibilityKind(event: Event): 0 | 1 {
    const input = event as unknown as object;
    const hidden =
      read(doc, "hidden") === true ||
      read(input, "hidden") === true ||
      read(doc, "visibilityState") === "hidden" ||
      read(input, "visibilityState") === "hidden";
    return hidden ? 1 : 0;
  }

  function scheduleIdle(): void {
    if (!attached || typeof setTimeout !== "function") return;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const timer = setTimeout(() => {
      idleTimer = null;
      if (!attached || idle) return;
      // Heuristica de document: un documento oculto no genera idle propio.
      if (read(doc, "hidden") === true) return;
      idle = true;
      emit(5, null);
    }, IDLE_MS);
    idleTimer = timer;
    // No mantener el proceso vivo solo por el temporizador de inactividad.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }

  function markActive(fromActivityEvent: boolean, event?: Event): void {
    const wasIdle = idle;
    idle = false;
    if (fromActivityEvent && wasIdle) emit(6, event ?? null);
    scheduleIdle();
  }

  const onVisibility = (event: Event): void => {
    const kind = visibilityKind(event);
    if (kind === 0) markActive(false);
    else idle = false;
    emit(kind, event);
  };
  const onFocus = (event: Event): void => {
    markActive(false);
    emit(2, event);
  };
  const onBlur = (event: Event): void => {
    idle = false;
    emit(3, event);
  };
  const onResize = (event: Event): void => {
    // Un resize implica actividad real del documento.
    markActive(true, event);
    emit(4, event);
  };
  const onActivity = (event: Event): void => markActive(true, event);
  const onIdle = (event: Event): void => {
    idle = true;
    emit(5, event);
  };
  const onActive = (event: Event): void => {
    markActive(false);
    emit(6, event);
  };

  function attach(): void {
    if (attached) return;
    attached = true;
    doc = resolveDocument();
    try {
      target.addEventListener("visibilitychange", onVisibility, LISTENER_OPTIONS);
      target.addEventListener("focus", onFocus, LISTENER_OPTIONS);
      target.addEventListener("blur", onBlur, LISTENER_OPTIONS);
      target.addEventListener("resize", onResize, LISTENER_OPTIONS);
      // Heuristica de inactividad instalada en runtime: cualquier actividad
      // reinicia el temporizador; los eventos explicitos idle/active permiten
      // alimentar la senal desde un detector de inactividad del host.
      target.addEventListener("idle", onIdle, LISTENER_OPTIONS);
      target.addEventListener("active", onActive, LISTENER_OPTIONS);
      target.addEventListener("pointermove", onActivity, LISTENER_OPTIONS);
      target.addEventListener("pointerdown", onActivity, LISTENER_OPTIONS);
      target.addEventListener("keydown", onActivity, LISTENER_OPTIONS);
    } catch {
      detach();
    }
    scheduleIdle();
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    idle = false;
    doc = null;
    for (const [type, listener] of [
      ["visibilitychange", onVisibility],
      ["focus", onFocus],
      ["blur", onBlur],
      ["resize", onResize],
      ["idle", onIdle],
      ["active", onActive],
      ["pointermove", onActivity],
      ["pointerdown", onActivity],
      ["keydown", onActivity],
    ] as Array<[string, EventListener]>) {
      try {
        target.removeEventListener(type, listener, LISTENER_OPTIONS);
      } catch {
        // target hostil: se sigue limpiando el resto.
      }
    }
  }

  return {
    attach,
    detach,
    getSamples: () => ring.snapshot(),
    clear(): void {
      ring.clear();
      eventTimes.length = 0;
      lastEventAt = 0;
    },
    eventsSince(cutoff: number): number {
      if (typeof cutoff !== "number" || !Number.isFinite(cutoff)) return 0;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
      return eventTimes.length;
    },
    get lastEventAt(): number {
      return lastEventAt;
    },
  };
}
