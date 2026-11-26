// Perfil de tecleo humano derivado de una sesión real de calibración.
// SOLO estadísticas de tiempos y conteos: ni teclas, ni texto, ni red, ni storage.
// Es dato estático importado en módulo: no toca window/document/navigator.

/** Estadística de una distribución de intervalos/duraciones, en milisegundos. */
export interface TypingDistribution {
  n: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
  sd: number;
  cv: number;
}

/** Huella de una sesión humana: ritmo, pausas, correcciones y resultado declarado. */
export interface HumanTypingBaseline {
  label: string;
  source: string;
  recordedAt: string;
  durationMs: number;
  wpm: number;
  accuracy: number;
  typedChars: number;
  counts: {
    keyDowns: number;
    typedInputs: number;
    pasteInputs: number;
  };
  interKeyDownMs: TypingDistribution;
  interInputMs: TypingDistribution;
  keyHoldMs: TypingDistribution;
  longPausesMs: number[];
}

/**
 * Sesión etiquetada "humano", grabada con el calibrador del demo el
 * 2026-11-26. 45.44 WPM, 96.07% de precisión, 27 keydowns, 23 inserciones
 * escritas y un único pegado. Las pausas de 1000ms / 6813ms (teclas) y
 * 8378ms (inputs) son la señal humana que el detector ignoraba.
 */
export const HUMAN_TYPING_BASELINE: HumanTypingBaseline = {
  label: "humano",
  source: "calibracion-teclado(1).json",
  recordedAt: "2026-11-26T07:52:03.404Z",
  durationMs: 36394,
  wpm: 45.44,
  accuracy: 0.9607,
  typedChars: 178,
  counts: { keyDowns: 27, typedInputs: 23, pasteInputs: 1 },
  interKeyDownMs: {
    n: 24,
    min: 62,
    p10: 94,
    p50: 189,
    p90: 266,
    max: 499,
    mean: 199.9,
    sd: 95.3,
    cv: 0.48,
  },
  interInputMs: {
    n: 22,
    min: 65,
    p10: 88,
    p50: 188,
    p90: 251,
    max: 509,
    mean: 192.9,
    sd: 96.7,
    cv: 0.5,
  },
  keyHoldMs: {
    n: 21,
    min: 16,
    p10: 46,
    p50: 94,
    p90: 125,
    max: 142,
    mean: 87.2,
    sd: 34.7,
    cv: 0.4,
  },
  longPausesMs: [1000, 6813, 8378],
};

// Defensa: el perfil es dato de configuración de umbrales. Si un script de la
// página pudiera mutarlo, podría cambiar el comportamiento del detector sin
// pasar por `configure()`. Se congela en profundidad al importar.
Object.freeze(HUMAN_TYPING_BASELINE.counts);
Object.freeze(HUMAN_TYPING_BASELINE.interKeyDownMs);
Object.freeze(HUMAN_TYPING_BASELINE.interInputMs);
Object.freeze(HUMAN_TYPING_BASELINE.keyHoldMs);
Object.freeze(HUMAN_TYPING_BASELINE.longPausesMs);
Object.freeze(HUMAN_TYPING_BASELINE);

/**
 * Pausa larga calibrada: a partir de aquí el humano se detuvo de verdad.
 * Una sola pausa de este orden basta para no acusar "sin pausas".
 */
export const HUMAN_PAUSE_MS = 1000;

/**
 * Diversidad de intervalos en la sesión humana: 20 valores distintos de 26
 * (el 250ms se repite 4 veces). Un bot con `setInterval` o con un ciclo corto
 * de delays concentra casi todos los intervalos en muy pocos valores.
 */
export const HUMAN_UNIQUE_INTERVAL_SHARE = 20 / 26;

/** Por debajo de esta diversidad el patrón es de máquina (ciclo corto). */
export const EXACT_RHYTHM_UNIQUE_LOW = 0.2;
/** A partir de este share (humano calibrado menos un margen), no hay patrón. */
export const EXACT_RHYTHM_UNIQUE_HIGH = HUMAN_UNIQUE_INTERVAL_SHARE * 0.85;
