// Colector de mutaciones de texto. Solo metadata numérica: NUNCA se guarda
// `data`, `clipboardData` ni ningún carácter; `inputType` se mapea a un código
// 0..5 dentro del listener. Se usa `beforeinput` y, si el target no lo soporta
// (o no lo dispara), `input` como fallback.Listeners pasivos y registrados solo
// en attach(). Sin DOM al importar.

import type { Collector, InputSample, InputTypeCode } from "../types";
import { NumericRingBuffer } from "../utils/numeric-ring-buffer";
import { isSensitiveTarget } from "../utils/privacy";

/** Forma mínima y opcional de un InputEvent (sirve para targets falsos). */
interface InputLike {
  inputType?: unknown;
  isComposing?: unknown;
  timeStamp?: number;
  isTrusted?: boolean;
}

export interface TextInputCollectorOptions {
  /** Por defecto `document`, resuelto solo al llamar a la fábrica. */
  target?: EventTarget;
  /** Por defecto `performance.now`, resuelto solo al llamar a la fábrica. */
  now?: () => number;
  bufferSize?: number;
}

export interface TextInputCollector extends Collector {
  readonly buffer: NumericRingBuffer;
  readonly lastEventAt: number;
  /** true cuando se ha visto al menos un `beforeinput` y `input` se ignora. */
  readonly usesBeforeInput: boolean;
  getSamples(): InputSample[];
  discardOldestBefore(tMin: number): number;
  eventsSince(cutoff: number): number;
  clear(): void;
}

const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };

const SEQ = 0;
const T = 1;
const INPUT_TYPE = 3;
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

/** Mapeo documentado de `inputType` a un código numérico. */
export function inputTypeCodeOf(input: InputLike): InputTypeCode {
  const typeValue = read(input, "inputType");
  const type = typeof typeValue === "string" ? typeValue : "";
  if (read(input, "isComposing") === true) return 3;
  switch (type) {
    case "insertText":
      return 0;
    case "insertFromPaste":
      return 1;
    case "insertFromDrop":
      return 2;
    case "insertReplacementText":
    case "insertCompositionText":
    case "insertFromComposition":
      return 3;
    case "deleteContentBackward":
    case "deleteByCut":
      return 4;
    default:
      return 5;
  }
}

function toSample(row: Float64Array): InputSample {
  return {
    seq: row[SEQ],
    t: row[T],
    kind: 0,
    inputType: row[INPUT_TYPE] as InputTypeCode,
    trusted: row[TRUSTED] as 0 | 1,
  };
}

export function createTextInputCollector({
  target = document,
  now = performance.now,
  bufferSize = 1024,
}: TextInputCollectorOptions = {}): TextInputCollector {
  const buffer = new NumericRingBuffer(bufferSize, FIELDS);
  let attached = false;
  let seq = 0;
  let lastEventAt = 0;
  let usesBeforeInput = false;
  const eventTimes: number[] = [];

  function clock(): number | null {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Devuelve true solo si la mutación se guardó realmente. */
  function record(event: Event): boolean {
    if (!attached) return false;
    // Contraseñas: se ignora el evento SIN leer su valor ni su texto. Un target
    // hostil se clasifica como sensible (fail-closed), sin lanzar.
    if (isSensitiveTarget(event)) return false;
    const input = event as unknown as object;
    const t = numeric(input, "timeStamp", 0);
    const inputType = inputTypeCodeOf(input as InputLike);
    const trusted = trustedOf(input);

    seq += 1;
    buffer.push(seq, t, 0, inputType, trusted);
    lastEventAt = t;
    // Un evento = una marca del reloj inyectado (solo cuentas, sin contenido).
    const at = clock();
    if (at !== null) {
      eventTimes.push(at);
      const cutoff = at - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
    }
    return true;
  }

  const onBeforeInput = (event: Event): void => {
    // Solo se activa el modo beforeinput si el evento se guardó. Un beforeinput
    // de contraseña (descartado) no debe silenciar `input` eventos reales.
    if (record(event)) usesBeforeInput = true;
  };
  const onInput = (event: Event): void => {
    // Evita contar dos veces la misma mutación en navegadores que disparan
    // beforeinput y a continuación input.
    if (usesBeforeInput) return;
    record(event);
  };

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      target.addEventListener("beforeinput", onBeforeInput, LISTENER_OPTIONS);
      target.addEventListener("input", onInput, LISTENER_OPTIONS);
    } catch {
      detach();
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      target.removeEventListener("beforeinput", onBeforeInput, LISTENER_OPTIONS);
      target.removeEventListener("input", onInput, LISTENER_OPTIONS);
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
      usesBeforeInput = false;
    },
    get lastEventAt(): number {
      return lastEventAt;
    },
    get usesBeforeInput(): boolean {
      return usesBeforeInput;
    },
  };
}
