// Un único sondeo compartido del estado derivado del detector.
// Las vistas "en vivo" leen de aquí: un solo setInterval a 160 ms (la cadencia
// más rápida que ya tenían) en vez de un temporizador por componente.
// Cada campo se actualiza solo cuando cambia de verdad, para no disparar
// cascadas reactivas con copias idénticas. SSR-safe: ni window ni document a
// nivel de módulo; el temporizador se crea solo desde connect() (onMount).

import type {
  CollectorStats,
  MouseFeatures,
  PointerSample,
  SignalScores,
  Verdict,
} from "is-that-an-ai";

export type { CollectorStats, MouseFeatures, PointerSample, SignalScores, Verdict };

/** Valores que puede devolver el getter de dispositivo detallado (Etapa 9). */
export type DetailedDevice = "computadora" | "laptop" | "celular" | "tablet" | "tv" | "touch";

const DETAILED_DEVICES: readonly DetailedDevice[] = [
  "computadora",
  "laptop",
  "celular",
  "tablet",
  "tv",
  "touch",
];

function asDetailedDevice(value: string | null | undefined): DetailedDevice | null {
  if (typeof value !== "string") return null;
  return DETAILED_DEVICES.includes(value as DetailedDevice) ? (value as DetailedDevice) : null;
}

/** Observabilidad (Etapa 10). `null` = getter ausente o valor no utilizable. */
export type LivenessStatus = "live" | "stale" | "idle";

export interface LivenessReading {
  status: LivenessStatus | null;
  lastBeatAt: number;
  intervalMs: number;
}

export interface IntegrityCheck {
  name: string;
  ok: boolean;
}

export interface IntegrityReading {
  ok: boolean | null;
  checks: IntegrityCheck[];
}

export interface ReplayReading {
  repeatedPath: number;
  repeatedTiming: number;
  identicalSequence: number;
}

export interface SurpriseReading {
  passed: boolean | null;
  reason: string;
}

/** Modo de privacidad informado por la librería (Etapa 12). */
export type PrivacyMode = "full" | "aggregates";

/** Estado de la calibración por sesión, sin incluir ajustes ni razones. */
export interface CalibrationReading {
  applied: boolean;
  samples: number;
}

const LIVENESS_STATUSES: readonly LivenessStatus[] = ["live", "stale", "idle"];
const PRIVACY_MODES: readonly PrivacyMode[] = ["full", "aggregates"];

// Estados neutros: si la librería aún no publica los getters, la vista muestra «—».
const UNKNOWN_LIVENESS: LivenessReading = { status: null, lastBeatAt: 0, intervalMs: 0 };
const UNKNOWN_INTEGRITY: IntegrityReading = { ok: null, checks: [] };
const UNKNOWN_REPLAY: ReplayReading = {
  repeatedPath: 0,
  repeatedTiming: 0,
  identicalSequence: 0,
};
const UNKNOWN_SURPRISE: SurpriseReading = { passed: null, reason: "" };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asCount(value: unknown): number {
  return Math.max(0, asFiniteNumber(value));
}

function asLiveness(value: unknown): LivenessReading {
  const raw = asRecord(value);
  const status = LIVENESS_STATUSES.includes(raw.status as LivenessStatus)
    ? (raw.status as LivenessStatus)
    : null;
  return {
    status,
    lastBeatAt: asFiniteNumber(raw.lastBeatAt),
    intervalMs: asFiniteNumber(raw.intervalMs),
  };
}

function asIntegrity(value: unknown): IntegrityReading {
  const raw = asRecord(value);
  const checks: IntegrityCheck[] = Array.isArray(raw.checks)
    ? raw.checks.flatMap((entry: unknown): IntegrityCheck[] => {
        const item = asRecord(entry);
        if (typeof item.name !== "string" || typeof item.ok !== "boolean") return [];
        return [{ name: item.name, ok: item.ok }];
      })
    : [];
  return { ok: typeof raw.ok === "boolean" ? raw.ok : null, checks };
}

function asReplay(value: unknown): ReplayReading {
  const raw = asRecord(value);
  return {
    repeatedPath: asCount(raw.repeatedPath),
    repeatedTiming: asCount(raw.repeatedTiming),
    identicalSequence: asCount(raw.identicalSequence),
  };
}

