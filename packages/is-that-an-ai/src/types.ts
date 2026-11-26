// Tipos públicos de la librería. Solo definiciones, sin lógica.

import type { Locale } from "./i18n/locales";

/** Señales de comportamiento que se analizarán. */
export type Signal = "mouse" | "keyboard" | "click" | "scroll" | "touch" | "attention";

/**
 * Perfil de dispositivo. `auto` infiere de los datos numéricos disponibles;
 * los demás fuerzan el tratamiento del teclado/score correspondiente.
 * - `desktop`: teclado y puntero convencionales.
 * - `touch`: se reconocen muestras con `pointerType !== 0`; la ausencia de
 *   mouse es neutra (no puntúa ni a humano ni a IA). Sin scoring nuevo.
 * - `tv`: mando a distancia (D-pad/Enter/Escape); las medidas de ritmo de
 *   teclado se neutralizan para cadencias de mando normales.
 */
export type DeviceProfile = "auto" | "desktop" | "touch" | "tv";

/**
 * Perfil de dispositivo detallado (Etapa 9). Es informativo: NUNCA sustituye al
 * `DeviceProfile` grueso que gobierna el scoring/teclado. `computadora`/`laptop`
 * se mapean a `desktop`, `celular`/`tablet` a `touch` y `tv` a `tv`.
 * - `touch`: puntero no-mouse sin señales para distinguir celular de tablet.
 */
export type DetailedDevice = "computadora" | "laptop" | "celular" | "tablet" | "tv" | "touch";

/**
 * Nivel de sensibilidad (Etapa 9). `estricto` baja los umbrales y acorta las
 * confirmaciones (más fácil declarar IA y más rápido); `relajado` los sube y
 * las alarga (más tolerancia con humanos). `normal` reproduce los defaults
 * históricos exactamente.
 */
export type Sensitivity = "estricto" | "normal" | "relajado";

/** Configuración de la instancia. */
export interface Options {
  signals?: Signal[];
  onVerdict?: VerdictCallback;
  /** Aviso solo cuando el estado confirmado cambia entre humano e IA. */
  onChange?: ChangeCallback;
  /**
   * Idioma de las razones. `auto` (default) se resuelve con `detectLocale()`
   * en `start()`, nunca al importar ni en el constructor (SSR-safe).
   */
  locale?: Locale | "auto";
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
  /** Muestras táctiles conservadas (no enumerable, ver `getStats`). */
  touchCount?: number;
  /** Muestras de atención conservadas (no enumerable, ver `getStats`). */
  attentionCount?: number;
}

/**
 * Configuración de la instancia con los ajustes del colector de puntero.
 * En runtime se normaliza una copia: los objetos del llamador nunca se conservan
 * por referencia y los valores no finitos/fuera de rango vuelven al default.
 */
export interface DetectorOptions extends Options {
  mouse?: {
    bufferSize?: number;
    maxAgeMs?: number;
  };
  click?: { bufferSize?: number };
  scroll?: { bufferSize?: number };
  keyboard?: { bufferSize?: number };
  input?: { bufferSize?: number };
  /**
   * Colector táctil. Su sola presencia habilita el colector (los defaults no
   * registran listeners nuevos, para conservar el comportamiento histórico
   * bit a bit). `bufferSize` acota el buffer en memoria.
   */
  touch?: { bufferSize?: number };
  /**
   * Colector de atención (pestaña/foco/actividad). Su sola presencia lo habilita;
   * `bufferSize` acota el buffer en memoria.
   */
  attention?: { bufferSize?: number };
  /** Perfil de dispositivo; `auto` (default) lo infiere de las muestras. */
  device?: DeviceProfile;
  /**
   * Sensibilidad (default `normal`). Ajusta umbrales y tiempos de confirmación;
   * un `configure()` posterior con valores explícitos tiene prioridad.
   */
  sensitivity?: Sensitivity;
  /**
   * Modo accesibilidad (default `false`). `true` ignora el mouse/clic sin
   * evidencia real de puntero y nunca trata la ausencia de mouse como señal;
   * `auto` lo activa cuando el perfil detallado es táctil/TV.
   */
  accessibility?: boolean | "auto";
  /**
   * Fuerza un perfil detallado (default `auto`, inferido en `start()`). No
   * altera el `device` grueso ni el scoring existente.
   */
  detailedDevice?: DetailedDevice | "auto";
  /**
   * Etapa 10: activa las guardarraíles anti-trampas (default `true`). Solo
   * añaden EVIDENCIA DE RIESGO aditiva; nunca bajan el score calibrado ni
   * cambian un veredicto limpio. No se expone en `getConfig()`.
   */
  antiCheat?: boolean;
  /**
   * Etapa 10: randomización determinista de pesos por sesión (default `true`).
   * Se aplica solo pasados N eventos de evaluación para no alterar los scores
   * calibrados de sesiones cortas. No se expone en `getConfig()`.
   */
  antiCheatWeightJitter?: boolean;
  /** Reloj inyectable (default: performance.now o Date.now). Para tests. */
  now?: () => number;
  /**
   * Etapa 11: modo debug (default `false`). Con `true`, `evaluate()` escribe
   * información concise de estado/score en `console.debug`. NUNCA se registra
   * nada al importar ni en el constructor.
   */
  debug?: boolean;
  /**
   * Etapa 11: eventos personalizados (default `false`). Con `true` y `document`
   * disponible, cada cambio de estado despacha `CustomEvent("isthatanai")` con
   * una copia del veredicto en `detail`. Solo en runtime (SSR-safe).
   */
  customEvent?: boolean;
  /**
   * Etapa 11: bandera DECLARATIVA de arranque automático (default `false`).
   * El constructor jamás toca el DOM (regla SSR), así que NO inicia nada por sí
   * mismo: el arranque real lo ejecuta el helper `autoStart()` de
   * `src/auto-start.ts`, que es el único punto que comprueba `document`.
   */
  autoStart?: boolean;
  /**
   * Modo "solo agregados" (default `false`). Se activa también con "No rastrear"
   * detectado en `start()`. No cambia la máquina de estados: solo suaviza la
   * forma pública de `getStats()`/`getSignalScores()` (ver `getPrivacyMode()`).
   */
  aggregatesOnly?: boolean;
  /**
   * OPT-IN: habilita las medidas finales de todas las señales con pesos SMALL
   * y acotados (share máximo ~0.15 del score combinado). Default `false` para
   * NO alterar la calibración ya validada; actívalo solo si aceptas recalibrar.
   */
  advancedMeasures?: boolean;
  // `locale` se hereda de Options: `auto` (default) se detecta en start().
}

