// Combina las medidas de mouse en un puntaje 0..1 (1 = más probable IA)
// y añade suavizado EMA, confianza y razones legibles.
//
// Evidencia mínima antes de dar score: al menos MIN_SEGMENTS segmentos
// (run de kind 0) o MIN_SEGMENTS muestras de movimiento, y >= MIN_WINDOW_MS ms
// de duración de la ventana (el span t de los samples en el buffer).
// Sin evidencia: score null.
//
// Suavizado EMA entre evaluaciones: smoothed = alpha * raw + (1 - alpha) * prev.
//
// Confianza: promedio de saturación: min(muestras / 25, 1) y min(ventanaMs / 2000, 1).

import { evaluateCoherence } from "../core/coherence";
import { declaredVsBehavior, humanizationRisk, injectionRisk } from "../core/injection";
import { formulaRhythm, noiseHumanity } from "../core/noise";
import * as attentionFeatureModule from "../features/attention";
// Namespace imports: las tablas medidas-finales las entregan otras lanes con
// nombres que pueden variar. Se leen por nombre en runtime (defensivo) y se
// ignoran si falta una tabla o si todos sus pesos son 0.
import * as clickFeatureModule from "../features/click";
import {
  type ClickFeatures,
  clickReasons,
  computeClickScore,
  extractClickFeatures,
} from "../features/click";
import * as keyboardFeatureModule from "../features/keyboard";
import {
  computeKeyboardScore,
  countKeyDowns,
  extractKeyboardFeatures,
  hasKeyboardEvidence,
  type KeyboardFeatures,
  keyboardFeaturesForDevice,
  keyboardReasons,
  keyboardWindowMs,
} from "../features/keyboard";
import * as mouseFeatureModule from "../features/mouse";
import { countSegments, extractMouseFeatures, type MouseFeatures } from "../features/mouse";
import * as scrollFeatureModule from "../features/scroll";
import {
  computeScrollScore,
  extractScrollFeatures,
  type ScrollFeatures,
  scrollReasons,
  withoutAutoscroll,
} from "../features/scroll";
import * as touchFeatureModule from "../features/touch";
import type {
  ClickSample,
  CombinationMode,
  ConfirmTimes,
  DeviceProfile,
  EmaInfo,
  GuardrailRiskEvidence,
  InputSample,
  KeySample,
  PointerSample,
  ScoredSignal,
  ScrollSample,
  Sensitivity,
  SignalScores,
  SignalWeights,
  Thresholds,
  Verdict,
} from "../types";
import { clamp } from "../utils/math";
import { type FeatureWeights, weights } from "./weights";

/** Mínimo de segmentos (pasos kind-0) para emitir score. */
export const MIN_SEGMENTS = 10;

/** Mínima duración de la ventana en ms para emitir score (todas las señales). */
export const MIN_WINDOW_MS = 400;

/**
 * Evidencia mínima para las señales nuevas:
 * - clics: >= 10 eventos (5 pares down/up) y ventana >= MIN_WINDOW_MS.
 *   Con 2-3 clics las medidas son neutras y el score 0.5 generaba duda alta
 *   ("HUMANO?") sin evidencia real: ahora la señal es null y manda el mouse.
 * - scrolls: >= 8 eventos y ventana >= MIN_WINDOW_MS.
 * Por debajo de esos umbrales la señal se ignora (null) y el resultado es
 * exactamente el del scoring de mouse original.
 */
export const MIN_CLICKS = 10;
export const MIN_SCROLLS = 8;

/**
 * Pesos de combinación entre señales. Se normalizan entre las señales con
 * evidencia suficiente: con solo mouse el peso efectivo es 1 (idéntico al
 * comportamiento anterior). El teclado entra con peso moderado (0.15) y solo
 * cuando hay evidencia propia, así que no altera mouse/click/scroll solos.
 */
// Los valores exportados se congelan también en runtime: `as const` solo es
// compile-time y un script de la página podría mutarlos para alterar el scoring.
export const SIGNAL_WEIGHTS = Object.freeze({
  mouse: 0.6,
  click: 0.2,
  scroll: 0.2,
  keyboard: 0.15,
} as const);

/**
 * Bandas de decisión: score <= HUMAN_MAX -> human, >= AI_MIN -> ai. En la
 * franja intermedia se mantiene el estado anterior (o se decide human si se
 * venía de measuring). Sin evidencia -> measuring (score null).
 * Salir de "ai" es más fácil que entrar: basta con caer por debajo de AI_MIN.
 */
export const HUMAN_MAX = 0.25;
export const AI_MIN = 0.55;
/** Núcleo de cada clase: score <= HUMAN_CORE => duda 0 en humano. */
export const HUMAN_CORE = 0.15;
/** score >= AI_CORE => duda 0 en IA. */
export const AI_CORE = 0.85;
/** Ms de muestra (event.timeStamp) que el score debe sostenerse para cambiar. */
export const AI_CONFIRM_MS = 600;
export const HUMAN_CONFIRM_MS = 250;

/** Un preset de sensibilidad: bandas de decisión + histeresis, sin tocar scoring. */
export interface SensitivityPreset {
  readonly thresholds: Thresholds;
  readonly confirmMs: ConfirmTimes;
}

/**
 * Presets de sensibilidad (Etapa 9), congelados en runtime. `normal` son los
 * valores históricos exactos; `estricto` baja humanMax/aiMin y acorta las
 * confirmaciones; `relajado` los sube y las alarga. Ninguno altera el score
 * crudo ni los pesos, solo la clasificación.
 */
export const SENSITIVITY_PRESETS: Readonly<Record<Sensitivity, SensitivityPreset>> = Object.freeze({
  estricto: Object.freeze({
    thresholds: Object.freeze({ humanMax: 0.2, aiMin: 0.45 }),
    confirmMs: Object.freeze({ human: 150, ai: 350 }),
  }),
  normal: Object.freeze({
    thresholds: Object.freeze({ humanMax: HUMAN_MAX, aiMin: AI_MIN }),
    confirmMs: Object.freeze({ human: HUMAN_CONFIRM_MS, ai: AI_CONFIRM_MS }),
  }),
  relajado: Object.freeze({
    thresholds: Object.freeze({ humanMax: 0.35, aiMin: 0.65 }),
    confirmMs: Object.freeze({ human: 400, ai: 900 }),
  }),
});

