// Colector táctil. Solo metadata numérica: nunca se guarda el Event ni
// referencias al DOM. Los listeners se registran únicamente dentro de attach()
// (SSR-safe: no hay window/document/navigator a nivel de módulo).
//
// kind: 0 = contacto (pointerdown / pointermove), 1 = levantar dedo (pointerup).
// pointerType: 1 = pen, 2 = touch. Se IGNORAN mouse y tipos desconocidos:
// un "click falso" de mouse no se inventa aquí, solo se observa lo real.
// trusted: 1 solo si isTrusted === true de forma estricta.

import { clamp } from "../utils/math";

/** Muestra táctil: exclusivamente números, sin identidad de puntero ni texto. */
export interface TouchSample {
  seq: number;
  t: number;
  kind: 0 | 1;
  x: number;
  y: number;
  pointerType: number;
  pressure: number;
  radiusX: number;
  radiusY: number;
  rotationAngle: number;
  trusted: 0 | 1;
}

export interface TouchCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la función (nunca al importar). */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la función. */
  now?: () => number;
  bufferSize?: number;
}

export interface TouchCollector {
  attach(): void;
  detach(): void;
  getSamples(): TouchSample[];
  clear(): void;
  eventsSince(cutoff: number): number;
  readonly lastEventAt: number;
}

const DEFAULT_BUFFER_SIZE = 2048;
const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true, capture: true };

// Cotas muy por encima de cualquier valor real (pantalla < 1e6 px, reloj de
// página < 1e12 ms, radio de contacto < 1e3 px). Recortan entradas hostiles
// (NaN, ±Infinity, 1e308) sin alterar ninguna muestra normal.
const MAX_COORD = 1e9;
const MAX_TIME = 1e15;
const MAX_RADIUS = 1e6;

const SEQ = 0;
const T = 1;
const KIND = 2;
const X = 3;
const Y = 4;
const POINTER_TYPE = 5;
const PRESSURE = 6;
const RADIUS_X = 7;
const RADIUS_Y = 8;
const ROTATION = 9;
const TRUSTED = 10;
const FIELDS = 11;

/** Buffer circular privado: Float64Array, sin objetos por evento. */
class TouchRing {
  readonly capacity: number;
  private readonly data: Float64Array;
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
    this.data = new Float64Array(this.capacity * FIELDS);
  }

  push(
    seq: number,
    t: number,
    kind: number,
    x: number,
    y: number,
    pointerType: number,
    pressure: number,
    radiusX: number,
    radiusY: number,
    rotationAngle: number,
    trusted: number,
  ): void {
    const index = (this.start + this.count) % this.capacity;
    const base = index * FIELDS;
    this.data[base + SEQ] = seq;
    this.data[base + T] = t;
    this.data[base + KIND] = kind;
    this.data[base + X] = x;
    this.data[base + Y] = y;
    this.data[base + POINTER_TYPE] = pointerType;
    this.data[base + PRESSURE] = pressure;
    this.data[base + RADIUS_X] = radiusX;
    this.data[base + RADIUS_Y] = radiusY;
    this.data[base + ROTATION] = rotationAngle;
    this.data[base + TRUSTED] = trusted;
    if (this.count === this.capacity) this.start = (this.start + 1) % this.capacity;
    else this.count += 1;
  }

  snapshot(): TouchSample[] {
    const result: TouchSample[] = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const base = ((this.start + i) % this.capacity) * FIELDS;
      result[i] = {
        seq: this.data[base + SEQ],
        t: this.data[base + T],
        kind: this.data[base + KIND] as 0 | 1,
        x: this.data[base + X],
        y: this.data[base + Y],
        pointerType: this.data[base + POINTER_TYPE],
        pressure: this.data[base + PRESSURE],
        radiusX: this.data[base + RADIUS_X],
        radiusY: this.data[base + RADIUS_Y],
        rotationAngle: this.data[base + ROTATION],
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
function read(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function numeric(object: object, key: string, fallback: number, limit: number): number {
  const value = read(object, key);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, -limit, limit);
}

/** Solo `true` estricto cuenta como confiable: 1, "true" o getter hostil no. */
function trustedOf(object: object): 0 | 1 {
  return read(object, "isTrusted") === true ? 1 : 0;
}

/** Codigo numerico de puntero. null = evento no tactil (se descarta). */
function pointerTypeOf(value: unknown): number | null {
  if (value === "touch") return 2;
  if (value === "pen") return 1;
  return null;
}

export function createTouchCollector({
  target = window,
  now = performance.now,
  bufferSize = DEFAULT_BUFFER_SIZE,
}: TouchCollectorOptions = {}): TouchCollector {
  const ring = new TouchRing(bufferSize);
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
    try {
      const input = event as unknown as object;
      const pointerType = pointerTypeOf(read(input, "pointerType"));
      if (pointerType === null) return;

      const x = numeric(input, "clientX", 0, MAX_COORD);
      const y = numeric(input, "clientY", 0, MAX_COORD);
      // timeStamp es monotono y no negativo en la practica; una entrada
      // hostil/negativa se recorta a 0 para no contaminar duraciones.
      const t = Math.max(0, numeric(input, "timeStamp", 0, MAX_TIME));
      const pressure = clamp(numeric(input, "pressure", 0, 1), 0, 1);
      const radiusX = clamp(numeric(input, "radiusX", 0, MAX_RADIUS), 0, MAX_RADIUS);
      const radiusY = clamp(numeric(input, "radiusY", 0, MAX_RADIUS), 0, MAX_RADIUS);
      const rotationAngle = clamp(numeric(input, "rotationAngle", 0, 360), 0, 360);
      const trusted = trustedOf(input);

      seq += 1;
      ring.push(
        seq,
        t,
        kind,
        x,
        y,
        pointerType,
        pressure,
        radiusX,
        radiusY,
        rotationAngle,
        trusted,
      );
      lastEventAt = t;

      // Un evento = una marca de reloj, sin importar cuantos campos se guardaron.
      const at = clock();
      if (at !== null) {
        eventTimes.push(at);
        const cutoff = at - 1000;
        while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
      }
    } catch {
      // Evento hostil: NUNCA se propaga una excepcion fuera del listener.
    }
  }

  const onDown = (event: Event): void => record(event, 0);
  const onMove = (event: Event): void => record(event, 0);
  const onUp = (event: Event): void => record(event, 1);

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      target.addEventListener("pointerdown", onDown, LISTENER_OPTIONS);
      target.addEventListener("pointermove", onMove, LISTENER_OPTIONS);
      target.addEventListener("pointerup", onUp, LISTENER_OPTIONS);
    } catch {
      // Registro parcial: fail-closed, se desmonta lo que se hubiera anadido.
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("pointerdown", onDown, LISTENER_OPTIONS);
    } catch {
      // target hostil: no se puede hacer mas.
    }
    try {
      target.removeEventListener("pointermove", onMove, LISTENER_OPTIONS);
    } catch {
      // target hostil: no se puede hacer mas.
    }
    try {
      target.removeEventListener("pointerup", onUp, LISTENER_OPTIONS);
    } catch {
      // target hostil: no se puede hacer mas.
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