/** Modo de privacidad efectivo de la sesión. */
export type PrivacyMode = "full" | "aggregates";

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

/**
 * Etapa 11 — callback de cruce de umbral. Recibe el score combinado vigente
 * (`null` cuando no hay evidencia suficiente), en AMBAS direcciones del cruce.
 */
export type ThresholdCallback = (score: number | null) => void;

/** Contrato que implementa cada colector. */
export interface Collector {
  attach(): void;
  detach(): void;
}

// ---------------------------------------------------------------------------
// Configuración en tiempo de ejecución (configure) y desglose aditivo.
// Todos los campos son opcionales: `configure` hace merge con los defaults,
// que reproducen exactamente el comportamiento previo.
// ---------------------------------------------------------------------------

/** Señales que participan en la combinación del puntaje. */
export type ScoredSignal = "mouse" | "click" | "scroll" | "keyboard";

/** Pesos de combinación entre señales (no hace falta que sumen 1). */
export type SignalWeights = Record<ScoredSignal, number>;

/** Bandas de decisión configurables (score <= humanMax, score >= aiMin). */
export interface Thresholds {
  humanMax: number;
  aiMin: number;
}

/** Tiempos de confirmación de histeresis, en ms de `event.timeStamp`. */
export interface ConfirmTimes {
  human: number;
  ai: number;
}

/**
 * `weighted` usa los pesos documentados (comportamiento previo). `adaptive`
 * da más peso a las señales difíciles de falsificar (teclado y mouse).
 */
export type CombinationMode = "weighted" | "adaptive";

/**
 * Configuración de runtime; todo es opcional y se fusiona con los defaults.
 * Fail closed: las propiedades heredadas, los valores no finitos/fuera de rango
 * y las bandas solapadas (humanMax >= aiMin) se ignoran y no pueden convertir
 * `measuring` en `human`.
 */
export interface DetectorConfig {
  thresholds?: Partial<Thresholds>;
  signalWeights?: Partial<SignalWeights>;
  device?: DeviceProfile;
  combination?: CombinationMode;
  /** Atenúa el score en perfiles `tv`/`touch` (mismo perfil ya inferido). */
  accessibilityProtection?: boolean;
  confirmMs?: Partial<ConfirmTimes>;
  emaAlpha?: number;
  /**
   * Idioma de las razones. `auto` se resuelve en el próximo `start()`.
   * No se expone en `getConfig()` para no alterar la forma pública existente.
   */
  locale?: Locale | "auto";
  /**
   * Sensibilidad: aplica un preset de umbrales/confirmación. Los campos
   * `thresholds`/`confirmMs` explícitos en la MISMA llamada ganan al preset.
   * No se expone en `getConfig()`; se lee con `getSensitivity()`.
   */
  sensitivity?: Sensitivity;
  /**
   * Modo accesibilidad (`false`, `true` o `auto`). No se expone en
   * `getConfig()`; se lee con `getAccessibility()`.
   */
  accessibility?: boolean | "auto";
  /**
   * Fuerza el perfil detallado. No se expone en `getConfig()`; se lee con
   * `getDetailedDevice()`.
   */
  detailedDevice?: DetailedDevice | "auto";
  /**
   * Etapa 10: activa las guardarraíles anti-trampas (default `true`). Solo
   * produce evidencia de riesgo aditiva, nunca modifica el score calibrado.
   * No se expone en `getConfig()`; se lee con `getAntiCheat()`.
   */
  antiCheat?: boolean;
  /**
   * Etapa 10: randomización determinista de pesos por sesión (default `true`).
   * Solo se aplica tras un umbral de evaluaciones. No se expone en
   * `getConfig()`; se lee con `getAntiCheatWeightJitter()`.
   */
  antiCheatWeightJitter?: boolean;
  /**
   * Activa las medidas finales (opt-in, default `false`). Nunca se expone en
   * `getConfig()` para no alterar la forma pública existente.
   */
  advancedMeasures?: boolean;
}