/** Nombres válidos de sensibilidad, en orden estable. */
export const SENSITIVITIES: readonly Sensitivity[] = Object.freeze([
  "estricto",
  "normal",
  "relajado",
]);

/** Factor de suavizado EMA (0 = passthrough, 1 = gelado). */
export const EMA_ALPHA = 0.35;

/** Orden estable de combinación: el mismo que `SIGNAL_WEIGHTS`. */
export const SCORED_SIGNALS: readonly ScoredSignal[] = Object.freeze([
  "mouse",
  "click",
  "scroll",
  "keyboard",
]);

/**
 * Etapa 10 — semilla "sin jitter". Es el valor por defecto del `ScoreComputer`
 * y garantiza que `getEffectiveWeights()` sea bit a bit el histórico mientras el
 * detector no haya decidido aplicar randomización de sesión (bit a bit idéntico).
 */
export const NO_JITTER_SEED = 0;

/**
 * Etapa 10 — número mínimo de evaluaciones con evidencia antes de activar el
 * jitter de pesos. Sesiones cortas (todas las pruebas calibradas) conservan los
 * scores de 6 decimales; el jitter solo afecta a sesiones largas reales.
 */
export const JITTER_SESSION_THRESHOLD = 12;

/** PRNG entero determinista (mulberry32): público, NO secreto, sin estado global. */
function jitterMultipliers(seed: number): SignalWeights {
  let state = Math.floor(seed) >>> 0 || 0x6d2b79f5;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = {} as SignalWeights;
  // Rango acotado: el jitter cambia QUÉ señal pesa más, nunca puede invertir
  // el orden de magnitud de un score calibrado.
  for (const key of SCORED_SIGNALS) out[key] = 0.85 + 0.3 * next();
  return out;
}

/** Evidencia de riesgo vacía (0 = "no aparece el patrón", nunca "humano"). */
export function emptyGuardrailRisk(): GuardrailRiskEvidence {
  return {
    coherence: 0,
    injection: 0,
    humanization: 0,
    formulaRhythm: 0,
    declaredVsBehavior: 0,
    replay: 0,
    surprise: 0,
    overall: 0,
  };
}

// ---------------------------------------------------------------------------
// Medidas finales (OPT-IN). `advancedMeasures` es false por defecto: la ruta
// numérica validada queda BIT A BIT idéntica. Cuando se activa, las medidas
// nuevas de mouse/clic/teclado/scroll/táctil/atención entran con pesos SMALL,
// acotados por señal, y su SHARE TOTAL del score combinado es como máximo
// `ADVANCED_MAX_SHARE` (~0.15). Es opt-in precisamente para preservar la
// calibración ya validada: activarlo exige recalibrar quien lo use.
// ---------------------------------------------------------------------------

/** Share máximo de las medidas finales dentro del score combinado. */
export const ADVANCED_MAX_SHARE = 0.15;
/** Peso máximo de una medida final dentro de su propia señal. */
const MAX_ADVANCED_FEATURE_WEIGHT = 0.15;

type WeightTable = Record<string, number>;

/** Pesos de respaldo, pequeños y acotados, cuando una tabla no está disponible. */
const ADVANCED_FALLBACK: Readonly<Record<string, WeightTable>> = Object.freeze({
  mouse: Object.freeze({
    curvature: 0.03,
    directionChanges: 0.03,
    largeJumps: 0.03,
    zigzag: 0.02,
    edgeEntries: 0.02,
    averageSpeed: 0.02,
    bellProfile: 0.03,
    speedVariation: 0.02,
    impossibleSpeed: 0.04,
    temporalResolution: 0.02,
    subpixel: 0.02,
    deviceType: 0.01,
    fineCorrection: 0.02,
    clickPrecision: 0.02,
    correctedMisses: 0.02,
  }),
  click: Object.freeze({
    instantaneousClick: 0.04,
    doubleClickRhythm: 0.04,
    secondaryButtons: 0.03,
  }),
  scroll: Object.freeze({ scrollSpeed: 0.04, instantEnd: 0.03 }),
  keyboard: Object.freeze({
    intervalDistribution: 0.03,
    typingSpeed: 0.03,
    pauseAfterError: 0.03,
    wordPauses: 0.02,
    sentenceEndPauses: 0.02,
    selectionDeletion: 0.02,
    arrowUsage: 0.02,
    autocompleteFalsePositive: 0.02,
    enterSubmit: 0.02,
    capitalization: 0.02,
    programmaticKeys: 0.03,
  }),
  touch: Object.freeze({}),
  attention: Object.freeze({}),
});

/**
 * Lee la PRIMERA tabla disponible con al menos un peso positivo. Se prueban
 * primero los nombres `*_FINAL_*` (lane de medidas finales) y después los
 * `*_PARTIAL_*` históricos. Una tabla hostil (getters, NaN, negativos) no
 * filtra nada: solo se aceptan números finitos en [0, MAX].
 */
