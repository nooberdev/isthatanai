// Colector de teclado. Solo metadata numérica: NUNCA se guardan event.key,
// event.code ni texto. La cadena del evento se clasifica dentro del listener y
// se descarta de inmediato; en el buffer solo queda una categoría 0..7.
// Los listeners se registran únicamente en attach() y son pasivos.
// Sin window/document/navigator al importar.

import type { Collector, KeyCategory, KeySample } from "../types";
import { NumericRingBuffer } from "../utils/numeric-ring-buffer";
import { isSensitiveTarget } from "../utils/privacy";

/** Forma mínima y opcional de un KeyboardEvent (sirve para targets falsos). */
interface KeyboardLike {
  code?: unknown;
  key?: unknown;
  timeStamp?: number;
  isTrusted?: boolean;
}

export interface KeyboardCollectorOptions {
  /** Por defecto `window`, resuelto solo al llamar a la fábrica. */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la fábrica. */
  now?: () => number;
  bufferSize?: number;
}

export interface KeyboardCollector extends Collector {
  readonly buffer: NumericRingBuffer;
  readonly lastEventAt: number;
  getSamples(): KeySample[];
  discardOldestBefore(tMin: number): number;
  eventsSince(cutoff: number): number;
  clear(): void;
}

const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };

const SEQ = 0;
const T = 1;
const KIND = 2;
const CATEGORY = 3;
const TRUSTED = 4;
const FIELDS = 5;

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

/**
 * Clasificación burda y sin estado. `code` (físico) tiene prioridad; `key` es
 * solo fallback. Ambas cadenas se usan AQUÍ y nunca se conservan.
 */
export function keyCategoryOf(input: KeyboardLike): KeyCategory {
  const codeValue = read(input, "code");
  const keyValue = read(input, "key");
  const code = typeof codeValue === "string" ? codeValue : "";
  const key = typeof keyValue === "string" ? keyValue : "";

  if (
    /^(Control|Meta|Alt|Shift)(Left|Right)$/.test(code) ||
    key === "Control" ||
    key === "Meta" ||
    key === "Alt" ||
    key === "AltGraph" ||
    key === "Shift"
  ) {
    return 6;
  }
  if (/^Key[A-Z]$/.test(code) || /^[a-zA-Z]$/.test(key)) return 0;
  if (/^(Digit|Numpad)[0-9]$/.test(code) || /^[0-9]$/.test(key)) return 1;
  if (code === "Space" || key === " ") return 2;
  if (code === "Backspace" || key === "Backspace") return 3;
  if (code === "Enter" || key === "Enter") return 4;
  if (
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  ) {
    return 5;
  }
  return 7;
}

function toSample(row: Float64Array): KeySample {
  return {
    seq: row[SEQ],
    t: row[T],
    kind: row[KIND] as 0 | 1,
    category: row[CATEGORY] as KeyCategory,
    trusted: row[TRUSTED] as 0 | 1,
  };
}

export function createKeyboardCollector({
  target = window,
  now = performance.now,
  bufferSize = 2048,
}: KeyboardCollectorOptions = {}): KeyboardCollector {
  const buffer = new NumericRingBuffer(bufferSize, FIELDS);
  let attached = false;
  let seq = 0;
  let lastEventAt = 0;
  // El reloj inyectado se usa solo para métricas de ventana; la muestra guarda
  // event.timeStamp, igual que los colectores de puntero/click/scroll.
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
    // Contraseñas: se ignora el evento SIN leer su valor. Un target hostil se
    // clasifica como sensible (fail-closed) y tampoco derriba el listener.
    if (isSensitiveTarget(event)) return;
    const input = event as unknown as object;
    const t = numeric(input, "timeStamp", 0);
    const category = keyCategoryOf(input as KeyboardLike);
    const trusted = trustedOf(input);

    seq += 1;
    buffer.push(seq, t, kind, category, trusted);
    lastEventAt = t;

    const at = clock();
    if (at !== null) {
      eventTimes.push(at);
      const cutoff = at - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
    }
  }

  const onDown = (event: Event): void => record(event, 0);
  const onUp = (event: Event): void => record(event, 1);

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      target.addEventListener("keydown", onDown, LISTENER_OPTIONS);
      target.addEventListener("keyup", onUp, LISTENER_OPTIONS);
    } catch {
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("keydown", onDown, LISTENER_OPTIONS);
      target.removeEventListener("keyup", onUp, LISTENER_OPTIONS);
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
