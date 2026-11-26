// Tipos públicos de la librería. Solo definiciones, sin lógica.

/** Señales de comportamiento que se analizarán. */
export type Signal = "mouse" | "keyboard" | "click" | "scroll" | "touch" | "attention";

/** Configuración de la instancia. */
export interface Options {
  signals?: Signal[];
  onVerdict?: VerdictCallback;
}

/** Una muestra de comportamiento. Solo tiempos/magnitudes, nunca contenido. */
export interface Sample {
  signal: Signal;
  timestamp: number;
  value: number;
}

/** Resultado numérico del scoring (a implementar en una etapa posterior). */
export interface Score {
  value: number;
  confidence: number;
}

/** Tipo de muestra de puntero: 0 = movimiento, 1 = entró, 2 = salió. */
export type PointerKind = 0 | 1 | 2;

/** 0 = mouse, 1 = pen, 2 = touch, 3 = otro/desconocido. */
export type PointerTypeCode = 0 | 1 | 2 | 3;

/**
 * Muestra de puntero. Solo números: nunca guardamos el Event ni referencias al DOM.
 * x/y conservan los decimales originales.
 */
export interface PointerSample {
  seq: number;
  x: number;
  y: number;
  /**
   * event.timeStamp. Algunos navegadores redondean este valor (p. ej. a ms o a
   * múltiplos de 0.1 ms): no asumir precisión de microsegundos.
   */
  t: number;
  kind: PointerKind;
  pointerType: PointerTypeCode;
  trusted: 0 | 1;
}

/**
 * Muestra de clic. Solo números: `kind` 0 = pointerdown, 1 = pointerup.
 * x/y conservan los decimales; `t` es event.timeStamp; `trusted` es isTrusted.
 */
export interface ClickSample {
  seq: number;
  x: number;
  y: number;
  t: number;
  kind: 0 | 1;
  button: number;
  trusted: 0 | 1;
}

/**
 * Muestra de scroll. `dx`/`dy` están normalizados a píxeles;
 * `t` es event.timeStamp; `trusted` es isTrusted.
 * `source`: 0 = evento `wheel`; 1 = `scroll` real del documento (botón medio,
 * teclado, scrollTo de un bot). Campo nuevo, backwards-compatible para quien
 * solo lee las demás propiedades.
 */
export interface ScrollSample {
  seq: number;
  dx: number;
  dy: number;
  t: number;
  trusted: 0 | 1;
  source: 0 | 1;
}

/**
 * Categoría de tecla, derivada de `event.code`/`event.key` DENTRO del listener
 * y convertida de inmediato a un número. Nunca se guarda la cadena original.
 * 0 letra, 1 número, 2 espacio, 3 borrar, 4 Enter, 5 flechas,
 * 6 modificador (Ctrl/Cmd/Alt/Shift), 7 otra tecla imprimible.
 */
export type KeyCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Muestra de teclado: solo tiempos y una categoría numérica. `kind` 0 =
 * keydown, 1 = keyup. Nunca contiene `event.key`, `event.code` ni texto.
 */
export interface KeySample {
  seq: number;
  t: number;
  kind: 0 | 1;
  category: KeyCategory;
  trusted: 0 | 1;
}

/**
 * Tipo de mutación de texto mapeado desde `beforeinput.inputType`:
 * 0 insertText, 1 insertFromPaste, 2 insertFromDrop,
 * 3 insertReplacementText / IME / composición, 4 deleteContentBackward,
 * 5 otro.
 */
export type InputTypeCode = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Muestra de cambio de texto. Solo metadata: NUNCA se guarda `data`,
 * `clipboardData` ni ningún carácter. `kind` siempre 0 (beforeinput/input).
 */
export interface InputSample {
  seq: number;
  t: number;
  kind: 0;
  inputType: InputTypeCode;
  trusted: 0 | 1;
}

/** Score por señal: null cuando esa señal no tiene evidencia suficiente. */
export interface SignalScores {
  mouse: number | null;
  click: number | null;
  scroll: number | null;
  /**
   * Teclado (keydown/keyup + mutaciones de texto). Se expone como propiedad
   * no enumerable para no alterar la forma de los objetos que ya consumían
   * las tres señales anteriores.
   */
  keyboard: number | null;
}

/** Estadísticas del colector, derivadas solo de números almacenados. */
export interface CollectorStats {
  sampleCount: number;
  droppedCount: number;
  eventsPerSecond: number;
  bufferFill: number;
  trustedRatio: number;
  lastEventAt: number;
  /** Muestras de clic conservadas en el buffer del detector. */
  clickCount: number;
  /** Muestras de scroll conservadas en el buffer del detector. */
  scrollCount: number;
  /** Muestras de teclado conservadas (no enumerables, ver `getStats`). */
  keyCount: number;
  /** Mutaciones de texto conservadas (no enumerables, ver `getStats`). */
  inputCount: number;
}

/** Configuración de la instancia con los ajustes del colector de puntero. */
export interface DetectorOptions extends Options {
  mouse?: {
    bufferSize?: number;
    maxAgeMs?: number;
  };
  click?: { bufferSize?: number };
  scroll?: { bufferSize?: number };
  keyboard?: { bufferSize?: number };
  input?: { bufferSize?: number };
  /** Reloj inyectable (default: performance.now o Date.now). Para tests. */
  now?: () => number;
}

/**
 * Veredicto derivado de las muestras: estado, puntaje 0..1 (1 = más probable
 * IA, null si no hay evidencia suficiente), confianza 0..1, duda 0..1 y razones
 * en español. `doubt` crece cuanto más cerca está el score de la frontera de
 * decisión (0 = convincente, 1 = en el umbral); en "measuring" siempre es 1.
 */
export interface Verdict {
  state: "measuring" | "human" | "ai";
  score: number | null;
  confidence: number;
  doubt: number;
  reasons: string[];
}

export type VerdictCallback = (verdict: Verdict) => void;

/** Contrato que implementa cada colector. */
export interface Collector {
  attach(): void;
  detach(): void;
}
