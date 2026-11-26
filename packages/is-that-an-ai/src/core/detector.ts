import { createMouseCollector, type MouseCollector } from "../collectors/mouse";
import { extractMouseFeatures, type MouseFeatures } from "../features/mouse";
import {
  AI_CONFIRM_MS,
  AI_MIN,
  doubtFor,
  HUMAN_CONFIRM_MS,
  HUMAN_MAX,
  ScoreComputer,
} from "../scoring/score";
import type {
  CollectorStats,
  DetectorOptions,
  PointerSample,
  Verdict,
  VerdictCallback,
} from "../types";
import { RingBuffer } from "../utils/ring-buffer";

export { AI_CONFIRM_MS, AI_MIN, HUMAN_CONFIRM_MS, HUMAN_MAX };

const DEFAULT_BUFFER_SIZE = 2048;
const DEFAULT_MAX_AGE_MS = 15000;
const EVALUATION_INTERVAL_MS = 100;

// Regla: NO tocar window/document/navigator al importar ni en el constructor.
// Toda interacción con el DOM ocurre dentro de start() y se limpia en stop().

const MEASURING: Verdict = {
  state: "measuring",
  score: null,
  confidence: 0,
  doubt: 1,
  reasons: [],
};

function defaultNow(): () => number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
}

export class IsThatAnAI {
  private readonly options: DetectorOptions;
  private readonly now: () => number;
  private readonly buffer: RingBuffer;
  private readonly callbacks = new Set<VerdictCallback>();
  private readonly scoreComputer = new ScoreComputer();
  private features: MouseFeatures | null = null;
  private collector: MouseCollector | null = null;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private verdict: Verdict = MEASURING;
  private lastEmittedState: Verdict["state"] = "measuring";
  private pendingState: Verdict["state"] | null = null;
  private pendingSince = 0;

  constructor(options: DetectorOptions = {}) {
    this.options = options;
    this.now = options.now ?? defaultNow();
    this.buffer = new RingBuffer(options.mouse?.bufferSize ?? DEFAULT_BUFFER_SIZE);
    if (options.onVerdict) this.callbacks.add(options.onVerdict);
  }

  private get maxAgeMs(): number {
    return this.options.mouse?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  start(): void {
    if (this.started) return;
    if (!this.collector) {
      // `window` se consulta aquí, nunca en el constructor ni al importar.
      const target: EventTarget = typeof window !== "undefined" ? window : new EventTarget();
      this.collector = createMouseCollector({ target, now: this.now, buffer: this.buffer });
    }
    this.collector.attach();
    this.started = true;
    if (this.timer === null) {
      this.timer = setInterval(() => this.evaluate(), EVALUATION_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.collector?.detach();
    this.collector = null;
    this.started = false;
    this.scoreComputer.reset();
    this.features = null;
    this.buffer.clear();
    this.verdict = MEASURING;
    this.lastEmittedState = "measuring";
    this.pendingState = null;
    this.pendingSince = 0;
  }

  /**
   * Evalúa el scorer sobre el buffer actual y actualiza el veredicto.
   * Publico para tests; el loop real corre cada EVALUATION_INTERVAL_MS.
   */
  evaluate(): void {
    if (!this.collector) return;
    this.buffer.discardOldestBefore(this.now() - this.maxAgeMs);
    const samples = this.buffer.snapshot();
    if (samples.length === 0) return;
    const windowMs = samples[samples.length - 1].t - samples[0].t;
    const evidence = this.scoreComputer.evaluate(samples, windowMs);
    this.features = evidence.score === null ? null : extractMouseFeatures(samples);
    const state = this.classify(evidence.score, samples[samples.length - 1].t);
    // score null solo cuando no hay evidencia suficiente; con evidencia se
    // conserva el score real y se recalcula la duda en cada evaluación.
    this.verdict =
      evidence.score === null
        ? { state: "measuring", score: null, confidence: 0, doubt: 1, reasons: [] }
        : {
            state,
            score: evidence.score,
            confidence: evidence.confidence,
            doubt: doubtFor(state, evidence.score),
            reasons: evidence.reasons,
          };
    if (state !== this.lastEmittedState) {
      this.lastEmittedState = state;
      // Copia: los callbacks no pueden mutar el estado interno.
      const verdict: Verdict = {
        state: this.verdict.state,
        score: this.verdict.score,
        confidence: this.verdict.confidence,
        doubt: this.verdict.doubt,
        reasons: [...this.verdict.reasons],
      };
      for (const callback of [...this.callbacks]) callback(verdict);
    }
  }

  /**
   * Histeresis con confirmación por tiempo de muestra. Decide SOLO `state`:
   * - score <= HUMAN_MAX -> human; score >= AI_MIN -> ai.
   * - Banda intermedia: se mantiene el estado anterior; si se venía de
   *   measuring se decide human (beneficio de la duda).
   * - Salir de ai a human con score <= HUMAN_MAX es más fácil (250 ms) que
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
    if (score <= HUMAN_MAX) {
      // Salir de ai es más fácil que entrar: basta con HUMAN_CONFIRM_MS.
      if (current !== "human") {
        target = "human";
        requiredMs = HUMAN_CONFIRM_MS;
      }
    } else if (score >= AI_MIN) {
      if (current !== "ai") {
        target = "ai";
        requiredMs = AI_CONFIRM_MS;
      }
    } else if (current === "measuring") {
      // Banda intermedia desde measuring: beneficio de la duda.
      target = "human";
      requiredMs = HUMAN_CONFIRM_MS;
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
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  getMouseFeatures(): MouseFeatures | null {
    return this.features ? { ...this.features } : null;
  }

  getRecentPoints(sinceSeq = 0): PointerSample[] {
    this.buffer.discardOldestBefore(this.now() - this.maxAgeMs);
    return this.buffer.snapshotSince(sinceSeq);
  }

  getStats(): CollectorStats {
    const sampleCount = this.buffer.size;
    const trusted = this.buffer.trustedCount();
    return {
      sampleCount,
      droppedCount: this.buffer.droppedCount,
      eventsPerSecond: this.collector ? this.collector.eventsSince(this.now() - 1000) : 0,
      bufferFill:
        sampleCount === 0 ? 0 : Math.min(1, Math.max(0, sampleCount / this.buffer.capacity)),
      trustedRatio: sampleCount === 0 ? 0 : trusted / sampleCount,
      lastEventAt: this.collector?.lastEventAt ?? 0,
    };
  }
}
