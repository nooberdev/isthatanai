import type { CalibrationResult } from "../calibration/recalibrate";
import * as recalibrateModule from "../calibration/recalibrate";
// Namespace imports: estas lanes entregan los módulos con contratos exactos de
// nombres; se consultan por nombre en runtime para tolerar módulos ausentes o
// hostiles (fail-closed) sin tocar DOM al importar ni en el constructor.
import * as attentionCollectorModule from "../collectors/attention";
import { type ClickCollector, createClickCollector } from "../collectors/click";
import { createKeyboardCollector, type KeyboardCollector } from "../collectors/keyboard";
import { createMouseCollector, type MouseCollector } from "../collectors/mouse";
import { createScrollCollector, type ScrollCollector } from "../collectors/scroll";
import { createTextInputCollector, type TextInputCollector } from "../collectors/text-input";
import * as touchCollectorModule from "../collectors/touch";
import * as attentionFeatureModule from "../features/attention";
import { extractMouseFeatures, type MouseFeatures } from "../features/mouse";
import * as touchFeatureModule from "../features/touch";
import { detectLocale, LOCALES, type Locale } from "../i18n";
import { translateReasons } from "../i18n/reason-translator";
import {
  AI_CONFIRM_MS,
  AI_MIN,
  DEFAULT_SCORING_CONFIG,
  doubtFor,
  EMA_ALPHA,
  finiteInRange,
  HUMAN_CONFIRM_MS,
  HUMAN_MAX,
  JITTER_SESSION_THRESHOLD,
  NO_JITTER_SEED,
  readOwn,
  SCORED_SIGNALS,
  ScoreComputer,
  SENSITIVITIES,
  SENSITIVITY_PRESETS,
} from "../scoring/score";
import type {
  ChangeCallback,
  ClickSample,
  CollectorStats,
  CombinationMode,
  ConfirmTimes,
  DetailedDevice,
  DetectorConfig,
  DetectorOptions,
  DeviceProfile,
  GuardrailRiskEvidence,
  HandoverInfo,
  InputSample,
  KeySample,
  PointerSample,
  PrivacyMode,
  ScoreBreakdown,
  ScrollSample,
  Sensitivity,
  Signal,
  SignalScores,
  SignalWeights,
  ThresholdCallback,
  Thresholds,
  Verdict,
  VerdictCallback,
} from "../types";
import { clamp } from "../utils/math";
import { aggregatesOnlyStats, doNotTrack, roundTiming } from "../utils/privacy-shape";
import { RingBuffer } from "../utils/ring-buffer";
import { type CoherenceDetailed, evaluateCoherenceDetailed } from "./coherence";
import {
  type DeviceHints,
  inferDetailedDevice,
  inferDeviceProfile,
  type ResolvedDeviceProfile,
} from "./device-profile";
import * as environmentModule from "./environment";
import { LivenessMonitor, type LivenessStatus } from "./liveness";
import { type ReplayInput, type ReplaySignals, ReplayTracker } from "./replay";
import { type SurpriseCheck, surpriseCoherenceCheck } from "./surprise";
import { type IntegrityReport, verifyIntegrity } from "./tamper";

export { AI_CONFIRM_MS, AI_MIN, HUMAN_CONFIRM_MS, HUMAN_MAX };

const DEFAULT_BUFFER_SIZE = 2048;
/** Techo para evitar asignaciones multimemoria (Float64Array) con bufferSize hostil. */
const MAX_BUFFER_SIZE = 100_000;
const DEFAULT_MAX_AGE_MS = 15000;
/** Techo de tiempos: cualquier valor fuera de [0, 1e9] vuelve al default. */
const MAX_TIME_MS = 1e9;
const EVALUATION_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Contratos aditivos de la "checklist final". Tipos estructurales locales: el
// detector solo necesita números y el ciclo attach/detach/clear. Así un módulo
// aún no publicado (ohostil) no altera la forma pública existente.
// ---------------------------------------------------------------------------

/** Muestra táctil/ de atención: solo se leen `seq` y `t` (nunca contenido). */
interface TimedSampleLike {
  seq?: number;
  t?: number;
}

interface SampleCollectorLike {
  attach(): void;
  detach(): void;
  clear(): void;
  getSamples(): TimedSampleLike[];
  discardOldestBefore?(t: number): void;
  readonly buffer?: { size?: number };
  readonly size?: number;
}

type FeatureTable = Record<string, number>;

interface EnvironmentHintsLike {
  webdriver: boolean;
  maxTouchPoints: number;
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  mobile: boolean;
}

/**
 * Tolerancias devueltas por `applyCalibration`. Se usan SOLO en umbrales de
 * notas de guardarraíl (nunca en compuertas de evidencia ni en veredictos).
 * La forma es la del propio módulo de recalibración.
 */
interface GuardrailTolerances {
  pauseMs: number;
  rhythmTolerance: number;
}

const DEFAULT_GUARDRAIL_TOLERANCES: GuardrailTolerances = Object.freeze({
  pauseMs: 1000,
  rhythmTolerance: 0.5,
});

/** Instantánea de replay ampliada con las dos señales aditivas. */
type ExtendedReplayInput = ReplayInput & {
  touches?: TimedSampleLike[];
  attention?: TimedSampleLike[];
};

