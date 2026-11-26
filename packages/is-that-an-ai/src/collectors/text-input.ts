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
const KIND = 2;
const INPUT_TYPE = 3;
const TRUSTED = 4;
const FIELDS = 5;

function numeric(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Mapeo documentado de `inputType` a un código numérico. */
export function inputTypeCodeOf(input: InputLike): InputTypeCode {
  const type = typeof input.inputType === "string" ? input.inputType : "";
  if (input.isComposing === true) return 3;
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

  function record(event: Event): void {
    // Contraseñas: se ignora el evento SIN leer su valor ni su texto.
    if (isSensitiveTarget(event)) return;
    const input = event as unknown as InputLike;
    const t = numeric(input.timeStamp, 0);
    const inputType = inputTypeCodeOf(input);
    const trusted: 0 | 1 = input.isTrusted ? 1 : 0;

    seq += 1;
    buffer.push(seq, t, 0, inputType, trusted);
    lastEventAt = t;
    // Un evento = una marca del reloj inyectado (solo cuentas, sin contenido).
    const at = now();
    eventTimes.push(at);
    const cutoff = at - 1000;
    while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
  }

  const onBeforeInput = (event: Event): void => {
    usesBeforeInput = true;
    record(event);
  };
  const onInput = (event: Event): void => {
    // Evita contar dos veces la misma mutación en navegadores que disparan
    // beforeinput y a continuación input.
    if (usesBeforeInput) return;
    record(event);
  };

  function attach(): void {
    if (attached) return;
    target.addEventListener("beforeinput", onBeforeInput, LISTENER_OPTIONS);
    target.addEventListener("input", onInput, LISTENER_OPTIONS);
    attached = true;
  }

  function detach(): void {
    if (!attached) return;
    target.removeEventListener("beforeinput", onBeforeInput, LISTENER_OPTIONS);
    target.removeEventListener("input", onInput, LISTENER_OPTIONS);
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