function readWeightTable(module: unknown, names: readonly string[]): WeightTable {
  const source = module as Record<string, unknown> | null;
  if (!source || typeof source !== "object") return {};
  for (const name of names) {
    let candidate: unknown;
    try {
      candidate = source[name];
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    const table: WeightTable = {};
    let positive = false;
    try {
      for (const key of Object.keys(candidate as object)) {
        const value = (candidate as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
        const bounded = clamp(value, 0, MAX_ADVANCED_FEATURE_WEIGHT);
        table[key] = bounded;
        if (bounded > 0) positive = true;
      }
    } catch {
      continue;
    }
    if (positive) return table;
  }
  return {};
}

/** Pesos de respaldo derivados de las claves numéricas de un extractor hostil. */
function fallbackFromFeatures(features: WeightTable | null): WeightTable {
  const out: WeightTable = {};
  if (!features) return out;
  for (const key of Object.keys(features)) {
    out[key] = 0.025;
  }
  return out;
}

/** Combina tabla leída + respaldo; nunca deja un peso fuera de [0, MAX]. */
function resolveAdvancedWeights(
  module: unknown,
  names: readonly string[],
  fallback: WeightTable,
  features?: WeightTable | null,
): WeightTable {
  const table = readWeightTable(module, names);
  const out: WeightTable = { ...fallback };
  for (const [key, value] of Object.entries(table)) {
    if (value > 0) out[key] = value;
  }
  if (Object.keys(out).length === 0 && features) {
    for (const [key, value] of Object.entries(fallbackFromFeatures(features))) {
      out[key] = value;
    }
  }
  for (const key of Object.keys(out)) {
    out[key] = clamp(out[key], 0, MAX_ADVANCED_FEATURE_WEIGHT);
  }
  return out;
}

/** Llama a un extractor por nombre; un módulo/hostil ausente => sin medida. */
function advancedFeatures(module: unknown, name: string, samples: unknown): WeightTable | null {
  try {
    const fn = (module as Record<string, unknown> | null)?.[name];
    if (typeof fn !== "function") return null;
    const result = (fn as (value: unknown) => unknown)(samples);
    if (!result || typeof result !== "object") return null;
    const out: WeightTable = {};
    for (const key of Object.keys(result as object)) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** Media ponderada de medidas en [0,1]; null cuando no hay medida utilizable. */
function weightedFeatureRisk(features: WeightTable | null, weights: WeightTable): number | null {
  if (!features) return null;
  let sum = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    let value: unknown;
    try {
      value = features[key];
    } catch {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += weight * clamp(value, 0, 1);
    total += weight;
  }
  return total > 0 ? clamp(sum / total, 0, 1) : null;
}

interface AdvancedWeights {
  readonly mouse: WeightTable;
  readonly click: WeightTable;
  readonly scroll: WeightTable;
  readonly keyboard: WeightTable;
  readonly touchNames: readonly string[];
  readonly attentionNames: readonly string[];
}

let advancedWeightsCache: AdvancedWeights | null = null;

/** Resuelve las tablas una sola vez (lecturas puras, sin DOM). */
function getAdvancedWeights(): AdvancedWeights {
  if (advancedWeightsCache !== null) return advancedWeightsCache;
  advancedWeightsCache = {
    mouse: resolveAdvancedWeights(
      mouseFeatureModule,
      ["MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS", "MOUSE_PARTIAL_FEATURE_WEIGHTS"],
      ADVANCED_FALLBACK.mouse as WeightTable,
    ),
    click: resolveAdvancedWeights(
      clickFeatureModule,
      ["CLICK_FINAL_PARTIAL_FEATURE_WEIGHTS", "CLICK_PARTIAL_FEATURE_WEIGHTS"],
      ADVANCED_FALLBACK.click as WeightTable,
    ),
    scroll: resolveAdvancedWeights(
      scrollFeatureModule,
      ["SCROLL_FINAL_PARTIAL_FEATURE_WEIGHTS", "SCROLL_PARTIAL_FEATURE_WEIGHTS"],
      ADVANCED_FALLBACK.scroll as WeightTable,
    ),
    // El teclado NO reutiliza `KEYBOARD_FEATURE_WEIGHTS`: contiene pesosbase
    // ya aplicados y los duplicaría. Solo carril final/respaldo.
    keyboard: resolveAdvancedWeights(
      keyboardFeatureModule,
      ["KEYBOARD_FINAL_PARTIAL_FEATURE_WEIGHTS", "KEYBOARD_PARTIAL_FEATURE_WEIGHTS"],
      ADVANCED_FALLBACK.keyboard as WeightTable,
    ),
    touchNames: ["TOUCH_FINAL_FEATURE_WEIGHTS", "TOUCH_FEATURE_WEIGHTS"],
    attentionNames: ["ATTENTION_FINAL_FEATURE_WEIGHTS", "ATTENTION_FEATURE_WEIGHTS"],
  };
  return advancedWeightsCache;
}

/** Unión probabilística acotada; 0 con entradas vacías o no finitas. */
function unionRisk(values: number[]): number {
  let complement = 1;
  for (const value of values) {
    complement *= 1 - (Number.isFinite(value) ? clamp(value, 0, 1) : 0);
  }
  return clamp(1 - complement, 0, 1);
}

/** Intervalos positivos entre marcas finitas, para las medidas de ruido. */
function positiveIntervals(times: number[]): number[] {
  const sorted = times
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i] - sorted[i - 1];
    if (dt > 0 && Number.isFinite(dt)) out.push(dt);
  }
  return out;
}

/** Valor finito en [0,1]; cualquier fallo del módulo de ruido es "sin patrón". */
function safeUnit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/** `noiseHumanity()` exige 8 intervalos; por debajo no hay evidencia de ruido. */
const MIN_NOISE_INTERVALS = 8;

/**
 * Dificultad relativa de falsificar cada señal. Solo se aplica en el modo
 * `adaptive` (L164): sube el peso del ritmo de teclado y del micro-movimiento
 * del mouse, y baja el de clics/scrolls, que son más fáciles de simular.
 * En el modo `weighted` (default) el multiplicador es 1, así que el score es
 * bit a bit idéntico al historial.
 */
export const SIGNAL_DIFFICULTY: SignalWeights = Object.freeze({
  mouse: 1.25,
  keyboard: 1.15,
  click: 0.9,
  scroll: 0.85,
});

/**
 * Atenuación aplicada en el modo de protección por accesibilidad (L171) cuando
 * el perfil ya inferido es `tv` o `touch`. No crea evidencia: si el score es
 * null se devuelve null (nunca se convierte en "humano").
 */
export const ACCESSIBILITY_SCORE_FACTOR = 0.8;

/**
 * Duda 0..1: qué cerca está el score de la frontera de decisión dentro del
 * estado dado. 0 = convincente (dentro del núcleo de la clase), 1 = en el
 * umbral. "measuring" (o score null) siempre tiene duda 1.
 * El tercer argumento es opcional: al omitirlo se usan los umbrales fijos
 * históricos, por lo que las llamadas previas no cambian.
 */
export function doubtFor(
  state: Verdict["state"],
  score: number | null,
  bounds: { humanMax: number; aiMin: number } = { humanMax: HUMAN_MAX, aiMin: AI_MIN },
): number {
  if (state === "measuring" || typeof score !== "number" || !Number.isFinite(score)) return 1;
  // Bounds hostiles (NaN/Infinity/proxy) -> defaults históricos.
  const aiMin = finiteInRange(readOwn(bounds, "aiMin"), AI_MIN, 0, 1);
  if (state === "human") {
    const span = Math.max(aiMin - HUMAN_CORE, 1e-6);
    return clamp((score - HUMAN_CORE) / span, 0, 1);
  }
  const span = Math.max(AI_CORE - aiMin, 1e-6);
  return clamp((AI_CORE - score) / span, 0, 1);
}

const FEATURE_KEYS = Object.keys(weights) as Array<keyof FeatureWeights & keyof MouseFeatures>;

/**
 * Medidas donde un valor alto es HUMANO, no IA: giros suaves y correcciones
 * (sobrepaso). Se invierten antes de ponderar. Un humano dibuja círculos y
 * líneas fluidas; un agente se delata por saltos, pasos rectos repetidos y
 * velocidad/intervalos imposiblemente regulares, no por moverse suave.
 */
const HUMAN_SIGNALS = new Set<keyof MouseFeatures>(["overshoot", "turnSmoothness"]);

function riskValue(key: keyof MouseFeatures, value: number): number {
  return HUMAN_SIGNALS.has(key) ? 1 - value : value;
}

/** Resultado de una evaluación del scorer. */
export interface ScoredEvidence {
  /** Puntaje 0..1 o null cuando no hay evidencia suficiente. */
  score: number | null;
  confidence: number;
  /** Razones legibles en español (derivadas de las medidas que más aportan). */
  reasons: string[];
}

/**
 * Puntaje bruto: promedio ponderado por `weights`, normalizado por la suma
 * de pesos usados. Cada medida en [0, 1], 1 = IA.
 */
export function computeScore(features: MouseFeatures): number {
  let weighted = 0;
  let total = 0;
  for (const key of FEATURE_KEYS) {
    const weight = weights[key];
    const value = features[key];
    if (typeof weight === "number" && typeof value === "number" && Number.isFinite(value)) {
      weighted += weight * clamp(riskValue(key, value), 0, 1);
      total += weight;
    }
  }
  return total > 0 ? clamp(weighted / total, 0, 1) : 0.5;
}

/** Razones en español: top-N medidas con valor >= 0.55 por (peso x valor), N = 3 máximo; [] si ninguna. */
export function scoreReasons(features: MouseFeatures, top = 3): string[] {
  const texts: Record<keyof MouseFeatures, (value: number) => string> = {
    straightness: (v) => (v >= 0.5 ? "Trayectoria demasiado recta" : "Trayectoria meandrosa"),
    teleport: () => "Teletransporte detectado",
    speedUniformity: (v) => (v >= 0.5 ? "Velocidad casi constante" : "Velocidad irregular"),
    jerk: (v) => (v >= 0.5 ? "Cambios suaves de velocidad" : "Cambios bruscos de velocidad"),
    tremor: (v) => (v >= 0.5 ? "Poco temblor de mano" : "Temblor evidente"),
    intervalRegularity: (v) =>
      v >= 0.5 ? "Eventos con intervalos regulares" : "Intervalos irregulares entre eventos",
    overshoot: (v) => (v >= 0.5 ? "Correcciones visibles" : "Sin correcciones al llegar"),
    turnSmoothness: (v) => (v >= 0.5 ? "Giros suaves" : "Giros bruscos"),
    microPauses: (v) => (v >= 0.5 ? "Micro-pausas raras" : "Pausas frecuentes"),
    roundSteps: (v) => (v >= 0.5 ? "Pasos numéricos redondos" : "Pasos variables"),
  };
  return FEATURE_KEYS.map((key) => ({ key, risk: riskValue(key, features[key]) }))
    .filter((entry) => entry.risk >= 0.55)
    .map((entry) => ({ ...entry, contribution: weights[entry.key] * entry.risk }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, top)
    .map((entry) => texts[entry.key](features[entry.key]));
}

/**
 * Muestras de movimiento (kind 0). Se usa junto con countSegments como
 * evidencia mínima: en movimiento continuo hay un solo segmento, así que el
 * umbral se cumple contando muestras de movimiento.
 */
function movementSamples(samples: PointerSample[]): number {
  let count = 0;
  for (const sample of samples) if (sample.kind === 0) count += 1;
  return count;
}

/**
 * Scorer con estado: suaviza el puntaje bruto entre evaluaciones con EMA.
 * Evidencia insuficiente -> { score: null, confidence: 0, reasons: [] }
 * y sin modificar el EMA interno.
 */
/**
 * Copia pública con `keyboard` no enumerable: las tres señales anteriores
 * conservan su forma exacta (toEqual/JSON.stringify) para consumidores que ya
 * existían, mientras `scores.keyboard` sigue disponible como propiedad.
 */
function publicSignalScores(scores: SignalScores): SignalScores {
  const result: SignalScores = {
    mouse: scores.mouse,
    click: scores.click,
    scroll: scores.scroll,
    keyboard: scores.keyboard,
  };
  Object.defineProperty(result, "keyboard", { enumerable: false });
  return result;
}

/** Configuración interna del scorer (siempre completa, nunca undefined). */
export interface ScoringConfig {
  signalWeights: SignalWeights;
  combination: CombinationMode;
  accessibilityProtection: boolean;
  emaAlpha: number;
  /**
   * Modo accesibilidad explícito (Etapa 9). Distinto de
   * `accessibilityProtection`: aquí se filtra la evidencia de mouse/clic sin
   * prueba real; el teclado/touch siguen puntuando con normalidad.
   */
  accessibilityMode: boolean;
  /** Etapa 10: calcular evidencia de riesgo anti-trampas (default `true`). */
  antiCheat: boolean;
  /** Etapa 10: aplicar jitter de pesos con semilla de sesión (default `true`). */
  antiCheatWeightJitter: boolean;
  /** 0 = sin jitter; otro valor = semilla entera derivada de la sesión. */
  jitterSeed: number;
  /** OPT-IN: medidas finales con share acotado. Default false. */
  advancedMeasures: boolean;
}

/** Instantánea aditiva del estado del scorer, sin exponer referencias internas. */
export interface ScoringSnapshot {
  weights: SignalWeights;
  effectiveWeights: SignalWeights;
  combination: CombinationMode;
  ema: EmaInfo;
  accessibilityProtection: boolean;
  lastDevice: Exclude<DeviceProfile, "auto">;
  accessibilityApplied: boolean;
  /** Etapa 10: evidencia de riesgo calculada en la última evaluación. */
  riskEvidence: GuardrailRiskEvidence;
  /** OPT-IN: medidas finales activas / aplicadas / share máximo. */
  advancedMeasures: boolean;
  advancedApplied: boolean;
  advancedShare: number;
}

/** Defaults: reproducen exactamente el scoring previo (congelados en runtime). */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = Object.freeze({
  signalWeights: Object.freeze({ ...SIGNAL_WEIGHTS }),
  combination: "weighted",
  accessibilityProtection: false,
  emaAlpha: EMA_ALPHA,
  accessibilityMode: false,
  antiCheat: true,
  antiCheatWeightJitter: true,
  jitterSeed: NO_JITTER_SEED,
  advancedMeasures: false,
});

/**
 * Lee solo una propiedad **propia**. Objetos hostiles (prototipos envenenados,
 * getters que lanzan, proxies) no pueden inyectar valores en la configuración.
 */
export function readOwn(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) {
    return undefined;
  }
  try {
    if (!Object.hasOwn(source, key)) return undefined;
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Número finito dentro de [min,max]; cualquier otro valor usa el fallback seguro. */
export function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Score unitario finito o null: nunca NaN/Infinity en la API pública. */
function unitOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : null;
}

/**
 * En modo accesibilidad el mouse (pointerType 0) solo cuenta si es real
 * (`isTrusted`); el touch/pen sigue puntuando igual que siempre. La ausencia
 * de movimiento de puntero no genera evidencia: `hasMouse` sigue siendo false.
 */
function accessibilityPointerSamples(samples: PointerSample[]): PointerSample[] {
  return samples.filter((sample) => sample.pointerType !== 0 || sample.trusted === 1);
}

export class ScoreComputer {
  private ema: number | null = null;
  /** EMA anterior a la última evaluación (solo informativo, nunca puntúa). */
  private previousEma: number | null = null;
  /** Últimas medidas de mouse calculadas en `evaluate`, reutilizables por el detector. */
  private mouseFeatures: MouseFeatures | null = null;
  private signalScores: SignalScores = {
    mouse: null,
    click: null,
    scroll: null,
    keyboard: null,
  };
  // Copia profunda: el objeto compartido DEFAULT_SCORING_CONFIG está congelado
  // y configure() nunca debe escribir en él.
  private config: ScoringConfig = {
    ...DEFAULT_SCORING_CONFIG,
    signalWeights: { ...DEFAULT_SCORING_CONFIG.signalWeights },
  };
  private lastDevice: Exclude<DeviceProfile, "auto"> = "desktop";
  private accessibilityApplied = false;
  /** Etapa 10: última evidencia de riesgo; NUNCA entra en el score numérico. */
  private guardrailRisk: GuardrailRiskEvidence = emptyGuardrailRisk();
  /** OPT-IN: ¿se aplicaron medidas finales en la última evaluación? */
  private advancedApplied = false;
  /** Share máximo realmente aplicado (0 cuando no se aplicó). */
  private advancedShare = 0;

  /**
   * Fusiona una configuración parcial con la actual. Los campos ausentes se
   * conservan; `undefined` nunca sobrescribe un valor válido.
   */
  configure(config: Partial<ScoringConfig> = {}): void {
    if (config === null || (typeof config !== "object" && typeof config !== "function")) return;
    // Se lee una sola vez cada campo: los getters hostiles no pueden observar
    // ni alterar el estado a mitad de la fusión.
    const weightsIn = readOwn(config, "signalWeights");
    const combinationIn = readOwn(config, "combination");
    const accessibilityIn = readOwn(config, "accessibilityProtection");
    const accessibilityModeIn = readOwn(config, "accessibilityMode");
    const emaIn = readOwn(config, "emaAlpha");
    const antiCheatIn = readOwn(config, "antiCheat");
    const jitterIn = readOwn(config, "antiCheatWeightJitter");
    const seedIn = readOwn(config, "jitterSeed");
    const advancedIn = readOwn(config, "advancedMeasures");

    if (
      weightsIn !== undefined &&
      weightsIn !== null &&
      (typeof weightsIn === "object" || typeof weightsIn === "function")
    ) {
      const weights = { ...this.config.signalWeights };
      for (const key of SCORED_SIGNALS) {
        const raw = readOwn(weightsIn, key);
        if (raw !== undefined) weights[key] = finiteInRange(raw, weights[key], 0, 1);
      }
      this.config.signalWeights = weights;
    }
    if (combinationIn === "weighted" || combinationIn === "adaptive") {
      this.config.combination = combinationIn;
    }
    if (typeof accessibilityIn === "boolean") {
      this.config.accessibilityProtection = accessibilityIn;
    }
    if (typeof accessibilityModeIn === "boolean") {
      this.config.accessibilityMode = accessibilityModeIn;
    }
    if (emaIn !== undefined) {
      this.config.emaAlpha = finiteInRange(emaIn, this.config.emaAlpha, 0, 1);
    }
    // Valores hostiles (no booleanos) se ignoran: fail-closed en la configuración.
    if (typeof antiCheatIn === "boolean") this.config.antiCheat = antiCheatIn;
    if (typeof jitterIn === "boolean") this.config.antiCheatWeightJitter = jitterIn;
    if (typeof advancedIn === "boolean") this.config.advancedMeasures = advancedIn;
    if (seedIn !== undefined) {
      this.config.jitterSeed =
        typeof seedIn === "number" && Number.isFinite(seedIn) && seedIn > 0
          ? Math.floor(seedIn)
          : NO_JITTER_SEED;
    }
  }

  /** Copia de la configuración activa (nunca la referencia interna). */
  getConfig(): ScoringConfig {
    return {
      signalWeights: { ...this.config.signalWeights },
      combination: this.config.combination,
      accessibilityProtection: this.config.accessibilityProtection,
      emaAlpha: this.config.emaAlpha,
      accessibilityMode: this.config.accessibilityMode,
      antiCheat: this.config.antiCheat,
      antiCheatWeightJitter: this.config.antiCheatWeightJitter,
      jitterSeed: this.config.jitterSeed,
      advancedMeasures: this.config.advancedMeasures,
    };
  }

  /**
   * Pesos efectivos: los configurados multiplicados por la dificultad si
   * `adaptive` y, en sesiones largas, por un jitter determinista por semilla.
   * Con `jitterSeed === 0` (default y todas las pruebas calibradas) el resultado
   * es exactamente el histórico.
   */
  getEffectiveWeights(): SignalWeights {
    const jitter =
      this.config.antiCheat &&
      this.config.antiCheatWeightJitter &&
      this.config.jitterSeed !== NO_JITTER_SEED &&
      Number.isFinite(this.config.jitterSeed)
        ? jitterMultipliers(this.config.jitterSeed)
        : null;
    const out = {} as SignalWeights;
    for (const key of SCORED_SIGNALS) {
      const base =
        this.config.combination === "adaptive"
          ? this.config.signalWeights[key] * SIGNAL_DIFFICULTY[key]
          : this.config.signalWeights[key];
      out[key] = jitter === null ? base : base * jitter[key];
    }
    return out;
  }

  /** Etapa 10: última evidencia de riesgo calculada (copia, nunca la interna). */
  getGuardrailRisk(): GuardrailRiskEvidence {
    return { ...this.guardrailRisk };
  }

  /** Estado aditivo para `getScoreBreakdown()` del detector. */
  getScoringSnapshot(): ScoringSnapshot {
    return {
      weights: { ...this.config.signalWeights },
      effectiveWeights: this.getEffectiveWeights(),
      combination: this.config.combination,
      ema: {
        alpha: this.config.emaAlpha,
        previous: this.previousEma,
        current: this.ema,
      },
      accessibilityProtection: this.config.accessibilityProtection,
      lastDevice: this.lastDevice,
      accessibilityApplied: this.accessibilityApplied,
      riskEvidence: this.getGuardrailRisk(),
      advancedMeasures: this.config.advancedMeasures,
      advancedApplied: this.advancedApplied,
      advancedShare: this.advancedShare,
    };
  }

  /** Borra el EMA, los scores por señal y la ventana de evidencia interna. */
  reset(): void {
    this.ema = null;
    this.previousEma = null;
    this.mouseFeatures = null;
    this.signalScores = { mouse: null, click: null, scroll: null, keyboard: null };
    this.lastDevice = "desktop";
    this.accessibilityApplied = false;
    this.guardrailRisk = emptyGuardrailRisk();
    this.advancedApplied = false;
    this.advancedShare = 0;
  }

  /** Medidas de mouse de la última evaluación (null si no hubo evidencia). */
  getMouseFeatures(): MouseFeatures | null {
    return this.mouseFeatures;
  }

  /** Último score por señal calculado (null si esa señal no tenía evidencia). */
  getSignalScores(): SignalScores {
    return publicSignalScores(this.signalScores);
  }

  /**
   * Etapa 10 — guardarraíles anti-trampas. Calcula evidencia de riesgo ADITIVA
   * sobre las MISMAS muestras del scoring. NUNCA toca `ema`, `signalScores` ni
   * el score devuelto: los scores calibrados (6 decimales) quedan intactos y
   * "sin patrón" (0) jamás se interpreta como "humano".
   */
  private computeGuardrailRisk(
    samples: PointerSample[],
    clicks: ClickSample[],
    scrolls: ScrollSample[],
    keys: KeySample[],
    inputs: InputSample[],
    device: Exclude<DeviceProfile, "auto">,
  ): GuardrailRiskEvidence {
    if (!this.config.antiCheat) return emptyGuardrailRisk();
    const coherence = evaluateCoherence(samples, clicks, scrolls, keys, inputs);
    const times: number[] = [];
    for (const key of keys) if (key.kind === 0) times.push(key.t);
    for (const input of inputs) times.push(input.t);
    const intervals = positiveIntervals(times);
    let formula = 0;
    let humanity = 0;
    try {
      formula = safeUnit(formulaRhythm(intervals));
      humanity = safeUnit(noiseHumanity(intervals));
    } catch {
      // Un módulo de ruido hostil no debe romper el scoring: sin evidencia.
    }
    // `noiseHumanity` mide CUÁNTO se parece el ruido a un humano; por debajo de
    // 8 intervalos el módulo devuelve 0 (sin evidencia), así que no se complementa.
    const noiseRisk = intervals.length >= MIN_NOISE_INTERVALS ? 1 - humanity : 0;
    const evidence: GuardrailRiskEvidence = {
      coherence: safeUnit(
        Math.max(
          coherence.mixedSuspicious,
          coherence.actionsWithoutPriorEvent,
          coherence.phantomEvents,
        ),
      ),
      injection: safeUnit(injectionRisk(keys, inputs, samples)),
      humanization: safeUnit(humanizationRisk(keys, inputs)),
      formulaRhythm: safeUnit(Math.max(formula, noiseRisk)),
      declaredVsBehavior: safeUnit(declaredVsBehavior(device, samples, keys, inputs)),
      // El detector completa estas dos con ReplaySignals / SurpriseCheck.
      replay: 0,
      surprise: 0,
      overall: 0,
    };
    evidence.overall = unionRisk([
      evidence.coherence,
      evidence.injection,
      evidence.humanization,
      evidence.formulaRhythm,
      evidence.declaredVsBehavior,
    ]);
    return evidence;
  }

  /**
   * Riesgo agregado de las medidas finales (opt-in). Cada señal aporta una media
   * ponderada acotada de sus medidas; se combinan en [0,1] con peso parejo.
   * Nunca se consulta DOM ni se lee texto: todo son números ya recolectados.
   */
  private advancedRisk(
    samples: PointerSample[],
    clicks: ClickSample[],
    scrolls: ScrollSample[],
    keys: KeySample[],
    inputs: InputSample[],
    keyboardFeatures: KeyboardFeatures | null,
    touches: unknown[],
    attention: unknown[],
  ): number | null {
    if (!this.config.advancedMeasures) return null;
    const tables = getAdvancedWeights();
    const parts: Array<{ risk: number; weight: number }> = [];
    const addSignal = (
      features: WeightTable | null,
      weights: WeightTable,
      weight: number,
    ): void => {
      const risk = weightedFeatureRisk(features, weights);
      if (risk !== null) parts.push({ risk, weight });
    };

    if (samples.length > 0) {
      addSignal(
        advancedFeatures(mouseFeatureModule, "extractPartialMouseFeatures", samples),
        tables.mouse,
        1,
      );
    }
    if (clicks.length > 0) {
      addSignal(
        advancedFeatures(clickFeatureModule, "extractPartialClickFeatures", clicks),
        tables.click,
        1,
      );
    }
    if (scrolls.length > 0) {
      addSignal(
        advancedFeatures(scrollFeatureModule, "extractPartialScrollFeatures", scrolls),
        tables.scroll,
        1,
      );
    }
    if (keyboardFeatures) {
      // `KeyboardFeatures` ya contiene las medidas finales del teclado; se
      // entregan como tabla numérica sin tocar los pesos base.
      const kb: WeightTable = {};
      for (const [key, value] of Object.entries(keyboardFeatures as unknown as WeightTable)) {
        if (typeof value === "number" && Number.isFinite(value)) kb[key] = value;
      }
      addSignal(Object.keys(kb).length > 0 ? kb : null, tables.keyboard, 1);
    }
    if (Array.isArray(touches) && touches.length > 0) {
      const features = advancedFeatures(touchFeatureModule, "extractTouchFeatures", touches);
      addSignal(
        features,
        resolveAdvancedWeights(touchFeatureModule, tables.touchNames, {}, features),
        1,
      );
    }
    if (Array.isArray(attention) && attention.length > 0) {
      const features = advancedFeatures(
        attentionFeatureModule,
        "extractAttentionFeatures",
        attention,
      );
      addSignal(
        features,
        resolveAdvancedWeights(attentionFeatureModule, tables.attentionNames, {}, features),
        1,
      );
    }
    // `inputs`/`keys` sin teclado suficiente no inventan medidas: el carril de
    // teclado ya se cubre con `keyboardFeatures` cuando hay evidencia.
    void keys;
    void inputs;
    if (parts.length === 0) return null;
    let sum = 0;
    let total = 0;
    for (const part of parts) {
      sum += part.weight * part.risk;
      total += part.weight;
    }
    return total > 0 ? clamp(sum / total, 0, 1) : null;
  }

  /**
   * Evalúa todas las señales disponibles. Los argumentos `clicks`/`scrolls`/
   * `keys`/`inputs` son opcionales: al omitirlos (o al no alcanzar su evidencia
   * mínima) el resultado es IDÉNTICO al scoring de mouse original, incluido el
   * EMA. La firma extensible mantiene las llamadas de dos argumentos intactas.
   * El séptimo argumento (`device`, default `desktop`) ajusta el teclado al
   * perfil; las llamadas de seis argumentos no cambian su comportamiento.
   * Los dos opcionales finales (`touches`/`attention`) solo alimentan las
   * medidas finales OPT-IN; sin ellas la ruta es la histórica.
   */
  evaluate(
    samples: PointerSample[],
    windowMs: number,
    clicks: ClickSample[] = [],
    scrolls: ScrollSample[] = [],
    keys: KeySample[] = [],
    inputs: InputSample[] = [],
    device: Exclude<DeviceProfile, "auto"> = "desktop",
    touches: unknown[] = [],
    attention: unknown[] = [],
  ): ScoredEvidence {
    // La API es pública: argumentos no-array o un perfil inventado no deben
    // lanzar ni contaminar el desglose.
    if (
      !Array.isArray(samples) ||
      !Array.isArray(clicks) ||
      !Array.isArray(scrolls) ||
      !Array.isArray(keys) ||
      !Array.isArray(inputs)
    ) {
      return { score: null, confidence: 0, reasons: [] };
    }
    const safeDevice: Exclude<DeviceProfile, "auto"> =
      device === "tv" || device === "touch" || device === "desktop" ? device : "desktop";
    this.lastDevice = safeDevice;
    this.accessibilityApplied = false;
    this.advancedApplied = false;
    this.advancedShare = 0;
    // Guardarraíles: solo evidencia aditiva, nunca entra en el score.
    this.guardrailRisk = this.computeGuardrailRisk(
      samples,
      clicks,
      scrolls,
      keys,
      inputs,
      safeDevice,
    );
    // Modo accesibilidad: el mouse/clic sin evidencia real NO puntúa. Fuera del
    // modo las referencias son las originales, así que el scoring es idéntico.
    const pointerSamples = this.config.accessibilityMode
      ? accessibilityPointerSamples(samples)
      : samples;
    const pointerClicks = this.config.accessibilityMode
      ? clicks.filter((click) => click.trusted === 1)
      : clicks;
    const segmentCount = countSegments(pointerSamples);
    const moveCount = movementSamples(pointerSamples);
    const hasMouse =
      pointerSamples.length > 0 &&
      (segmentCount >= MIN_SEGMENTS || moveCount >= MIN_SEGMENTS) &&
      windowMs >= MIN_WINDOW_MS;

    const clickWindowMs =
      pointerClicks.length >= 2
        ? pointerClicks[pointerClicks.length - 1].t - pointerClicks[0].t
        : 0;
    // El autoscroll humano se excluye ANTES de contar evidencia: si solo hay
    // autoscroll, la señal de scroll queda sin evidencia (null).
    const scoredScrolls = withoutAutoscroll(scrolls);
    const scrollWindowMs =
      scoredScrolls.length >= 2
        ? scoredScrolls[scoredScrolls.length - 1].t - scoredScrolls[0].t
        : 0;
    const hasClick = pointerClicks.length >= MIN_CLICKS && clickWindowMs >= MIN_WINDOW_MS;
    const hasScroll = scoredScrolls.length >= MIN_SCROLLS && scrollWindowMs >= MIN_WINDOW_MS;
    const hasKeyboard = hasKeyboardEvidence(keys, inputs);
    const keyWindowMs = keyboardWindowMs(keys);

    const mouseFeatures: MouseFeatures | null = hasMouse
      ? extractMouseFeatures(pointerSamples)
      : null;
    this.mouseFeatures = mouseFeatures;
    const clickFeatures: ClickFeatures | null = hasClick
      ? extractClickFeatures(pointerClicks)
      : null;
    const scrollFeatures: ScrollFeatures | null = hasScroll
      ? extractScrollFeatures(scoredScrolls)
      : null;
    const keyboardFeatures: KeyboardFeatures | null = hasKeyboard
      ? keyboardFeaturesForDevice(extractKeyboardFeatures(keys, inputs), keys, safeDevice)
      : null;

    // Sanitiza cada señal: un feature hostil nunca debe filtrar NaN/Infinity
    // ni al score combinado ni a getSignalScores().
    this.signalScores = {
      mouse: unitOrNull(mouseFeatures ? computeScore(mouseFeatures) : null),
      click: unitOrNull(clickFeatures ? computeClickScore(clickFeatures) : null),
      scroll: unitOrNull(scrollFeatures ? computeScrollScore(scrollFeatures) : null),
      keyboard: unitOrNull(keyboardFeatures ? computeKeyboardScore(keyboardFeatures) : null),
    };

    if (!hasMouse && !hasClick && !hasScroll && !hasKeyboard) {
      return { score: null, confidence: 0, reasons: [] };
    }
    // Medidas finales: solo cuando el opt-in está activo. Su riesgo se combine
    // MAS ABAJO con share acotado; sin opt-in el valor es null (ruta histórica).
    const advancedRiskValue = this.advancedRisk(
      pointerSamples,
      pointerClicks,
      scoredScrolls,
      keys,
      inputs,
      keyboardFeatures,
      touches,
      attention,
    );

    // Combinación ponderada entre señales CON evidencia; se normaliza por la
    // suma de pesos usados. Con solo mouse da el score del mouse (peso 1).
    // En modo `weighted` los pesos efectivos coinciden con los documentados,
    // así que el resultado es idéntico al histórico.
    const effective = this.getEffectiveWeights();
    let weighted = 0;
    let weightTotal = 0;
    if (hasMouse) {
      weighted += effective.mouse * (this.signalScores.mouse as number);
      weightTotal += effective.mouse;
    }
    if (hasClick) {
      weighted += effective.click * (this.signalScores.click as number);
      weightTotal += effective.click;
    }
    if (hasScroll) {
      weighted += effective.scroll * (this.signalScores.scroll as number);
      weightTotal += effective.scroll;
    }
    if (hasKeyboard) {
      weighted += effective.keyboard * (this.signalScores.keyboard as number);
      weightTotal += effective.keyboard;
    }
    // Pesos todos a cero (config hostil): antes se inventaba un 0.5 que, desde
    // `measuring`, caía en la banda media y confirmaba "humano" (fail open).
    // Sin peso utilizable no hay evidencia: score null -> measuring.
    if (!(weightTotal > 0) || !Number.isFinite(weightTotal) || !Number.isFinite(weighted)) {
      return { score: null, confidence: 0, reasons: [] };
    }
    const baseRaw = clamp(weighted / weightTotal, 0, 1);
    let raw = baseRaw;
    // Opt-in: las medidas finales entran como una señal adicional con peso tal
    // que su share del total es EXACTAMENTE ADVANCED_MAX_SHARE (<= 0.15). El
    // resultado no puede alejarse más de 0.15 del score base calibrado.
    if (advancedRiskValue !== null && this.config.advancedMeasures) {
      const advancedWeight = (weightTotal * ADVANCED_MAX_SHARE) / (1 - ADVANCED_MAX_SHARE);
      raw = clamp(
        (weighted + advancedWeight * advancedRiskValue) / (weightTotal + advancedWeight),
        0,
        1,
      );
      this.advancedApplied = raw !== baseRaw;
      this.advancedShare = ADVANCED_MAX_SHARE;
    }

    const alpha = finiteInRange(this.config.emaAlpha, EMA_ALPHA, 0, 1);
    const smoothed = this.ema === null ? raw : alpha * raw + (1 - alpha) * this.ema;
    this.previousEma = this.ema;
    this.ema = unitOrNull(smoothed);

    // La misma fórmula de confianza del mouse, extendida con el resto de
    // señales solo cuando aportan evidencia. Con solo mouse es idéntica.
    const evidenceCount =
      moveCount +
      (hasClick ? pointerClicks.length : 0) +
      (hasScroll ? scoredScrolls.length : 0) +
      (hasKeyboard ? countKeyDowns(keys) + inputs.length : 0);
    const maxWindowMs = Math.max(
      windowMs,
      hasClick ? clickWindowMs : 0,
      hasScroll ? scrollWindowMs : 0,
      hasKeyboard ? keyWindowMs : 0,
    );
    const confidence = finiteInRange(
      0.5 * (Math.min(evidenceCount / 25, 1) + Math.min(maxWindowMs / 2000, 1)),
      0,
      0,
      1,
    );

    const reasons: string[] = [];
    if (mouseFeatures) reasons.push(...scoreReasons(mouseFeatures));
    if (clickFeatures) reasons.push(...clickReasons(clickFeatures));
    if (scrollFeatures) reasons.push(...scrollReasons(scrollFeatures));
    if (keyboardFeatures) reasons.push(...keyboardReasons(keyboardFeatures));
    if (this.advancedApplied) reasons.push("Medidas finales aplicadas (opt-in)");

    // Protección por accesibilidad (L171): reutiliza SOLO el perfil ya
    // inferido (`tv`/`touch`). Nunca se aplica sin evidencia (más arriba se
    // devuelve `score: null`), por lo que no puede convertir "no sé" en humano.
    // La atenuación es de presentación: el EMA sigue midiendo la evidencia cruda.
    let final = this.ema;
    if (this.config.accessibilityProtection && (safeDevice === "tv" || safeDevice === "touch")) {
      final = final === null ? null : clamp(final * ACCESSIBILITY_SCORE_FACTOR, 0, 1);
      this.accessibilityApplied = true;
      reasons.push(`Perfil ${safeDevice}: puntaje atenuado por accesibilidad`);
    }
    const safeScore = unitOrNull(final);
    if (safeScore === null) return { score: null, confidence: 0, reasons: [] };

    return { score: safeScore, confidence, reasons };
  }
}