/** Callback de cambio confirmado `humano` ↔ `IA`. Nunca recibe `measuring`. */
export type ChangeCallback = (state: "human" | "ai") => void;

/** Cambio de controlador detectado dentro de una misma sesión. */
export interface HandoverInfo {
  from: "human" | "ai";
  to: "human" | "ai";
  score: number;
  /** Última marca de tiempo de muestra en que se confirmó el cambio. */
  at: number;
  /** Número de cambios de controlador vistos en la sesión. */
  count: number;
}

/** Información del suavizado EMA expuesta en el desglose. */
export interface EmaInfo {
  alpha: number;
  previous: number | null;
  current: number | null;
}

/**
 * Etapa 10 — evidencia de riesgo de las guardarraíles anti-trampas.
 * Todos los valores están en [0,1] (1 = más sospechoso) y 0 significa
 * "no aparece el patrón", NUNCA "humano". Es ADITIVA: no altera el score
 * calibrado ni el veredicto por sí sola.
 */
export interface GuardrailRiskEvidence {
  /** Coherencia entre señales (mezcla de personalidades, eventos huérfanos). */
  coherence: number;
  /** Eventos inyectados / creados por código (confianza y precisión temporal). */
  injection: number;
  /** Humanización falsa (ciclo de jitter corto o ruido uniforme). */
  humanization: number;
  /** Ritmo generado por fórmula (módulo de ruido de la Etapa 10). */
  formulaRhythm: number;
  /** Discrepancia entre dispositivo declarado y comportamiento observado. */
  declaredVsBehavior: number;
  /** Trayectoria idéntica repetida dentro de la sesión actual. */
  replay: number;
  /** Fallos de las comprobaciones sorpresa de coherencia. */
  surprise: number;
  /** Unión probabilística de todas las medidas anteriores. */
  overall: number;
  /**
   * Medidas detalladas de coherencia (L137-L144). Campo ADITIVO y opcional:
   * no entra en `overall` ni en el score. Puede ser no enumerable en runtime.
   */
  coherenceDetailed?: Readonly<Record<string, number>> | null;
  /**
   * Señales del entorno (L148-L154). ADITIVO: nunca decide ni puntúa.
   */
  environment?: Readonly<Record<string, number>> | null;
}

/**
 * Desglose ADITIVO: nunca se añaden campos a `Verdict` ni a `SignalScores`
 * (sus formas están fijadas por comparaciones `toEqual`). Es un objeto nuevo
 * construido en cada llamada.
 */
export interface ScoreBreakdown {
  /** Copia de los últimos scores por señal (misma forma que `getSignalScores`). */
  scores: SignalScores;
  /** Pesos configurados (raw). */
  weights: SignalWeights;
  /** Pesos efectivos tras aplicar el modo de combinación. */
  effectiveWeights: SignalWeights;
  /** Bandas de decisión vigentes. */
  thresholds: Thresholds;
  combination: CombinationMode;
  ema: EmaInfo;
  handover: HandoverInfo | null;
  handoverCount: number;
  accessibility: { enabled: boolean; device: DeviceProfile; applied: boolean };
  /** Razones actuales más, si aplica, la del cambio de controlador. */
  reasons: string[];
  /**
   * Etapa 10: evidencia de riesgo aditiva. NUNCA modifica `score` ni `state`:
   * es información para el consumidor, no un veredicto encubierto.
   */
  riskEvidence: GuardrailRiskEvidence;
  /** Etapa 10: notas aditivas (sorpresa, integridad, replay, jitter). */
  notes: string[];
  /** Modo de privacidad vigente (campo aditivo no enumerable). */
  privacyMode?: PrivacyMode;
  /** `true` si las medidas finales opt-in se aplicaron (no enumerable). */
  advancedMeasuresApplied?: boolean;
  /** Tolerancias de guardarraíl tras recalibración (no enumerable). */
  guardrailTolerances?: Readonly<Record<string, number>>;
}