function asSurprise(value: unknown): SurpriseReading {
  const raw = asRecord(value);
  return {
    passed: typeof raw.passed === "boolean" ? raw.passed : null,
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

function asPrivacyMode(value: unknown): PrivacyMode | null {
  return PRIVACY_MODES.includes(value as PrivacyMode) ? (value as PrivacyMode) : null;
}

/** `null` = getter ausente o respuesta no utilizable; nunca inventamos muestras. */
function asSampleCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function asCalibration(value: unknown): CalibrationReading | null {
  const raw = asRecord(value);
  if (typeof raw.applied !== "boolean") return null;
  return { applied: raw.applied, samples: asCount(raw.samples) };
}

interface LiveSource {
  getVerdict(): Verdict;
  getStats(): CollectorStats;
  getSignalScores(): SignalScores;
  getRecentPoints(sinceSeq?: number): PointerSample[];
  getMouseFeatures(): MouseFeatures | null;
  /** Opcional mientras la librería publica el getter de la Etapa 9. */
  getDetailedDevice?(): string | null;
  /** Opcionales mientras la librería publica los getters de la Etapa 10. */
  getLiveness?(): unknown;
  getIntegrity?(): unknown;
  getReplaySignals?(): unknown;
  getSurpriseCheck?(): unknown;
  /** Opcionales mientras la librería publica los getters de la Etapa 12. */
  getPrivacyMode?(): unknown;
  getRecentTouches?(sinceSeq?: number): unknown;
  getRecentAttention?(sinceSeq?: number): unknown;
  getCalibration?(): unknown;
}

const FEATURE_KEYS: Array<keyof MouseFeatures> = [
  "straightness",
  "teleport",
  "speedUniformity",
  "jerk",
  "tremor",
  "intervalRegularity",
  "overshoot",
  "turnSmoothness",
  "microPauses",
  "roundSteps",
];

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameVerdict(a: Verdict, b: Verdict): boolean {
  return (
    a.state === b.state &&
    a.score === b.score &&
    a.confidence === b.confidence &&
    a.doubt === b.doubt &&
    sameStrings(a.reasons, b.reasons)
  );
}

function sameScores(a: SignalScores, b: SignalScores): boolean {
  return (
    a.mouse === b.mouse && a.keyboard === b.keyboard && a.click === b.click && a.scroll === b.scroll
  );
}

function sameStats(a: CollectorStats, b: CollectorStats): boolean {
  return (
    a.sampleCount === b.sampleCount &&
    a.droppedCount === b.droppedCount &&
    a.eventsPerSecond === b.eventsPerSecond &&
    a.bufferFill === b.bufferFill &&
    a.trustedRatio === b.trustedRatio &&
    a.lastEventAt === b.lastEventAt &&
    a.clickCount === b.clickCount &&
    a.scrollCount === b.scrollCount &&
    a.keyCount === b.keyCount &&
    a.inputCount === b.inputCount
  );
}

// Las muestras son inmutables en el buffer: con longitud y primera/última
// muestra basta para detectar both appended y la ventana que se desplaza.
function samePoints(a: PointerSample[], b: PointerSample[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const firstA = a[0];
  const lastA = a[a.length - 1];
  const firstB = b[0];
  const lastB = b[b.length - 1];
  return (
    firstA.seq === firstB.seq &&
    firstA.t === firstB.t &&
    lastA.seq === lastB.seq &&
    lastA.t === lastB.t
  );
}

function sameFeatures(a: MouseFeatures | null, b: MouseFeatures | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const key of FEATURE_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

function sameLiveness(a: LivenessReading, b: LivenessReading): boolean {
  return a.status === b.status && a.lastBeatAt === b.lastBeatAt && a.intervalMs === b.intervalMs;
}

function sameIntegrity(a: IntegrityReading, b: IntegrityReading): boolean {
  if (a.ok !== b.ok || a.checks.length !== b.checks.length) return false;
  for (let i = 0; i < a.checks.length; i += 1) {
    if (a.checks[i].name !== b.checks[i].name || a.checks[i].ok !== b.checks[i].ok) return false;
  }
  return true;
}

function sameReplay(a: ReplayReading, b: ReplayReading): boolean {
  return (
    a.repeatedPath === b.repeatedPath &&
    a.repeatedTiming === b.repeatedTiming &&
    a.identicalSequence === b.identicalSequence
  );
}

function sameSurprise(a: SurpriseReading, b: SurpriseReading): boolean {
  return a.passed === b.passed && a.reason === b.reason;
}

function sameCalibration(a: CalibrationReading | null, b: CalibrationReading | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.applied === b.applied && a.samples === b.samples;
}

class LiveReadings {
  // $state.raw: reemplazamos el objeto/array completo; sin proxy profundo.
  verdict = $state.raw<Verdict>({
    state: "measuring",
    score: null,
    confidence: 0,
    doubt: 0,
    reasons: [],
  });
  scores = $state.raw<SignalScores>({ mouse: null, keyboard: null, click: null, scroll: null });
  stats = $state.raw<CollectorStats>({
    sampleCount: 0,
    droppedCount: 0,
    eventsPerSecond: 0,
    bufferFill: 0,
    trustedRatio: 0,
    lastEventAt: 0,
    clickCount: 0,
    scrollCount: 0,
    keyCount: 0,
    inputCount: 0,
  });
  points = $state.raw<PointerSample[]>([]);
  features = $state.raw<MouseFeatures | null>(null);
  detailedDevice = $state.raw<DetailedDevice | null>(null);
  liveness = $state.raw<LivenessReading>(UNKNOWN_LIVENESS);
  integrity = $state.raw<IntegrityReading>(UNKNOWN_INTEGRITY);
  replay = $state.raw<ReplayReading>(UNKNOWN_REPLAY);
  surprise = $state.raw<SurpriseReading>(UNKNOWN_SURPRISE);
  privacyMode = $state.raw<PrivacyMode | null>(null);
  touchCount = $state.raw<number | null>(null);
  attentionCount = $state.raw<number | null>(null);
  calibration = $state.raw<CalibrationReading | null>(null);

  private source: LiveSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  connect(source: LiveSource): void {
    if (this.timer !== null) return;
    this.source = source;
    this.pump();
    this.timer = setInterval(() => this.pump(), 160);
  }

  disconnect(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.source = null;
    this.detailedDevice = null;
    this.liveness = UNKNOWN_LIVENESS;
    this.integrity = UNKNOWN_INTEGRITY;
    this.replay = UNKNOWN_REPLAY;
    this.surprise = UNKNOWN_SURPRISE;
    this.privacyMode = null;
    this.touchCount = null;
    this.attentionCount = null;
    this.calibration = null;
  }

  // Lectura inmediata: la usa onVerdict para reflejar el cambio de estado sin
  // esperar al siguiente tick.
  pump(): void {
    const s = this.source;
    if (!s) return;
    const verdict = s.getVerdict();
    if (!sameVerdict(verdict, this.verdict)) this.verdict = verdict;
    const scores = s.getSignalScores();
    if (!sameScores(scores, this.scores)) this.scores = scores;
    const stats = s.getStats();
    if (!sameStats(stats, this.stats)) this.stats = stats;
    const points = s.getRecentPoints();
    if (!samePoints(points, this.points)) this.points = points;
    const features = s.getMouseFeatures();
    if (!sameFeatures(features, this.features)) this.features = features;
    // Mismo sondeo: sin temporizador nuevo y solo publica si cambia de valor.
    const detailedDevice = asDetailedDevice(s.getDetailedDevice?.());
    if (detailedDevice !== this.detailedDevice) this.detailedDevice = detailedDevice;
    // Etapa 10: observación defensiva de getters opcionales; sin red ni almacenamiento.
    const liveness = asLiveness(s.getLiveness?.());
    if (!sameLiveness(liveness, this.liveness)) this.liveness = liveness;
    const integrity = asIntegrity(s.getIntegrity?.());
    if (!sameIntegrity(integrity, this.integrity)) this.integrity = integrity;
    const replay = asReplay(s.getReplaySignals?.());
    if (!sameReplay(replay, this.replay)) this.replay = replay;
    const surprise = asSurprise(s.getSurpriseCheck?.());
    if (!sameSurprise(surprise, this.surprise)) this.surprise = surprise;
    // Etapa 12: mismo sondeo, sin temporizador nuevo y solo publica si cambia.
    const privacyMode = asPrivacyMode(s.getPrivacyMode?.());
    if (privacyMode !== this.privacyMode) this.privacyMode = privacyMode;
    const touchCount = asSampleCount(s.getRecentTouches?.());
    if (touchCount !== this.touchCount) this.touchCount = touchCount;
    const attentionCount = asSampleCount(s.getRecentAttention?.());
    if (attentionCount !== this.attentionCount) this.attentionCount = attentionCount;
    const calibration = asCalibration(s.getCalibration?.());
    if (!sameCalibration(calibration, this.calibration)) this.calibration = calibration;
  }
}

export const live = new LiveReadings();