/** Fábrica defensiva de colectores: un módulo ausente no rompe `start()`. */
function createSampleCollector(
  module: unknown,
  name: string,
  options: unknown,
): SampleCollectorLike | null {
  try {
    const factory = (module as Record<string, unknown> | null)?.[name];
    if (typeof factory !== "function") return null;
    const collector = (factory as (value: unknown) => unknown)(options);
    if (!collector || typeof collector !== "object") return null;
    const candidate = collector as SampleCollectorLike;
    if (typeof candidate.attach !== "function" || typeof candidate.detach !== "function") {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/** `seq` finito: estrecha el tipo para que `Math.max` no reciba `undefined`. */
function finiteSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Número de muestras conservadas por un colector aditivo. */
function collectorSize(collector: SampleCollectorLike | null): number {
  if (!collector) return 0;
  try {
    if (collector.buffer && typeof collector.buffer.size === "number") {
      return Number.isFinite(collector.buffer.size) ? Math.max(0, collector.buffer.size) : 0;
    }
    if (typeof collector.size === "number" && Number.isFinite(collector.size)) {
      return Math.max(0, collector.size);
    }
    const samples = collector.getSamples();
    return Array.isArray(samples) ? samples.length : 0;
  } catch {
    return 0;
  }
}

/** Define una propiedad aditiva NO enumerable (invisible a toEqual/Object.keys). */
function defineHidden(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Objeto hostil: la propiedad es solo observabilidad.
  }
}

/** Copia acotada y finita de un resultado de calibración (fail-closed). */
function boundedCalibration(value: unknown): CalibrationResult {
  const empty: CalibrationResult = { applied: false, samples: 0, adjustments: {}, reasons: [] };
  if (!value || typeof value !== "object") return empty;
  const source = value as Record<string, unknown>;
  const adjustments: Record<string, number> = {};
  const reasons: string[] = [];
  try {
    const rawAdjustments = source.adjustments;
    if (rawAdjustments && typeof rawAdjustments === "object") {
      for (const key of Object.keys(rawAdjustments as object).slice(0, 16)) {
        const raw = (rawAdjustments as Record<string, unknown>)[key];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          adjustments[key] = clamp(raw, 0, 1e6);
        }
      }
    }
    if (Array.isArray(source.reasons)) {
      for (const reason of source.reasons.slice(0, 16)) {
        if (typeof reason === "string") reasons.push(reason.slice(0, 128));
      }
    }
  } catch {
    return empty;
  }
  const rawSamples =
    typeof source.samples === "number" && Number.isFinite(source.samples) ? source.samples : 0;
  return {
    applied: source.applied === true,
    samples: Math.floor(clamp(rawSamples, 0, 1e6)),
    adjustments,
    reasons,
  };
}

/** Llama a `evaluateEnvironment` con muestras + pistas de start(); nunca lanza. */
function safeEnvironmentSignals(
  samples: PointerSample[],
  clicks: ClickSample[],
  scrolls: ScrollSample[],
  keys: KeySample[],
  inputs: InputSample[],
  hints: EnvironmentHintsLike,
): FeatureTable | null {
  try {
    const fn = (environmentModule as Record<string, unknown>).evaluateEnvironment;
    if (typeof fn !== "function") return null;
    const result = (fn as (value: unknown) => unknown)({
      points: samples,
      clicks,
      scrolls,
      keys,
      inputs,
      hints: { ...hints },
    });
    if (!result || typeof result !== "object") return null;
    const out: FeatureTable = {};
    for (const key of Object.keys(result as object)) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = clamp(value, 0, 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** Extrae medidas aditivas por nombre; un módulo hostil da `null` (fail closed). */
function safeFeatureTable(module: unknown, name: string, samples: unknown): FeatureTable | null {
  try {
    const fn = (module as Record<string, unknown> | null)?.[name];
    if (typeof fn !== "function") return null;
    const result = (fn as (value: unknown) => unknown)(samples);
    if (!result || typeof result !== "object") return null;
    const out: FeatureTable = {};
    for (const key of Object.keys(result as object)) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = clamp(value, 0, 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** Etapa 10 — latido por defecto del monitor de liveness (solo observabilidad). */
const DEFAULT_LIVENESS_INTERVAL_MS = 1000;
/** Umbral para considerar "idéntica" una trayectoria repetida en la sesión. */
const REPLAY_REASON_THRESHOLD = 0.95;
/**
 * Razones nuevas de la Etapa 10. Se dejan como cadenas SIN clave de diccionario
 * porque `src/i18n/**` queda fuera del alcance de esta integración;
 * `translateReasons()` las pasa sin cambios en cualquier idioma (documentado).
 */
const REPLAY_REASON = "Trayectoria idéntica repetida en la sesión";
const INTEGRITY_REASON = "Integridad verificada: manipulación detectada";

// Regla: NO tocar window/document/navigator al importar ni en el constructor.
// Toda interacción con el DOM ocurre dentro de start() y se limpia en stop().

const MEASURING: Verdict = {
  state: "measuring",
  score: null,
  confidence: 0,
  doubt: 1,
  reasons: [],
};

/** Dos evaluaciones consecutivas en la nueva banda = cambio "sostenido". */
const HANDOVER_MIN_STREAK = 2;

/**
 * Etapa 11 — nombres válidos de `Signal` en orden estable. `touch` y
 * `attention` no tienen scoring hoy: se pueden activar/desactivar, pero no
 * cambian el número (no hay evidencia que puntúen).
 */
const ALL_SIGNALS: readonly Signal[] = Object.freeze([
  "mouse",
  "keyboard",
  "click",
  "scroll",
  "touch",
  "attention",
]);
/** Umbral seguro cuando `onThreshold()` recibe un valor no finito/fuera de [0,1]. */
const DEFAULT_THRESHOLD = 0.5;

const DEVICE_PROFILES: readonly DeviceProfile[] = ["auto", "desktop", "touch", "tv"];
const DETAILED_DEVICES: readonly DetailedDevice[] = [
  "computadora",
  "laptop",
  "celular",
  "tablet",
  "tv",
  "touch",
];

type Band = "human" | "ai" | "middle" | "unknown";
type StableBand = "human" | "ai";

/** Configuración ya resuelta (todos los campos presentes). */
interface ResolvedConfig {
  thresholds: Thresholds;
  signalWeights: SignalWeights;
  device: DeviceProfile;
  combination: CombinationMode;
  accessibilityProtection: boolean;
  confirmMs: ConfirmTimes;
  emaAlpha: number;
}

/** Opciones normalizadas en el constructor: nunca se conserva la referencia del llamador. */
interface SafeOptions {
  mouseBufferSize: number;
  maxAgeMs: number;
  clickBufferSize: number;
  scrollBufferSize: number;
  keyboardBufferSize: number;
  inputBufferSize: number;
  touchBufferSize: number;
  attentionBufferSize: number;
  device: DeviceProfile;
  now: () => number;
  locale: Locale | "auto";
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function safeBufferSize(value: unknown, fallback: number): number {
  const integer = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return finiteInRange(integer, fallback, 1, MAX_BUFFER_SIZE);
}

/** Idioma válido o `auto`; valores hostiles vuelven al default (fail closed). */
function safeLocale(value: unknown): Locale | "auto" {
  return value === "auto" || LOCALES.includes(value as Locale)
    ? (value as Locale | "auto")
    : "auto";
}

/** Sensibilidad válida o null; valores hostiles vuelven al default (fail closed). */
function safeSensitivity(value: unknown): Sensitivity | null {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value)
    ? (value as Sensitivity)
    : null;
}

/** `false`, `true` y `auto` son válidos; `false` no se confunde con "ausente". */
function safeAccessibility(value: unknown): boolean | "auto" | null {
  return value === false || value === true || value === "auto" ? value : null;
}

/** Perfil detallado forzado válido, o `auto`. */
function safeDetailedDevice(value: unknown): DetailedDevice | "auto" | null {
  return value === "auto" ||
    (typeof value === "string" && DETAILED_DEVICES.includes(value as DetailedDevice))
    ? (value as DetailedDevice | "auto")
    : null;
}

/** EventTarget válido: addEventListener y removeEventListener deben existir. */
function validTarget(value: unknown): value is EventTarget {
  if (!isObjectLike(value)) return false;
  try {
    return (
      typeof (value as unknown as EventTarget).addEventListener === "function" &&
      typeof (value as unknown as EventTarget).removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

function defaultNow(): () => number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
}

export type { LivenessStatus } from "./liveness";
export type LivenessCallback = (status: LivenessStatus) => void;

/** Booleano propio o default. Nunca se aceptan cadenas/hostiles como `true`. */
function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Conjunto de señales habilitadas. Sin opción (o con un valor hostil) se
 * habilitan TODAS para conservar los defaults históricos; con un array se
 * respetan solo los nombres válidos (los inválidos se ignoran).
 */
function safeEnabledSignals(value: unknown): Set<Signal> {
  if (!Array.isArray(value)) return new Set(ALL_SIGNALS);
  const enabled = new Set<Signal>();
  try {
    for (const name of ALL_SIGNALS) {
      if (value.includes(name)) enabled.add(name);
    }
    return enabled;
  } catch {
    return new Set(ALL_SIGNALS);
  }
}

/** Añade nombres válidos al conjunto; un array hostil no altera el estado. */
function addSignals(target: Set<Signal>, values: unknown): void {
  if (!Array.isArray(values)) return;
  try {
    for (const value of values) {
      if ((ALL_SIGNALS as readonly unknown[]).includes(value)) target.add(value as Signal);
    }
  } catch {
    // Array hostil (proxy): se ignoran todas las entradas.
  }
}

/** Quita nombres válidos del conjunto; un array hostil no altera el estado. */
function removeSignals(target: Set<Signal>, values: unknown): void {
  if (!Array.isArray(values)) return;
  try {
    for (const value of values) {
      if ((ALL_SIGNALS as readonly unknown[]).includes(value)) target.delete(value as Signal);
    }
  } catch {
    // Array hostil (proxy): se ignoran todas las entradas.
  }
}

/** Copia plana de señales de replay (el array/objeto interno nunca se expone). */
function copyReplaySignals(value: ReplaySignals): ReplaySignals {
  return {
    repeatedPath: finiteInRange(value?.repeatedPath, 0, 0, 1),
    repeatedTiming: finiteInRange(value?.repeatedTiming, 0, 0, 1),
    identicalSequence: finiteInRange(value?.identicalSequence, 0, 0, 1),
  };
}

/** Copia de la comprobación sorpresa; un módulo hostil no filtra valores raros. */
function copySurpriseCheck(value: SurpriseCheck): SurpriseCheck {
  return {
    passed: typeof value?.passed === "boolean" ? value.passed : true,
    reason: typeof value?.reason === "string" ? value.reason : "",
  };
}

/** Copia profunda del informe de integridad (checks incluidos). */
function copyIntegrityReport(value: IntegrityReport): IntegrityReport {
  const checks = Array.isArray(value?.checks)
    ? value.checks
        .filter((check) => check !== null && typeof check === "object")
        .map((check) => ({
          name: typeof check.name === "string" ? check.name : "",
          ok: check.ok === true,
        }))
    : [];
  return { ok: value?.ok === true, checks };
}

/**
 * Huella EXACTA de una instantánea: coordenadas y tiempos relativos redondeados.
 * Se usa solo para decidir si se añade una razón al veredicto: la similitud
 * normalizada del tracker puede delatar patrones parecidos, pero una razón
 * exige que la trayectoria sea literalmente la misma.
 */
function replayFingerprint(input: ExtendedReplayInput): string {
  const parts: string[] = [];
  const round = (value: number): number => (Number.isFinite(value) ? Math.round(value * 1000) : 0);
  const firstT = input.points[0]?.t ?? 0;
  for (const point of input.points) {
    parts.push(
      `p${round(point.x)},${round(point.y)},${round(point.t - firstT)},${point.kind},${point.pointerType},${point.trusted}`,
    );
  }
  for (const click of input.clicks) {
    parts.push(
      `c${round(click.x)},${round(click.y)},${round(click.t - firstT)},${click.kind},${click.button}`,
    );
  }
  for (const scroll of input.scrolls) {
    parts.push(`s${round(scroll.dx)},${round(scroll.dy)},${scroll.trusted}`);
  }
  for (const key of input.keys) {
    parts.push(`k${round(key.t - firstT)},${key.kind},${key.category}`);
  }
  for (const item of input.inputs) {
    parts.push(`i${round(item.t - firstT)},${item.inputType}`);
  }
  // Señales aditivas: entran en la huella SOLO cuando están habilitadas (sus
  // arrays están vacíos en el comportamiento por defecto).
  for (const touch of input.touches ?? []) {
    parts.push(`to${round(Number(touch?.t ?? 0) - firstT)}`);
  }
  for (const item of input.attention ?? []) {
    parts.push(`at${round(Number(item?.t ?? 0) - firstT)}`);
  }
  return parts.join("|");
}

/** Riesgo de replay = mayor de las tres medidas, siempre finito en [0,1]. */
function replayRisk(signals: ReplaySignals): number {
  return Math.max(
    finiteInRange(signals.repeatedPath, 0, 0, 1),
    finiteInRange(signals.repeatedTiming, 0, 0, 1),
    finiteInRange(signals.identicalSequence, 0, 0, 1),
  );
}

/** Unión probabilística local de la evidencia ya incluidas replay y sorpresa. */
function guardrailOverall(evidence: GuardrailRiskEvidence): number {
  const values = [
    evidence.coherence,
    evidence.injection,
    evidence.humanization,
    evidence.formulaRhythm,
    evidence.declaredVsBehavior,
    evidence.replay,
    evidence.surprise,
  ];
  let complement = 1;
  for (const value of values) {
    complement *= 1 - (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  }
  return Math.min(1, Math.max(0, 1 - complement));
}

/**
 * Semilla entera y determinista derivada SOLO de muestras numéricas de la
 * sesión (FNV-1a sobre tiempos y coordenadas cuantizadas). No es secreta: el
 * código es público; solo evita que un bot aprenda una ponderación fija.
 */
function seedFromSession(samples: PointerSample[], keys: KeySample[]): number {
  let hash = 2166136261;
  const mix = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const quantized = Math.round(value * 1000) | 0;
    hash ^= quantized;
    hash = Math.imul(hash, 16777619);
  };
  for (const sample of samples) {
    mix(sample.t);
    mix(sample.x);
    mix(sample.y);
  }
  for (const key of keys) mix(key.t);
  return hash >>> 0 || 1;
}

export class IsThatAnAI {
  private readonly opts: SafeOptions;
  private readonly now: () => number;
  /** Última marca de reloj válida: fallback para relojes hostiles (NaN/Infinity/throw). */
  private lastGoodTime = 0;
  private readonly buffer: RingBuffer;
  private readonly callbacks = new Set<VerdictCallback>();
  private readonly changeCallbacks = new Set<ChangeCallback>();
  private readonly scoreComputer = new ScoreComputer();
  private config: ResolvedConfig;
  /** Preferencia sin resolver; `auto` se detecta en start(), nunca aquí. */
  private localeOption: Locale | "auto" = "auto";
  /** Idioma efectivo: `en` hasta start() si la preferencia es `auto`. */
  private locale: Locale = "en";
  /** Preset de sensibilidad activo (los umbrales se leen de `config`). */
  private sensitivity: Sensitivity = "normal";
  /** Preferencia de accesibilidad; `auto` se resuelve con el perfil detallado. */
  private accessibilityOption: boolean | "auto" = false;
  /** Valor efectivo enviado al scorer (nunca se lee el DOM fuera de start()). */
  private accessibilityEffective = false;
  private detailedDeviceOption: DetailedDevice | "auto" = "auto";
  private detailedDevice: DetailedDevice = "computadora";
  /** Pistas capturadas en start(); sin DOM son todas neutras. */
  private deviceHints: DeviceHints = { maxTouchPoints: 0, mobile: false, screenWidth: 0 };
  private features: MouseFeatures | null = null;
  private collector: MouseCollector | null = null;
  private clickCollector: ClickCollector | null = null;
  private scrollCollector: ScrollCollector | null = null;
  private keyboardCollector: KeyboardCollector | null = null;
  private textInputCollector: TextInputCollector | null = null;
  /** Colectores aditivos: solo existen si el llamador los habilita con `touch`/`attention`. */
  private touchCollector: SampleCollectorLike | null = null;
  private attentionCollector: SampleCollectorLike | null = null;
  private readonly touchEnabled: boolean;
  private readonly attentionEnabled: boolean;
  private attachedTarget: EventTarget | null = null;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private verdict: Verdict = MEASURING;
  private lastEmittedState: Verdict["state"] = "measuring";
  private lastChangeState: StableBand | null = null;
  private pendingState: Verdict["state"] | null = null;
  private pendingSince = 0;

  // Detector de cambio de controlador (L170): se observa la banda del score,
  // NUNCA se modifica la clasificación ni la histeresis.
  private lastBand: Band = "unknown";
  private bandStreak = 0;
  private lastStableBand: StableBand | null = null;
  private handover: HandoverInfo | null = null;
  /** Evita reentradas desde callbacks y permite abortar emisiones tras un reset(). */
  private evaluating = false;
  private generation = 0;

  // --- Etapa 10: guardarraíles, observabilidad y randomización -------------
  // Todas las añadidas son PRIVADAS o getters aditivos: ni `Verdict`, ni
  // `SignalScores`, ni `getConfig()` cambian de forma enumerable.
  private antiCheat = true;
  private antiCheatWeightJitter = true;
  /** 0 = sin jitter; se fija tras JITTER_SESSION_THRESHOLD evaluaciones. */
  private jitterSeed: number = NO_JITTER_SEED;
  private evaluationCount = 0;
  private readonly notes: string[] = [];
  /** Solo en memoria de la sesión: reset()/stop() lo descartan. */
  private readonly replayTracker = new ReplayTracker();
  /** Último seq entregado por flujo: evita comparar el buffer acumulado consigo mismo. */
  private readonly replaySeq = {
    points: 0,
    clicks: 0,
    scrolls: 0,
    keys: 0,
    inputs: 0,
    touches: 0,
    attention: 0,
  };
  private replaySignals: ReplaySignals = {
    repeatedPath: 0,
    repeatedTiming: 0,
    identicalSequence: 0,
  };
  /** Huellas exactas ya vistas; acotadas para no crecer sin límite. */
  private readonly replayFingerprints = new Set<string>();
  private replayExact = false;
  private surpriseCheck: SurpriseCheck = { passed: true, reason: "" };
  private integrityReport: IntegrityReport = { ok: true, checks: [] };
  private readonly liveness: LivenessMonitor;
  private lastBeatAt = 0;
  private hasBeat = false;
  private currentLiveness: LivenessStatus = "idle";
  private readonly livenessCallbacks = new Set<LivenessCallback>();

  // --- Etapa 11: superficie pública aditiva (no cambia formas existentes) ---
  /** Señales que llegan al scorer; `touch`/`attention` no puntúan hoy. */
  private readonly enabledSignals: Set<Signal>;
  /** `pause()` congela el timer pero NO desengancha los colectores. */
  private paused = false;
  private readonly thresholdCallbacks = new Set<{
    value: number;
    callback: ThresholdCallback;
  }>();
  /** Último score combinado observado, para detectar cruces en ambos sentidos. */
  private lastThresholdScore: number | null = null;
  private debug = false;
  private customEventEnabled = false;

  // --- Checklist final: superficie aditiva (no cambia formas existentes) ---
  /** Modo de privacidad; el `aggregatesOption` es la preferencia declarada. */
  private readonly aggregatesOption: boolean;
  private privacyMode: PrivacyMode;
  /** OPT-IN de medidas finales (default false, preserva la calibración). */
  private advancedMeasures: boolean;
  private touchFeatures: FeatureTable | null = null;
  private attentionFeatures: FeatureTable | null = null;
  /** Pistas capturadas SOLO en start(); sin DOM quedan neutras (SSR-safe). */
  private environmentHints: EnvironmentHintsLike = {
    webdriver: false,
    maxTouchPoints: 0,
    userAgent: "",
    screenWidth: 0,
    screenHeight: 0,
    mobile: false,
  };
  private coherenceDetailed: CoherenceDetailed | null = null;
  private environmentSignals: FeatureTable | null = null;
  /** Calibración en memoria de ESTA sesión; nunca se persiste. */
  private calibration: CalibrationResult | null = null;
  private guardrailTolerances: GuardrailTolerances = { ...DEFAULT_GUARDRAIL_TOLERANCES };

  constructor(options: DetectorOptions = {}) {
    // Normalización defensiva: se leen propiedades propias una sola vez y no se
    // guarda ninguna referencia a objetos del llamador (mutarlos después no afecta).
    const source = isObjectLike(options) ? options : {};
    const mouse = readOwn(source, "mouse");
    const click = readOwn(source, "click");
    const scroll = readOwn(source, "scroll");
    const keyboard = readOwn(source, "keyboard");
    const input = readOwn(source, "input");
    const touchIn = readOwn(source, "touch");
    const attentionIn = readOwn(source, "attention");
    const aggregatesIn = readOwn(source, "aggregatesOnly");
    const advancedIn = readOwn(source, "advancedMeasures");
    const nowFn = readOwn(source, "now");
    const deviceIn = readOwn(source, "device");
    const localeIn = readOwn(source, "locale");
    const sensitivityIn = readOwn(source, "sensitivity");
    const accessibilityIn = readOwn(source, "accessibility");
    const detailedIn = readOwn(source, "detailedDevice");
    const antiCheatIn = readOwn(source, "antiCheat");
    const jitterIn = readOwn(source, "antiCheatWeightJitter");
    const signalsIn = readOwn(source, "signals");
    const debugIn = readOwn(source, "debug");
    const customEventIn = readOwn(source, "customEvent");
    const requestedLocale = safeLocale(localeIn);

    const mouseIsObject = isObjectLike(mouse);

    this.opts = {
      mouseBufferSize: safeBufferSize(
        mouseIsObject ? readOwn(mouse, "bufferSize") : undefined,
        DEFAULT_BUFFER_SIZE,
      ),
      maxAgeMs: finiteInRange(
        mouseIsObject ? readOwn(mouse, "maxAgeMs") : undefined,
        DEFAULT_MAX_AGE_MS,
        0,
        MAX_TIME_MS,
      ),
      clickBufferSize: safeBufferSize(readOwn(click, "bufferSize"), DEFAULT_BUFFER_SIZE),
      scrollBufferSize: safeBufferSize(readOwn(scroll, "bufferSize"), DEFAULT_BUFFER_SIZE),
      keyboardBufferSize: safeBufferSize(readOwn(keyboard, "bufferSize"), DEFAULT_BUFFER_SIZE),
      inputBufferSize: safeBufferSize(readOwn(input, "bufferSize"), DEFAULT_BUFFER_SIZE),
      touchBufferSize: safeBufferSize(readOwn(touchIn, "bufferSize"), DEFAULT_BUFFER_SIZE),
      attentionBufferSize: safeBufferSize(readOwn(attentionIn, "bufferSize"), DEFAULT_BUFFER_SIZE),
      device: DEVICE_PROFILES.includes(deviceIn as DeviceProfile)
        ? (deviceIn as DeviceProfile)
        : "auto",
      now: typeof nowFn === "function" ? (nowFn as () => number) : defaultNow(),
      locale: requestedLocale,
    };
    this.now = this.opts.now;
    this.buffer = new RingBuffer(this.opts.mouseBufferSize);
    // Sin navigator: nunca se detecta aquí. Un idioma forzado sí es conocido
    // desde la construcción; `auto` espera a start() para resolverse.
    this.localeOption = requestedLocale;
    this.locale = requestedLocale === "auto" ? "en" : requestedLocale;

    // Opciones nuevas: solo valores propios y válidos; NUNCA se consulta el DOM
    // aquí (las pistas de dispositivo se capturan en start()).
    const presetName = safeSensitivity(sensitivityIn);
    if (presetName !== null) this.sensitivity = presetName;
    const preset = SENSITIVITY_PRESETS[this.sensitivity];
    const mode = safeAccessibility(accessibilityIn);
    if (mode !== null) this.accessibilityOption = mode;
    const detailed = safeDetailedDevice(detailedIn);
    if (detailed !== null) this.detailedDeviceOption = detailed;
    if (this.detailedDeviceOption !== "auto") this.detailedDevice = this.detailedDeviceOption;
    // `auto` no puede resolverse sin pistas del entorno: espera a start().
    this.accessibilityEffective = this.accessibilityOption === true;
    this.antiCheat = safeBoolean(antiCheatIn, true);
    this.antiCheatWeightJitter = safeBoolean(jitterIn, true);
    this.enabledSignals = safeEnabledSignals(signalsIn);
    this.debug = safeBoolean(debugIn, false);
    this.customEventEnabled = safeBoolean(customEventIn, false);
    // La sola presencia del objeto de opciones habilita el colector: los
    // defaults NO registran listeners nuevos (comportamiento histórico intacto).
    this.touchEnabled = isObjectLike(touchIn);
    this.attentionEnabled = isObjectLike(attentionIn);
    this.aggregatesOption = safeBoolean(aggregatesIn, false);
    this.privacyMode = this.aggregatesOption ? "aggregates" : "full";
    this.advancedMeasures = safeBoolean(advancedIn, false);
    // Etapa 11: `autoStart` es declarativo. El constructor NUNCA consulta el DOM
    // (regla SSR) por lo que no inicia nada: el arranque real vive en el helper
    // `autoStart()` de `src/auto-start.ts`, que comprueba `document` en runtime.
    // El monitor de liveness solo mide tiempo: no consulta DOM al construirse.
    this.liveness = new LivenessMonitor({ intervalMs: DEFAULT_LIVENESS_INTERVAL_MS });
    this.refreshIntegrity();

    const verdictCb = readOwn(source, "onVerdict");
    const changeCb = readOwn(source, "onChange");
    if (typeof verdictCb === "function") this.callbacks.add(verdictCb as VerdictCallback);
    if (typeof changeCb === "function") this.changeCallbacks.add(changeCb as ChangeCallback);

    // Los defaults son exactamente los valores históricos: sin configure(),
    // el comportamiento (scores a 6 decimales incluidos) no cambia.
    // El preset `normal` contiene exactamente los valores históricos: sin
    // opciones nuevas el comportamiento (scores a 6 decimales) no cambia.
    this.config = {
      thresholds: { ...preset.thresholds },
      signalWeights: { ...DEFAULT_SCORING_CONFIG.signalWeights },
      device: this.opts.device,
      combination: "weighted",
      accessibilityProtection: false,
      confirmMs: { ...preset.confirmMs },
      emaAlpha: EMA_ALPHA,
    };
    this.scoreComputer.configure({
      signalWeights: this.config.signalWeights,
      combination: this.config.combination,
      accessibilityProtection: this.config.accessibilityProtection,
      emaAlpha: this.config.emaAlpha,
      accessibilityMode: this.accessibilityEffective,
      antiCheat: this.antiCheat,
      antiCheatWeightJitter: this.antiCheatWeightJitter,
      jitterSeed: this.jitterSeed,
      advancedMeasures: this.advancedMeasures,
    });
  }

  /** Reloj saneado: NUNCA devuelve NaN/Infinity, aunque el inyectado falle. */
  private time(): number {
    let value: unknown;
    try {
      value = this.now();
    } catch {
      return this.lastGoodTime;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      this.lastGoodTime = value;
      return value;
    }
    return this.lastGoodTime;
  }

  private get maxAgeMs(): number {
    return this.opts.maxAgeMs;
  }

  // -------------------------------------------------------------------------
  // Etapa 10 — observabilidad y guardarraíles (todas privadas)
  // -------------------------------------------------------------------------

  /**
   * Verificación de integridad. Una excepción se trata como "sin señal" (no
   * como manipulación) para no convertir un entorno hostil en un falso ataque;
   * un `ok: false` explícito SÍ hace fallar cerrado en `evaluate()`.
   */
  private refreshIntegrity(): void {
    try {
      this.integrityReport = copyIntegrityReport(verifyIntegrity());
    } catch {
      this.integrityReport = { ok: true, checks: [] };
    }
  }

  /** Latido en CADA evaluate(), inclusive cuando no hay evidencia. */
  private beat(now: number): void {
    this.lastBeatAt = now;
    this.hasBeat = true;
    try {
      this.liveness.beat(now);
    } catch {
      // La liveness es solo observabilidad: jamás altera el veredicto.
    }
    this.setLivenessStatus(this.computeLivenessStatus(now));
  }

  /** Estado derivado del monitor; nunca consulta DOM y nunca clasifica. */
  private computeLivenessStatus(now: number): LivenessStatus {
    if (!this.hasBeat) return "idle";
    try {
      return this.liveness.status(now);
    } catch {
      const staleMs = finiteInRange(
        this.liveness.staleMs,
        DEFAULT_LIVENESS_INTERVAL_MS,
        0,
        MAX_TIME_MS,
      );
      return now - this.lastBeatAt > staleMs ? "stale" : "live";
    }
  }

  private setLivenessStatus(status: LivenessStatus): void {
    if (status === this.currentLiveness) return;
    this.currentLiveness = status;
    for (const callback of [...this.livenessCallbacks]) {
      if (!this.livenessCallbacks.has(callback)) continue;
      try {
        callback(status);
      } catch {
        // Un callback hostil no rompe a los demás.
      }
    }
  }

  /** Entrega el snapshot al tracker; SOLO memoria de esta sesión. */
  private updateReplay(input: ExtendedReplayInput): void {
    try {
      this.replayTracker.push(input);
      this.replaySignals = copyReplaySignals(this.replayTracker.signals());
      const fingerprint = replayFingerprint(input);
      if (fingerprint.length > 0 && this.replayFingerprints.has(fingerprint)) {
        this.replayExact = true;
      } else if (fingerprint.length > 0) {
        this.replayFingerprints.add(fingerprint);
        if (this.replayFingerprints.size > 32) {
          const oldest = this.replayFingerprints.values().next().value;
          if (oldest !== undefined) this.replayFingerprints.delete(oldest);
        }
      }
    } catch {
      // Sin señal de replay no se inventa evidencia.
    }
  }

  /** Comprobación sorpresa sobre los scores/evidencia de esta evaluación. */
  private updateSurprise(scores: SignalScores): void {
    try {
      this.surpriseCheck = copySurpriseCheck(
        surpriseCoherenceCheck({
          mouseScore: scores.mouse,
          keyboardScore: scores.keyboard,
          clickScore: scores.click,
          scrollScore: scores.scroll,
          mouseEvidence: scores.mouse !== null,
          keyboardEvidence: scores.keyboard !== null,
          clickEvidence: scores.click !== null,
          scrollEvidence: scores.scroll !== null,
        }),
      );
    } catch {
      this.surpriseCheck = { passed: true, reason: "" };
    }
  }

  /** Medidas detalladas de coherencia (L137-L144), 100% aditivas. */
  private updateCoherenceDetailed(
    samples: PointerSample[],
    clicks: ClickSample[],
    scrolls: ScrollSample[],
    keys: KeySample[],
    inputs: InputSample[],
  ): void {
    try {
      const result = evaluateCoherenceDetailed({
        points: samples,
        clicks,
        scrolls,
        keys,
        inputs,
      });
      const out: Record<string, number> = {};
      for (const key of Object.keys(result as object)) {
        const value = (result as unknown as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) out[key] = clamp(value, 0, 1);
      }
      this.coherenceDetailed = out as unknown as CoherenceDetailed;
    } catch {
      this.coherenceDetailed = null;
    }
  }

  /**
   * Jitter de pesos SOLO tras N evaluaciones con evidencia. Así las sesiones
   * calibradas (pocas evaluaciones) conservan sus scores de 6 decimales.
   */
  private maybeApplyJitter(samples: PointerSample[], keys: KeySample[]): void {
    if (!this.antiCheatWeightJitter) return;
    this.evaluationCount += 1;
    if (this.evaluationCount < JITTER_SESSION_THRESHOLD) return;
    if (this.jitterSeed !== NO_JITTER_SEED) return;
    this.jitterSeed = seedFromSession(samples, keys);
    this.scoreComputer.configure({ jitterSeed: this.jitterSeed });
    this.notes.push("Pesos aleatorizados por semilla de sesión (determinista)");
  }

  /** Propaga la configuración anti-trampas al scorer sin tocar `getConfig()`. */
  private syncAntiCheat(): void {
    this.scoreComputer.configure({
      antiCheat: this.antiCheat,
      antiCheatWeightJitter: this.antiCheatWeightJitter,
      jitterSeed: this.jitterSeed,
    });
  }

  /**
   * Perfil forzado por configuración, o inferido de las mismas muestras numéricas
   * que se entregan al scorer. Sin datos, la inferencia es `desktop` (fail-closed:
   * ningún atajo de scoring sin evidencia de mando).
   */
  private resolveDeviceProfile(
    samples: PointerSample[],
    keys: KeySample[],
    inputs: InputSample[],
  ): ResolvedDeviceProfile {
    const forced = this.config.device;
    return forced === "auto" ? inferDeviceProfile(samples, keys, inputs) : forced;
  }

  /** Perfil activo: el configurado/forzado o el inferido de las muestras. */
  getDeviceProfile(): DeviceProfile {
    if (!this.collector) {
      return this.resolveDeviceProfile([], [], []);
    }
    const cutoff = this.time() - this.maxAgeMs;
    this.buffer.discardOldestBefore(cutoff);
    this.keyboardCollector?.discardOldestBefore(cutoff);
    this.textInputCollector?.discardOldestBefore(cutoff);
    return this.resolveDeviceProfile(
      this.buffer.snapshot(),
      this.keyboardCollector?.getSamples() ?? [],
      this.textInputCollector?.getSamples() ?? [],
    );
  }

  /**
   * Único punto donde se leen pistas del entorno. Se llama desde `start()`,
   * nunca al importar ni en el constructor. Globals hostiles/getters que lanzan
   * dejan todas las pistas en su valor neutro (fail closed, SSR-safe).
   */
  private captureDeviceHints(): void {
    let maxTouchPoints = 0;
    let mobile = false;
    let screenWidth = 0;
    try {
      const globals = globalThis as {
        navigator?: {
          maxTouchPoints?: unknown;
          userAgentData?: { mobile?: unknown } | null;
          userAgent?: unknown;
          webdriver?: unknown;
        };
        screen?: { width?: unknown; height?: unknown } | null;
      };
      const nav = globals.navigator;
      if (nav && typeof nav === "object") {
        const points = nav.maxTouchPoints;
        if (typeof points === "number" && Number.isFinite(points) && points >= 0) {
          maxTouchPoints = points;
        }
        const hintsData = nav.userAgentData;
        if (hintsData && typeof hintsData === "object" && typeof hintsData.mobile === "boolean") {
          mobile = hintsData.mobile;
        } else if (typeof nav.userAgent === "string") {
          mobile = /android|iphone|ipad|ipod|mobile/i.test(nav.userAgent);
        }
      }
      const screen = globals.screen;
      if (screen && typeof screen === "object") {
        const width = screen.width;
        if (typeof width === "number" && Number.isFinite(width) && width > 0) screenWidth = width;
      }
    } catch {
      // Entorno hostil: se conservan los valores neutros.
    }
    this.deviceHints = { maxTouchPoints, mobile, screenWidth };
    // Pistas débiles del entorno: se capturan AQUÍ, nunca al importar/construir.
    // Un getter hostil deja el valor neutro (fail closed).
    let webdriver = false;
    let userAgent = "";
    let screenHeight = 0;
    try {
      const globals = globalThis as {
        navigator?: { webdriver?: unknown; userAgent?: unknown };
        screen?: { height?: unknown } | null;
      };
      const nav = globals.navigator;
      if (nav && typeof nav === "object") {
        webdriver = nav.webdriver === true || nav.webdriver === 1;
        if (typeof nav.userAgent === "string") userAgent = nav.userAgent.slice(0, 512);
      }
      const screen = globals.screen;
      if (screen && typeof screen === "object") {
        const height = screen.height;
        if (typeof height === "number" && Number.isFinite(height) && height > 0) {
          screenHeight = height;
        }
      }
    } catch {
      // Entorno hostil: se conservan los neutros.
    }
    this.environmentHints = {
      webdriver,
      maxTouchPoints,
      userAgent,
      screenWidth,
      screenHeight,
      mobile,
    };
    // Las señales se calculan en evaluate() con las muestras de esa sesión;
    // aquí solo se capturan las pistas (nunca se puntúa fuera de evaluate()).
  }

  /** Perfil detallado forzado, o inferido de muestras + pistas ya capturadas. */
  private resolveDetailedDevice(
    samples: PointerSample[] = [],
    keys: KeySample[] = [],
    inputs: InputSample[] = [],
  ): DetailedDevice {
    if (this.detailedDeviceOption !== "auto") return this.detailedDeviceOption;
    return inferDetailedDevice(samples, keys, inputs, this.deviceHints);
  }

  /**
   * El modo accesibilidad `auto` se activa solo con perfil táctil o TV; con
   * `true` va siempre, con `false` nunca. El cambio se propaga al scorer.
   */
  private syncAccessibility(): void {
    const byProfile =
      this.detailedDevice === "celular" ||
      this.detailedDevice === "tablet" ||
      this.detailedDevice === "touch" ||
      this.detailedDevice === "tv";
    // Con muestras de mouse en un móvil el detalle puede decir `laptop`; las
    // pistas capturadas en start() siguen siendo prueba de ausencia de mouse.
    const byHints =
      this.detailedDeviceOption === "auto" &&
      (this.deviceHints.maxTouchPoints > 0 || this.deviceHints.mobile);
    const touchLike = byProfile || byHints;
    const effective =
      this.accessibilityOption === true || (this.accessibilityOption === "auto" && touchLike);
    if (effective === this.accessibilityEffective) return;
    this.accessibilityEffective = effective;
    this.scoreComputer.configure({ accessibilityMode: effective });
  }

  // -------------------------------------------------------------------------
  // Configuración y estado
  // -------------------------------------------------------------------------

  /**
   * Fusiona opciones parciales con la configuración activa. Los campos que no
   * se envían se conservan; llamar sin argumentos deja todo igual.
   */
  configure(config: DetectorConfig = {}): void {
    if (!isObjectLike(config)) return;
    // Una sola lectura por campo, solo propiedades propias: ni null/proxies ni
    // prototipos envenenados pueden lanzar o colar valores heredados.
    const thresholdsIn = readOwn(config, "thresholds");
    const weightsIn = readOwn(config, "signalWeights");
    const deviceIn = readOwn(config, "device");
    const combinationIn = readOwn(config, "combination");
    const accessibilityIn = readOwn(config, "accessibilityProtection");
    const confirmIn = readOwn(config, "confirmMs");
    const emaIn = readOwn(config, "emaAlpha");
    const localeIn = readOwn(config, "locale");
    const sensitivityIn = readOwn(config, "sensitivity");
    const accessibilityModeIn = readOwn(config, "accessibility");
    const detailedIn = readOwn(config, "detailedDevice");
    const antiCheatIn = readOwn(config, "antiCheat");
    const jitterIn = readOwn(config, "antiCheatWeightJitter");
    const advancedIn = readOwn(config, "advancedMeasures");

    // El preset se aplica PRIMERO: los valores explícitos de esta misma llamada
    // lo sobrescriben campo por campo (si el preset era inválido, se ignora).
    const presetName = safeSensitivity(sensitivityIn);
    let safeThresholds = { humanMax: HUMAN_MAX, aiMin: AI_MIN };
    let fallbackConfirm = { human: HUMAN_CONFIRM_MS, ai: AI_CONFIRM_MS };
    if (presetName !== null) {
      this.sensitivity = presetName;
      const preset = SENSITIVITY_PRESETS[presetName];
      safeThresholds = { ...preset.thresholds };
      fallbackConfirm = { ...preset.confirmMs };
      this.config.thresholds = { ...safeThresholds };
      this.config.confirmMs = { ...fallbackConfirm };
    }
    // Sin preset, los fallbacks son los valores vigentes antes de la llamada.
    const fallbackThresholds = presetName !== null ? safeThresholds : this.config.thresholds;
    const confirmFallback = presetName !== null ? fallbackConfirm : this.config.confirmMs;

    if (isObjectLike(thresholdsIn)) {
      const humanMax = finiteInRange(
        readOwn(thresholdsIn, "humanMax"),
        fallbackThresholds.humanMax,
        0,
        1,
      );
      const aiMin = finiteInRange(readOwn(thresholdsIn, "aiMin"), fallbackThresholds.aiMin, 0, 1);
      // Bandas solapadas (humanMax >= aiMin) clasificarían todo como "humano":
      // configuración inválida -> default seguro / preset recién aplicado.
      this.config.thresholds = humanMax < aiMin ? { humanMax, aiMin } : { ...safeThresholds };
    }
    if (isObjectLike(weightsIn)) {
      const weights = { ...this.config.signalWeights };
      for (const key of SCORED_SIGNALS) {
        const raw = readOwn(weightsIn, key);
        if (raw !== undefined) weights[key] = finiteInRange(raw, weights[key], 0, 1);
      }
      this.config.signalWeights = weights;
    }
    if (DEVICE_PROFILES.includes(deviceIn as DeviceProfile)) {
      this.config.device = deviceIn as DeviceProfile;
    }
    if (combinationIn === "weighted" || combinationIn === "adaptive") {
      this.config.combination = combinationIn;
    }
    if (typeof accessibilityIn === "boolean") {
      this.config.accessibilityProtection = accessibilityIn;
    }
    if (isObjectLike(confirmIn)) {
      // 0 ms eliminaría la histeresis y confirmaría "humano" en la primera
      // evaluación: se exige al menos 1 ms y, si no, se conserva el default.
      this.config.confirmMs = {
        human: finiteInRange(readOwn(confirmIn, "human"), confirmFallback.human, 1, MAX_TIME_MS),
        ai: finiteInRange(readOwn(confirmIn, "ai"), confirmFallback.ai, 1, MAX_TIME_MS),
      };
    }
    if (emaIn !== undefined) {
      this.config.emaAlpha = finiteInRange(emaIn, this.config.emaAlpha, 0, 1);
    }
    if (localeIn !== undefined) {
      const requested = safeLocale(localeIn);
      this.localeOption = requested;
      // Un idioma forzado aplica de inmediato; `auto` se resuelve en start().
      if (requested !== "auto") this.locale = requested;
    }
    const accessibilityMode = safeAccessibility(accessibilityModeIn);
    if (accessibilityMode !== null) this.accessibilityOption = accessibilityMode;
    const forcedDetail = safeDetailedDevice(detailedIn);
    if (forcedDetail !== null) this.detailedDeviceOption = forcedDetail;
    if (this.detailedDeviceOption !== "auto") this.detailedDevice = this.detailedDeviceOption;
    this.antiCheat = safeBoolean(antiCheatIn, this.antiCheat);
    this.antiCheatWeightJitter = safeBoolean(jitterIn, this.antiCheatWeightJitter);
    if (typeof advancedIn === "boolean") this.advancedMeasures = advancedIn;
    this.syncAccessibility();

    // Siempre se entregan copias: el scorer nunca comparte objetos del llamador.
    this.scoreComputer.configure({
      signalWeights: { ...this.config.signalWeights },
      combination: this.config.combination,
      accessibilityProtection: this.config.accessibilityProtection,
      emaAlpha: this.config.emaAlpha,
      accessibilityMode: this.accessibilityEffective,
      advancedMeasures: this.advancedMeasures,
    });
    this.syncAntiCheat();
  }

  /** Copia de la configuración activa, apta para inspección sin mutar el estado. */
  getConfig(): DetectorConfig {
    return {
      thresholds: { ...this.config.thresholds },
      signalWeights: { ...this.config.signalWeights },
      device: this.config.device,
      combination: this.config.combination,
      accessibilityProtection: this.config.accessibilityProtection,
      confirmMs: { ...this.config.confirmMs },
      emaAlpha: this.config.emaAlpha,
    };
  }

  /** Borra EMA, señales, buffers, veredicto, histeresis y detección de handover. */
  private clearState(): void {
    // Invalida cualquier dispatch de callbacks en curso (reset/stop desde callback).
    this.generation += 1;
    this.scoreComputer.reset();
    this.features = null;
    this.touchFeatures = null;
    this.attentionFeatures = null;
    this.coherenceDetailed = null;
    this.environmentSignals = null;
    // La calibración SOLO vive en memoria de esta sesión.
    this.calibration = null;
    this.guardrailTolerances = { ...DEFAULT_GUARDRAIL_TOLERANCES };
    this.buffer.clear();
    this.verdict = MEASURING;
    // Nueva sesión: el próximo score numérico vuelve a contar como cruce.
    this.lastThresholdScore = null;
    this.lastEmittedState = "measuring";
    this.lastChangeState = null;
    this.pendingState = null;
    this.pendingSince = 0;
    this.lastBand = "unknown";
    this.bandStreak = 0;
    this.lastStableBand = null;
    this.handover = null;
    // Etapa 10: la repetición SOLO existe dentro de esta sesión en memoria.
    this.replayTracker.reset();
    this.replayFingerprints.clear();
    this.replayExact = false;
    this.replaySeq.points = 0;
    this.replaySeq.clicks = 0;
    this.replaySeq.scrolls = 0;
    this.replaySeq.keys = 0;
    this.replaySeq.inputs = 0;
    this.replaySeq.touches = 0;
    this.replaySeq.attention = 0;
    this.replaySignals = { repeatedPath: 0, repeatedTiming: 0, identicalSequence: 0 };
    this.surpriseCheck = { passed: true, reason: "" };
    this.notes.length = 0;
    this.evaluationCount = 0;
    this.jitterSeed = NO_JITTER_SEED;
    this.syncAntiCheat();
    this.refreshIntegrity();
    this.hasBeat = false;
    this.lastBeatAt = 0;
    this.setLivenessStatus("idle");
    // El perfil detallado no depende del scoring: vuelve al que dan las pistas
    // ya capturadas (o al forzado), sin volver a tocar el DOM.
    this.detailedDevice = this.resolveDetailedDevice();
    this.syncAccessibility();
  }

  /**
   * Vuelve al estado inicial SIN dejar de escuchar: limpia todos los buffers
   * (incluidos los de los colectores) y reinicia el scoring y la histeresis.
   */
  reset(): void {
    this.clickCollector?.clear();
    this.scrollCollector?.clear();
    this.keyboardCollector?.clear();
    this.textInputCollector?.clear();
    this.touchCollector?.clear();
    this.attentionCollector?.clear();
    this.clearState();
  }

  // -------------------------------------------------------------------------
  // Colectores y ciclo de vida
  // -------------------------------------------------------------------------

  private ensureCollectors(target: EventTarget, inputTarget: EventTarget): void {
    if (
      !this.collector ||
      !this.clickCollector ||
      !this.scrollCollector ||
      !this.keyboardCollector ||
      !this.textInputCollector
    ) {
      // `window`/`document` se consultan aquí, nunca en el constructor ni al
      // importar. Teclado y mutaciones de texto se registran en `document`
      // (donde burbujean); sin DOM se usa un EventTarget desechable.
      if (!this.collector) {
        this.collector = createMouseCollector({ target, now: this.now, buffer: this.buffer });
      }
      if (!this.clickCollector) {
        this.clickCollector = createClickCollector({
          target,
          now: this.now,
          bufferSize: this.opts.clickBufferSize,
        });
      }
      if (!this.scrollCollector) {
        this.scrollCollector = createScrollCollector({
          target,
          now: this.now,
          bufferSize: this.opts.scrollBufferSize,
        });
      }
      if (!this.keyboardCollector) {
        this.keyboardCollector = createKeyboardCollector({
          target: inputTarget,
          now: this.now,
          bufferSize: this.opts.keyboardBufferSize,
        });
      }
      if (!this.textInputCollector) {
        this.textInputCollector = createTextInputCollector({
          target: inputTarget,
          now: this.now,
          bufferSize: this.opts.inputBufferSize,
        });
      }
    }
    // Aditivos: se crean SOLO si se habilitaron. Se enganchan al mismo target
    // de entrada (documento real; EventTarget desechable en SSR/tests).
    if (this.touchEnabled && !this.touchCollector) {
      this.touchCollector = createSampleCollector(touchCollectorModule, "createTouchCollector", {
        target: inputTarget,
        now: this.now,
        bufferSize: this.opts.touchBufferSize,
      });
    }
    if (this.attentionEnabled && !this.attentionCollector) {
      this.attentionCollector = createSampleCollector(
        attentionCollectorModule,
        "createAttentionCollector",
        { target: inputTarget, now: this.now, bufferSize: this.opts.attentionBufferSize },
      );
    }
  }

  private attachCollectors(): void {
    this.collector?.attach();
    this.clickCollector?.attach();
    this.scrollCollector?.attach();
    this.keyboardCollector?.attach();
    this.textInputCollector?.attach();
    this.touchCollector?.attach();
    this.attentionCollector?.attach();
  }

  private detachCollectors(clearBuffers: boolean): void {
    this.collector?.detach();
    this.collector = null;
    this.clickCollector?.detach();
    if (clearBuffers) this.clickCollector?.clear();
    this.clickCollector = null;
    this.scrollCollector?.detach();
    if (clearBuffers) this.scrollCollector?.clear();
    this.scrollCollector = null;
    this.keyboardCollector?.detach();
    if (clearBuffers) this.keyboardCollector?.clear();
    this.keyboardCollector = null;
    this.textInputCollector?.detach();
    if (clearBuffers) this.textInputCollector?.clear();
    this.textInputCollector = null;
    this.touchCollector?.detach();
    if (clearBuffers) this.touchCollector?.clear();
    this.touchCollector = null;
    this.attentionCollector?.detach();
    if (clearBuffers) this.attentionCollector?.clear();
    this.attentionCollector = null;
  }

  start(): void {
    if (this.started) return;
    // Único punto donde se detecta el idioma del sistema: en tiempo de ejecución,
    // nunca al importar ni en el constructor (SSR-safe).
    this.locale = this.localeOption === "auto" ? detectLocale() : this.localeOption;
    // Perfil detallado y accesibilidad `auto`: SOLO aquí se consulta el entorno.
    this.captureDeviceHints();
    // Privacidad: la preferencia explícita O "No rastrear" del navegador.
    // `doNotTrack()` se invoca AQUÍ, nunca al importar ni en el constructor.
    let dnt = false;
    try {
      dnt = doNotTrack() === true;
    } catch {
      dnt = false;
    }
    this.privacyMode = this.aggregatesOption || dnt ? "aggregates" : "full";
    this.detailedDevice = this.resolveDetailedDevice();
    this.syncAccessibility();
    const rawTarget: unknown =
      this.attachedTarget ?? (typeof window !== "undefined" ? window : new EventTarget());
    const rawInput: unknown =
      this.attachedTarget ?? (typeof document !== "undefined" ? document : new EventTarget());
    // Globals hostiles (sin removeEventListener) no deben romper stop().
    const target: EventTarget = validTarget(rawTarget) ? rawTarget : new EventTarget();
    const inputTarget: EventTarget = validTarget(rawInput) ? rawInput : new EventTarget();
    this.ensureCollectors(target, inputTarget);
    this.attachCollectors();
    this.started = true;
    // Pausado = colectores adjuntos, pero sin loop de evaluación.
    if (!this.paused && this.timer === null) {
      this.timer = setInterval(() => this.evaluate(), EVALUATION_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachCollectors(true);
    this.started = false;
    // `stop()` es un apagado completo: un posterior `start()` arranca el timer
    // aunque la sesión anterior hubiera quedado pausada.
    this.paused = false;
    this.clearState();
  }

  // -------------------------------------------------------------------------
  // Etapa 11 — pausa / reanudación
  // -------------------------------------------------------------------------

  /**
   * Detiene SOLO el timer de evaluación (100 ms). Los colectores siguen
   * adjuntos y acumulando muestras; `evaluate()` tampoco emite mientras esté
   * pausado. Idempotente: llamarlo dos veces no cambia nada.
   */
  pause(): void {
    this.paused = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reanuda el timer si el detector estaba started; si no, solo cambia el estado. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.started && this.timer === null) {
      this.timer = setInterval(() => this.evaluate(), EVALUATION_INTERVAL_MS);
    }
  }

  getPaused(): boolean {
    return this.paused;
  }

  /**
   * Limita la vigilancia a un elemento concreto (p. ej. un formulario). Con un
   * `EventTarget` inyectado no se toca `window`/`document`: es SSR-safe.
   * Si ya estaba escuchando, se desenganchan primero los listeners antiguos;
   * al cambiar de target los buffers se reinician (empieza una sesión nueva).
   */
  attachTo(element: EventTarget): void {
    if (!validTarget(element)) {
      throw new TypeError("attachTo espera un EventTarget");
    }
    if (element === this.attachedTarget) return;
    const wasStarted = this.started;
    if (wasStarted) {
      this.detachCollectors(true);
      this.clearState();
    }
    this.attachedTarget = element;
    if (wasStarted) {
      this.ensureCollectors(element, element);
      this.attachCollectors();
    }
  }

  /**
   * Evalúa el scorer sobre el buffer actual y actualiza el veredicto.
   * Publico para tests; el loop real corre cada EVALUATION_INTERVAL_MS.
   */
  evaluate(): void {
    // Pausado => ni el timer ni una llamada manual pueden emitir veredictos.
    if (this.paused || !this.collector || this.evaluating) return;
    this.evaluating = true;
    const generation = this.generation;
    // Etapa 10: latido en TODA evaluación (incluso sin evidencia) y verificación
    // de integridad. Ninguno de los dos otorga confianza por sí solo.
    this.beat(this.time());
    this.refreshIntegrity();
    try {
      const cutoff = this.time() - this.maxAgeMs;
      this.buffer.discardOldestBefore(cutoff);
      this.clickCollector?.discardOldestBefore(cutoff);
      this.scrollCollector?.discardOldestBefore(cutoff);
      this.keyboardCollector?.discardOldestBefore(cutoff);
      this.textInputCollector?.discardOldestBefore(cutoff);
      this.touchCollector?.discardOldestBefore?.(cutoff);
      this.attentionCollector?.discardOldestBefore?.(cutoff);

      const samples = this.buffer.snapshot();
      const clicks = this.clickCollector?.getSamples() ?? [];
      const scrolls = this.scrollCollector?.getSamples() ?? [];
      const keys = this.keyboardCollector?.getSamples() ?? [];
      const inputs = this.textInputCollector?.getSamples() ?? [];
      const touches: TimedSampleLike[] = this.touchEnabled
        ? (this.touchCollector?.getSamples() ?? [])
        : [];
      const attention: TimedSampleLike[] = this.attentionEnabled
        ? (this.attentionCollector?.getSamples() ?? [])
        : [];
      // Etapa 11: una señal desactivada NO llega al scorer. Se entregan arrays
      // vacíos, de modo que queda fuera de la combinación, de la confianza y de
      // las razones. Los colectores siguen adjuntos: solo se filtra aquí.
      const mouseOn = this.enabledSignals.has("mouse");
      const keyboardOn = this.enabledSignals.has("keyboard");
      const scoredSamples = mouseOn ? samples : [];
      const scoredClicks = this.enabledSignals.has("click") ? clicks : [];
      const scoredScrolls = this.enabledSignals.has("scroll") ? scrolls : [];
      const scoredKeys = keyboardOn ? keys : [];
      const scoredInputs = keyboardOn ? inputs : [];
      // Replay SOLO dentro de esta sesión en memoria: se alimenta con las
      // muestras NUEVAS de cada evaluación (no con el buffer acumulado, que se
      // compararía consigo mismo) y se descarta en reset()/stop()/attachTo().
      const fresh: ExtendedReplayInput = {
        points: samples.filter((s) => Number.isFinite(s.seq) && s.seq > this.replaySeq.points),
        clicks: clicks.filter((s) => Number.isFinite(s.seq) && s.seq > this.replaySeq.clicks),
        scrolls: scrolls.filter((s) => Number.isFinite(s.seq) && s.seq > this.replaySeq.scrolls),
        keys: keys.filter((s) => Number.isFinite(s.seq) && s.seq > this.replaySeq.keys),
        inputs: inputs.filter((s) => Number.isFinite(s.seq) && s.seq > this.replaySeq.inputs),
        touches: touches.filter((s) => finiteSeq(s.seq) && s.seq > this.replaySeq.touches),
        attention: attention.filter((s) => finiteSeq(s.seq) && s.seq > this.replaySeq.attention),
      };
      for (const sample of samples) {
        if (Number.isFinite(sample.seq))
          this.replaySeq.points = Math.max(this.replaySeq.points, sample.seq);
      }
      for (const sample of clicks) {
        if (Number.isFinite(sample.seq))
          this.replaySeq.clicks = Math.max(this.replaySeq.clicks, sample.seq);
      }
      for (const sample of scrolls) {
        if (Number.isFinite(sample.seq))
          this.replaySeq.scrolls = Math.max(this.replaySeq.scrolls, sample.seq);
      }
      for (const sample of keys) {
        if (Number.isFinite(sample.seq))
          this.replaySeq.keys = Math.max(this.replaySeq.keys, sample.seq);
      }
      for (const sample of inputs) {
        if (Number.isFinite(sample.seq))
          this.replaySeq.inputs = Math.max(this.replaySeq.inputs, sample.seq);
      }
      for (const sample of touches) {
        if (finiteSeq(sample.seq))
          this.replaySeq.touches = Math.max(this.replaySeq.touches, sample.seq);
      }
      for (const sample of attention) {
        if (finiteSeq(sample.seq))
          this.replaySeq.attention = Math.max(this.replaySeq.attention, sample.seq);
      }
      if (
        fresh.points.length > 0 ||
        fresh.clicks.length > 0 ||
        fresh.scrolls.length > 0 ||
        fresh.keys.length > 0 ||
        fresh.inputs.length > 0 ||
        (fresh.touches?.length ?? 0) > 0 ||
        (fresh.attention?.length ?? 0) > 0
      ) {
        this.updateReplay(fresh);
      }
      // Checklist final: medidas aditivas. Se calculan ANTES del retorno sin
      // muestras base para que touch/atención solas también las expongan.
      // NINGUNA entra en `score`/`state`: solo getters y `riskEvidence`.
      this.updateCoherenceDetailed(samples, clicks, scrolls, keys, inputs);
      this.environmentSignals = safeEnvironmentSignals(
        samples,
        clicks,
        scrolls,
        keys,
        inputs,
        this.environmentHints,
      );
      this.touchFeatures = this.touchEnabled
        ? safeFeatureTable(touchFeatureModule, "extractTouchFeatures", touches)
        : null;
      this.attentionFeatures = this.attentionEnabled
        ? safeFeatureTable(attentionFeatureModule, "extractAttentionFeatures", attention)
        : null;
      if (
        samples.length === 0 &&
        clicks.length === 0 &&
        scrolls.length === 0 &&
        keys.length === 0 &&
        inputs.length === 0
      ) {
        // Sin muestras el score combinado es null: también es un cruce.
        const previous = this.lastThresholdScore;
        this.lastThresholdScore = null;
        this.emitThreshold(previous, null, generation);
        return;
      }

      // La ventana de mouse se mantiene igual; las ventanas de click/scroll/teclado
      // se derivan de sus propias muestras dentro del ScoreComputer.
      const rawWindow = samples.length >= 2 ? samples[samples.length - 1].t - samples[0].t : 0;
      const windowMs = Number.isFinite(rawWindow) ? rawWindow : 0;
      const device = this.resolveDeviceProfile(samples, keys, inputs);
      // El detalle se afina con las muestras numéricas de esta evaluación y
      // puede activar la accesibilidad `auto` antes de puntuar.
      this.detailedDevice = this.resolveDetailedDevice(samples, keys, inputs);
      this.syncAccessibility();
      const evidence = this.scoreComputer.evaluate(
        scoredSamples,
        windowMs,
        scoredClicks,
        scoredScrolls,
        scoredKeys,
        scoredInputs,
        device,
        this.advancedMeasures ? touches : [],
        this.advancedMeasures ? attention : [],
      );
      // Un score no finito se trata como ausencia de evidencia (fail closed).
      const score =
        evidence.score === null || !Number.isFinite(evidence.score)
          ? null
          : clamp(evidence.score, 0, 1);
      // Reutiliza las medidas que el scorer acaba de calcular. Con el mouse
      // desactivado no se exponen features de esa señal.
      this.features =
        !mouseOn || score === null
          ? null
          : (this.scoreComputer.getMouseFeatures() ?? extractMouseFeatures(scoredSamples));
      const rawLatest = Math.max(
        samples.length > 0 ? samples[samples.length - 1].t : 0,
        clicks.length > 0 ? clicks[clicks.length - 1].t : 0,
        scrolls.length > 0 ? scrolls[scrolls.length - 1].t : 0,
        keys.length > 0 ? keys[keys.length - 1].t : 0,
        inputs.length > 0 ? inputs[inputs.length - 1].t : 0,
      );
      const latestT = Number.isFinite(rawLatest) ? rawLatest : 0;
      // Etapa 10: sorpresa y jitter sobre la evidencia recién calculada. Ninguno
      // de los dos cambia un veredicto limpio ni los scores calibrados.
      this.updateSurprise(this.scoreComputer.getSignalScores());
      if (this.antiCheat) this.maybeApplyJitter(scoredSamples, scoredKeys);
      const replay = replayRisk(this.replaySignals);
      const integrityOk = this.integrityReport.ok;
      const reasons = [...evidence.reasons];
      if (this.antiCheat && this.replayExact && replay >= REPLAY_REASON_THRESHOLD) {
        reasons.push(REPLAY_REASON);
      }
      // FAIL CLOSED: una integridad rota NUNCA puede otorgar "humano".
      if (!integrityOk) reasons.push(INTEGRITY_REASON);

      const state = this.classify(score, latestT);
      const finalScore: number | null = integrityOk ? score : null;
      const finalState: Verdict["state"] = integrityOk ? state : "measuring";
      this.trackHandover(finalScore, latestT);
      // score null solo cuando no hay evidencia suficiente (o hay manipulación);
      // con evidencia se conserva el score real y se recalcula la duda.
      this.verdict =
        finalScore === null
          ? {
              state: "measuring",
              score: null,
              confidence: 0,
              doubt: 1,
              reasons: integrityOk ? [] : translateReasons(reasons, this.locale),
            }
          : {
              state: finalState,
              score: finalScore,
              confidence: finiteInRange(evidence.confidence, 0, 0, 1),
              doubt: doubtFor(finalState, finalScore, this.config.thresholds),
              // Las razones se guardan ya traducidas: callbacks, getVerdict()
              // y getReasons() ven todos la misma copia localizada.
              reasons: translateReasons(reasons, this.locale),
            };
      // Etapa 11: debug SOLO aquí (nunca al importar/constructor) y cruce de
      // umbral en TODA evaluación, no solo cuando cambia el estado confirmado.
      this.debugLog(finalState, finalScore, this.verdict.confidence);
      const previousScore = this.lastThresholdScore;
      this.lastThresholdScore = finalScore;
      this.emitThreshold(previousScore, finalScore, generation);
      if (finalState !== this.lastEmittedState) {
        this.lastEmittedState = finalState;
        // Copia: los callbacks no pueden mutar el estado interno.
        const verdict: Verdict = {
          state: this.verdict.state,
          score: this.verdict.score,
          confidence: this.verdict.confidence,
          doubt: this.verdict.doubt,
          reasons: [...this.verdict.reasons],
        };
        for (const callback of [...this.callbacks]) {
          if (this.generation !== generation) break;
          // Si se dio de baja durante el dispatch, no se le llama.
          if (!this.callbacks.has(callback)) continue;
          try {
            callback(verdict);
          } catch {
            // Un callback hostil no rompe a los demás ni la máquina de estados.
          }
        }
        // CustomEvent solo en runtime (document se resuelve AQUÍ, nunca al
        // importar). Un reset/stop desde un callback cancela el despacho.
        if (this.generation === generation) this.dispatchCustomEvent(verdict);
      }
      // reset()/stop() desde un callback invalida el cambio pendiente.
      if (this.generation === generation) this.emitChange(finalState, generation);
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Histeresis con confirmación por tiempo de muestra. Decide SOLO `state`:
   * - score <= humanMax -> human; score >= aiMin -> ai.
   * - Banda intermedia: se mantiene el estado anterior; si se venía de
   *   measuring se decide human (beneficio de la duda).
   * - Salir de ai a human con score <= humanMax es más fácil (250 ms) que
   *   entrar en ai desde human (AI_CONFIRM_MS = 600 ms).
   * La duda NO interviene: se recalcula en evaluate() con doubtFor(state, score)
   * en cada evaluación, sin tocar pendingState ni emitir onVerdict.
   * El reloj son los timeStamp de las muestras, no el de pared.
   */
  private classify(score: number | null, latestT: number): Verdict["state"] {
    if (score === null) {
      this.pendingState = null;
      return "measuring";
    }
    const current = this.verdict.state;
    let target: Verdict["state"] | null = null;
    let requiredMs = 0;
    if (score <= this.config.thresholds.humanMax) {
      // Salir de ai es más fácil que entrar: basta con HUMAN_CONFIRM_MS.
      if (current !== "human") {
        target = "human";
        requiredMs = this.config.confirmMs.human;
      }
    } else if (score >= this.config.thresholds.aiMin) {
      if (current !== "ai") {
        target = "ai";
        requiredMs = this.config.confirmMs.ai;
      }
    } else if (current === "measuring") {
      // Banda intermedia desde measuring: beneficio de la duda.
      target = "human";
      requiredMs = this.config.confirmMs.human;
    }
    // En la banda intermedia con current human/ai: target null -> se mantiene.

    if (target === null || target === current) {
      this.pendingState = null;
      return current;
    }
    if (this.pendingState !== target) {
      this.pendingState = target;
      this.pendingSince = latestT;
      return current;
    }
    if (latestT - this.pendingSince >= requiredMs) {
      this.pendingState = null;
      return target;
    }
    return current;
  }

  /**
   * L170: detecta un cambio de controlador (humano -> bot o al revés) cuando
   * el score se mantiene en la banda opuesta dentro de la MISMA sesión. Solo
   * observa: la decisión y la histeresis siguen siendo las de siempre.
   */
  private trackHandover(score: number | null, latestT: number): void {
    let band: Band = "unknown";
    if (score !== null) {
      if (score <= this.config.thresholds.humanMax) band = "human";
      else if (score >= this.config.thresholds.aiMin) band = "ai";
      else band = "middle";
    }
    if (band === this.lastBand) this.bandStreak += 1;
    else {
      this.lastBand = band;
      this.bandStreak = 1;
    }
    if (band !== "human" && band !== "ai") return;
    // `band` solo puede ser humano/IA con score numérico (ver arriba).
    if (score === null) return;
    if (this.bandStreak < HANDOVER_MIN_STREAK) return;

    if (this.lastStableBand === null || this.lastStableBand === band) {
      this.lastStableBand = band;
      return;
    }
    this.handover = {
      from: this.lastStableBand,
      to: band,
      score,
      at: latestT,
      count: (this.handover?.count ?? 0) + 1,
    };
    this.lastStableBand = band;
  }

  /** L182: solo avisa cuando el estado confirmado cambia entre humano e IA. */
  private emitChange(state: Verdict["state"], generation: number): void {
    if (state !== "human" && state !== "ai") return;
    if (state === this.lastChangeState) return;
    this.lastChangeState = state;
    for (const callback of [...this.changeCallbacks]) {
      if (this.generation !== generation) break;
      if (!this.changeCallbacks.has(callback)) continue;
      try {
        callback(state);
      } catch {
        // Aislamos fallos de callbacks como en onVerdict.
      }
    }
  }

  // -------------------------------------------------------------------------
  // API de lectura
  // -------------------------------------------------------------------------

  getVerdict(): Verdict {
    return {
      state: this.verdict.state,
      score: this.verdict.score,
      confidence: this.verdict.confidence,
      doubt: this.verdict.doubt,
      reasons: [...this.verdict.reasons],
    };
  }

  onVerdict(callback: VerdictCallback): () => void {
    if (typeof callback === "function") this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  onChange(callback: ChangeCallback): () => void {
    if (typeof callback === "function") this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /** Idioma efectivo de las razones (resuelto en start() si era `auto`). */
  getLocale(): Locale {
    return this.locale;
  }

  /** Preset de sensibilidad activo (no se expone en `getConfig()`). */
  getSensitivity(): Sensitivity {
    return this.sensitivity;
  }

  /** Preferencia de accesibilidad configurada (`false`, `true` o `auto`). */
  getAccessibility(): boolean | "auto" {
    return this.accessibilityOption;
  }

  /** Perfil detallado activo; inferido en start() o forzado por opción. */
  getDetailedDevice(): DetailedDevice {
    return this.detailedDevice;
  }

  /** Modo de privacidad efectivo (opción `aggregatesOnly` O "No rastrear"). */
  getPrivacyMode(): PrivacyMode {
    return this.privacyMode;
  }

  /** ¿Están activas las medidas finales opt-in? */
  isAdvancedMeasures(): boolean {
    return this.advancedMeasures;
  }

  /**
   * Recalibra SOLO tolerancias de guardarraíl a partir de una sesión local.
   * El resultado se acota, se guarda EN MEMORIA de esta sesión y se aplica con
   * `applyCalibration`. Nunca toca compuertas de evidencia, pesos ni umbrales
   * de veredicto: por diseño NO puede forzar un veredicto "humano".
   */
  recalibrateFromSession(session: unknown): CalibrationResult {
    let bounded: CalibrationResult | null = null;
    try {
      const fn = (recalibrateModule as Record<string, unknown>).calibrationFromSession;
      if (typeof fn === "function") {
        const raw = (fn as (value: unknown) => unknown)(session);
        if (raw && typeof raw === "object") bounded = boundedCalibration(raw) as CalibrationResult;
      }
    } catch {
      bounded = null;
    }
    if (bounded === null || Object.keys(bounded).length === 0) {
      // Fail closed: una sesión hostil/vacía NO cambia la calibración vigente.
      return this.calibration
        ? { ...this.calibration }
        : { applied: false, samples: 0, adjustments: {}, reasons: [] };
    }
    this.calibration = bounded;
    this.guardrailTolerances = this.applyCalibrationSafe(bounded);
    return { ...bounded };
  }

  /** Copia de la calibración vigente (null si no se recalibró o se reinició). */
  getCalibration(): CalibrationResult | null {
    return this.calibration ? { ...this.calibration } : null;
  }

  /** Descarta la calibración de esta sesión y restaura las tolerancias. */
  resetCalibration(): void {
    this.calibration = null;
    this.guardrailTolerances = { ...DEFAULT_GUARDRAIL_TOLERANCES };
  }

  /** Aplica `applyCalibration` a tolerancias; valores hostiles -> defaults. */
  private applyCalibrationSafe(result: CalibrationResult): GuardrailTolerances {
    const current: GuardrailTolerances = { ...DEFAULT_GUARDRAIL_TOLERANCES };
    try {
      const fn = (recalibrateModule as Record<string, unknown>).applyCalibration;
      if (typeof fn !== "function") return current;
      const applied = (fn as (t: unknown, r: unknown) => unknown)(current, result);
      const source =
        applied && typeof applied === "object"
          ? (applied as Record<string, unknown>)
          : (current as unknown as Record<string, unknown>);
      for (const key of Object.keys(current) as Array<keyof GuardrailTolerances>) {
        const value = source[key];
        // `pauseMs` es un número de ms; `rhythmTolerance` está en [0,1].
        const limit = key === "pauseMs" ? 3000 : 1;
        const min = key === "pauseMs" ? 400 : 0;
        if (typeof value === "number" && Number.isFinite(value)) {
          current[key] = clamp(value, min, limit);
        }
      }
    } catch {
      return { ...DEFAULT_GUARDRAIL_TOLERANCES };
    }
    return current;
  }

  /** Copia de las razones actuales (el array interno nunca se expone). */
  getReasons(): string[] {
    return translateReasons(this.verdict.reasons, this.locale);
  }

  // -------------------------------------------------------------------------
  // Etapa 10 — API de observabilidad (aditiva; nunca modifica el veredicto)
  // -------------------------------------------------------------------------

  /** Estado de replay de ESTA sesión en memoria (se borra con reset/stop). */
  getReplaySignals(): ReplaySignals {
    return copyReplaySignals(this.replaySignals);
  }

  /** Última comprobación sorpresa de coherencia sobre las señales puntuadas. */
  getSurpriseCheck(): SurpriseCheck {
    return copySurpriseCheck(this.surpriseCheck);
  }

  /** Último informe de integridad; `ok:false` implica veredicto `measuring`. */
  getIntegrity(): IntegrityReport {
    return copyIntegrityReport(this.integrityReport);
  }

  /**
   * Liveness observacional. `now` es opcional (la demo lo llama sin argumentos);
   * cuando se omite se usa el reloj saneado del detector. NUNCA produce un
   * veredicto: solo permite a la página notar si el detector se apagó.
   */
  getLiveness(now?: number): {
    status: LivenessStatus;
    lastBeatAt: number;
    intervalMs: number;
  } {
    const t = typeof now === "number" && Number.isFinite(now) ? now : this.time();
    const status = this.computeLivenessStatus(t);
    this.setLivenessStatus(status);
    let intervalMs = DEFAULT_LIVENESS_INTERVAL_MS;
    try {
      intervalMs = finiteInRange(this.liveness.intervalMs, intervalMs, 0, MAX_TIME_MS);
    } catch {
      // Monitor hostil: se conserva el default.
    }
    return { status, lastBeatAt: this.hasBeat ? this.lastBeatAt : 0, intervalMs };
  }

  /** Se suscribe a cambios de estado de liveness. Devuelve el unsubscribe. */
  onLiveness(callback: LivenessCallback): () => void {
    if (typeof callback === "function") this.livenessCallbacks.add(callback);
    return () => {
      this.livenessCallbacks.delete(callback);
    };
  }

  /** Configuración anti-trampas activa (no se expone en `getConfig()`). */
  getAntiCheat(): boolean {
    return this.antiCheat;
  }

  /** Configuración de jitter activa (no se expone en `getConfig()`). */
  getAntiCheatWeightJitter(): boolean {
    return this.antiCheatWeightJitter;
  }

  /** Desglose aditivo: señales, pesos efectivos, EMA y cambio de controlador. */
  getScoreBreakdown(): ScoreBreakdown {
    const snap = this.scoreComputer.getScoringSnapshot();
    const reasons = [...this.verdict.reasons];
    if (this.handover) {
      reasons.push(`Cambio de controlador: ${this.handover.from} → ${this.handover.to}`);
    }
    const replay = replayRisk(this.replaySignals);
    const surprise = this.surpriseCheck.passed ? 0 : 1;
    const riskEvidence: GuardrailRiskEvidence = {
      ...snap.riskEvidence,
      replay,
      surprise,
    };
    riskEvidence.overall = guardrailOverall(riskEvidence);
    // Campos nuevos NO enumerables: accesibles por nombre, invisibles a
    // Object.keys/toEqual/JSON.stringify para consumidores anteriores.
    defineHidden(
      riskEvidence,
      "coherenceDetailed",
      this.coherenceDetailed
        ? { ...(this.coherenceDetailed as unknown as Record<string, number>) }
        : null,
    );
    defineHidden(
      riskEvidence,
      "environment",
      this.environmentSignals ? { ...this.environmentSignals } : null,
    );
    const notes = [...this.notes];
    if (replay >= REPLAY_REASON_THRESHOLD) notes.push(REPLAY_REASON);
    if (!this.surpriseCheck.passed && this.surpriseCheck.reason) {
      notes.push(`Comprobación sorpresa: ${this.surpriseCheck.reason}`);
    }
    if (!this.integrityReport.ok) notes.push(INTEGRITY_REASON);
    // Tolerancias recalibradas: SOLO gobiernan estas dos notas observacionales.
    // Sin calibración no se emiten: los defaults bit a bit siguen intactos.
    if (this.calibration !== null) {
      const environment = this.environmentSignals;
      if (environment) {
        const values = Object.values(environment);
        const risk = values.length > 0 ? Math.max(...values) : 0;
        if (risk >= this.guardrailTolerances.rhythmTolerance) {
          notes.push("Entorno: señales automatizadas por encima de la tolerancia");
        }
      }
      if (this.attentionEnabled) {
        const times = this.getRecentAttention()
          .map((sample) => (finiteSeq(sample.t) ? sample.t : 0))
          .sort((a, b) => a - b);
        let longest = 0;
        for (let i = 1; i < times.length; i += 1) {
          longest = Math.max(longest, times[i] - times[i - 1]);
        }
        if (longest >= this.guardrailTolerances.pauseMs) {
          notes.push("Atención: pausa larga por encima del umbral calibrado");
        }
      }
    }
    const breakdown: ScoreBreakdown = {
      scores: this.maskSignalScores(this.scoreComputer.getSignalScores()),
      weights: snap.weights,
      effectiveWeights: snap.effectiveWeights,
      thresholds: { ...this.config.thresholds },
      combination: snap.combination,
      ema: snap.ema,
      handover: this.handover ? { ...this.handover } : null,
      handoverCount: this.handover?.count ?? 0,
      accessibility: {
        enabled: this.config.accessibilityProtection,
        device: this.config.device === "auto" ? snap.lastDevice : this.config.device,
        applied: snap.accessibilityApplied,
      },
      reasons,
      riskEvidence,
      notes,
    };
    defineHidden(breakdown, "privacyMode", this.privacyMode);
    defineHidden(breakdown, "advancedMeasuresApplied", snap.advancedApplied);
    defineHidden(breakdown, "guardrailTolerances", { ...this.guardrailTolerances });
    return breakdown;
  }

  getMouseFeatures(): MouseFeatures | null {
    return this.features ? { ...this.features } : null;
  }

  /** Muestras táctiles conservadas (solo si el colector fue habilitado). */
  getRecentTouches(sinceSeq = 0): TimedSampleLike[] {
    this.touchCollector?.discardOldestBefore?.(this.time() - this.maxAgeMs);
    return (this.touchCollector?.getSamples() ?? []).filter(
      (sample) => Number(sample.seq) > sinceSeq,
    );
  }

  /** Muestras de atención conservadas (solo si el colector fue habilitado). */
  getRecentAttention(sinceSeq = 0): TimedSampleLike[] {
    this.attentionCollector?.discardOldestBefore?.(this.time() - this.maxAgeMs);
    return (this.attentionCollector?.getSamples() ?? []).filter(
      (sample) => Number(sample.seq) > sinceSeq,
    );
  }

  /** Medidas táctiles de la última evaluación (copia; null sin colector). */
  getTouchFeatures(): FeatureTable | null {
    return this.touchFeatures ? { ...this.touchFeatures } : null;
  }

  /** Medidas de atención de la última evaluación (copia; null sin colector). */
  getAttentionFeatures(): FeatureTable | null {
    return this.attentionFeatures ? { ...this.attentionFeatures } : null;
  }

  getRecentPoints(sinceSeq = 0): PointerSample[] {
    this.buffer.discardOldestBefore(this.time() - this.maxAgeMs);
    return this.buffer.snapshotSince(sinceSeq);
  }

  getRecentClicks(sinceSeq = 0): ClickSample[] {
    this.clickCollector?.discardOldestBefore(this.time() - this.maxAgeMs);
    return (this.clickCollector?.getSamples() ?? []).filter((sample) => sample.seq > sinceSeq);
  }

  getRecentScrolls(sinceSeq = 0): ScrollSample[] {
    this.scrollCollector?.discardOldestBefore(this.time() - this.maxAgeMs);
    return (this.scrollCollector?.getSamples() ?? []).filter((sample) => sample.seq > sinceSeq);
  }

  /** Muestras de teclado (keydown/keyup) conservadas en el buffer circular. */
  getRecentKeys(sinceSeq = 0): KeySample[] {
    this.keyboardCollector?.discardOldestBefore(this.time() - this.maxAgeMs);
    return (this.keyboardCollector?.getSamples() ?? []).filter((sample) => sample.seq > sinceSeq);
  }

  /** Mutaciones de texto conservadas (solo metadata, nunca contenido). */
  getRecentInputs(sinceSeq = 0): InputSample[] {
    this.textInputCollector?.discardOldestBefore(this.time() - this.maxAgeMs);
    return (this.textInputCollector?.getSamples() ?? []).filter((sample) => sample.seq > sinceSeq);
  }

  /** Último score por señal (null si esa señal no tenía evidencia suficiente). */
  getSignalScores(): SignalScores {
    return this.maskSignalScores(this.scoreComputer.getSignalScores());
  }

  getStats(): CollectorStats {
    const sampleCount = this.buffer.size;
    const trusted = this.buffer.trustedCount();
    const stats: CollectorStats = {
      sampleCount,
      droppedCount: this.buffer.droppedCount,
      eventsPerSecond: this.collector ? this.collector.eventsSince(this.time() - 1000) : 0,
      bufferFill:
        sampleCount === 0 ? 0 : Math.min(1, Math.max(0, sampleCount / this.buffer.capacity)),
      trustedRatio: sampleCount === 0 ? 0 : trusted / sampleCount,
      lastEventAt: this.collector?.lastEventAt ?? 0,
      clickCount: this.clickCollector?.buffer.size ?? 0,
      scrollCount: this.scrollCollector?.buffer.size ?? 0,
      keyCount: this.keyboardCollector?.buffer.size ?? 0,
      inputCount: this.textInputCollector?.buffer.size ?? 0,
      touchCount: collectorSize(this.touchCollector),
      attentionCount: collectorSize(this.attentionCollector),
    };
    // Campos nuevos no enumerables: accesibles por nombre pero invisibles a
    // `Object.keys`, `toEqual` y `JSON.stringify`, para no romper consumidores
    // que comparaban la forma exacta de estas estadísticas.
    Object.defineProperty(stats, "keyCount", { enumerable: false });
    Object.defineProperty(stats, "inputCount", { enumerable: false });
    Object.defineProperty(stats, "touchCount", { enumerable: false });
    Object.defineProperty(stats, "attentionCount", { enumerable: false });
    if (this.privacyMode !== "aggregates") return stats;
    // Proyección agregada: SOLO conteos y tiempos redondeados. Las marcas
    // crudas (`lastEventAt`) y cualquier identidad se descartan.
    const projected = aggregatesOnlyStats(stats as unknown as Record<string, unknown>);
    const result = projected as unknown as CollectorStats;
    defineHidden(result, "keyCount", stats.keyCount);
    defineHidden(result, "inputCount", stats.inputCount);
    defineHidden(result, "touchCount", stats.touchCount);
    defineHidden(result, "attentionCount", stats.attentionCount);
    return result;
  }

  // -------------------------------------------------------------------------
  // Etapa 11 — umbrales, señales, debug y eventos (todos aditivos)
  // -------------------------------------------------------------------------

  /**
   * Avisa cuando el score combinado cruza `value` en cualquier dirección:
   * abajo↔arriba y también null↔número. El callback recibe el score vigente.
   * Valores no finitos/fuera de [0,1] usan un default seguro (0.5).
   * Devuelve el unsubscribe (idempotente).
   */
  onThreshold(value: number, callback: ThresholdCallback): () => void {
    const threshold = finiteInRange(value, DEFAULT_THRESHOLD, 0, 1);
    if (typeof callback !== "function") return () => {};
    const subscription = { value: threshold, callback };
    this.thresholdCallbacks.add(subscription);
    return () => {
      this.thresholdCallbacks.delete(subscription);
    };
  }

  /** Dispara los umbrales cuyo lado cambió; `null` es un lado propio. */
  private emitThreshold(previous: number | null, current: number | null, generation: number): void {
    if (previous === current || this.thresholdCallbacks.size === 0) return;
    for (const subscription of [...this.thresholdCallbacks]) {
      if (this.generation !== generation) break;
      // Permite darse de baja desde el propio callback.
      if (!this.thresholdCallbacks.has(subscription)) continue;
      const before = previous === null ? null : previous >= subscription.value;
      const after = current === null ? null : current >= subscription.value;
      if (before === after) continue;
      try {
        subscription.callback(current);
      } catch {
        // Un callback hostil no rompe a los demás ni la máquina de estados.
      }
    }
  }

  /** Activa señales por nombre; los nombres inválidos se ignoran. */
  enableSignals(signals: Signal[]): void {
    addSignals(this.enabledSignals, signals);
  }

  /** Desactiva señales por nombre; los nombres inválidos se ignoran. */
  disableSignals(signals: Signal[]): void {
    removeSignals(this.enabledSignals, signals);
  }

  /** Copia de las señales activas en orden estable. */
  getEnabledSignals(): Signal[] {
    return ALL_SIGNALS.filter((name) => this.enabledSignals.has(name));
  }

  /** Enmascara las señales desactivadas incluso antes de la próxima evaluación. */
  private maskSignalScores(scores: SignalScores): SignalScores {
    const masked: SignalScores = {
      mouse: this.enabledSignals.has("mouse") ? scores.mouse : null,
      click: this.enabledSignals.has("click") ? scores.click : null,
      scroll: this.enabledSignals.has("scroll") ? scores.scroll : null,
      keyboard: this.enabledSignals.has("keyboard") ? scores.keyboard : null,
    };
    // Modo solo agregados: se redondea la precisión de los puntajes. La forma
    // enumerable NO cambia y la máquina de veredictos sigue intacta.
    if (this.privacyMode === "aggregates") {
      for (const key of ["mouse", "click", "scroll", "keyboard"] as const) {
        const value = masked[key];
        if (value === null || !Number.isFinite(value)) continue;
        const rounded = roundTiming(value, 0.05);
        masked[key] = clamp(Number.isFinite(rounded) ? rounded : value, 0, 1);
      }
    }
    // Mantiene la forma pública: `keyboard` sigue siendo no enumerable.
    Object.defineProperty(masked, "keyboard", { enumerable: false });
    return masked;
  }

  /** Activa/desactiva el registro de debug (solo afecta a `evaluate()`). */
  setDebug(enabled: boolean): void {
    this.debug = safeBoolean(enabled, this.debug);
  }

  isDebug(): boolean {
    return this.debug;
  }

  /** Registro conciso, protegido contra un `console` hostil. */
  private debugLog(state: Verdict["state"], score: number | null, confidence: number): void {
    if (!this.debug) return;
    try {
      const value = score === null ? "null" : score.toFixed(6);
      console.debug(
        `[is-that-an-ai] state=${state} score=${value} confidence=${confidence.toFixed(6)}`,
      );
    } catch {
      // Observabilidad: un console hostil jamás altera el veredicto.
    }
  }

  /**
   * `CustomEvent("isthatanai")` con una copia del veredicto en `detail`.
   * `document`/`CustomEvent` se leen AQUÍ (en evaluate), nunca al importar ni en
   * el constructor. SSR-safe y tolerante con globals hostiles.
   */
  private dispatchCustomEvent(verdict: Verdict): void {
    if (!this.customEventEnabled) return;
    try {
      const doc = globalThis.document;
      const Ctor = globalThis.CustomEvent;
      if (!doc || typeof doc.dispatchEvent !== "function" || typeof Ctor !== "function") return;
      const detail: Verdict = {
        state: verdict.state,
        score: verdict.score,
        confidence: verdict.confidence,
        doubt: verdict.doubt,
        reasons: [...verdict.reasons],
      };
      doc.dispatchEvent(new Ctor("isthatanai", { detail }));
    } catch {
      // El evento es solo observabilidad: nunca lanza hacia el consumidor.
    }
  }
}
