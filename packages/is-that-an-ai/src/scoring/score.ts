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

import {
  type ClickFeatures,
  clickReasons,
  computeClickScore,
  extractClickFeatures,
} from "../features/click";
import {
  computeKeyboardScore,
  countKeyDowns,
  extractKeyboardFeatures,
  hasKeyboardEvidence,
  type KeyboardFeatures,
  keyboardReasons,
  keyboardWindowMs,
} from "../features/keyboard";
import { countSegments, extractMouseFeatures, type MouseFeatures } from "../features/mouse";
import {
  computeScrollScore,
  extractScrollFeatures,
  type ScrollFeatures,
  scrollReasons,
  withoutAutoscroll,
} from "../features/scroll";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
  SignalScores,
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
export const SIGNAL_WEIGHTS = {
  mouse: 0.6,
  click: 0.2,
  scroll: 0.2,
  keyboard: 0.15,
} as const;

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

/** Factor de suavizado EMA (0 = passthrough, 1 = gelado). */
export const EMA_ALPHA = 0.35;

/**
 * Duda 0..1: qué cerca está el score de la frontera de decisión dentro del
 * estado dado. 0 = convincente (dentro del núcleo de la clase), 1 = en el
 * umbral. "measuring" (o score null) siempre tiene duda 1.
 */
export function doubtFor(state: Verdict["state"], score: number | null): number {
  if (state === "measuring" || score === null) return 1;
  if (state === "human") return clamp((score - HUMAN_CORE) / (AI_MIN - HUMAN_CORE), 0, 1);
  return clamp((AI_CORE - score) / (AI_CORE - AI_MIN), 0, 1);
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

export class ScoreComputer {
  private ema: number | null = null;
  private signalScores: SignalScores = {
    mouse: null,
    click: null,
    scroll: null,
    keyboard: null,
  };

  /** Borra el EMA, los scores por señal y la ventana de evidencia interna. */
  reset(): void {
    this.ema = null;
    this.signalScores = { mouse: null, click: null, scroll: null, keyboard: null };
  }

  /** Último score por señal calculado (null si esa señal no tenía evidencia). */
  getSignalScores(): SignalScores {
    return publicSignalScores(this.signalScores);
  }

  /**
   * Evalúa todas las señales disponibles. Los argumentos `clicks`/`scrolls`/
   * `keys`/`inputs` son opcionales: al omitirlos (o al no alcanzar su evidencia
   * mínima) el resultado es IDÉNTICO al scoring de mouse original, incluido el
   * EMA. La firma extensible mantiene las llamadas de dos argumentos intactas.
   */
  evaluate(
    samples: PointerSample[],
    windowMs: number,
    clicks: ClickSample[] = [],
    scrolls: ScrollSample[] = [],
    keys: KeySample[] = [],
    inputs: InputSample[] = [],
  ): ScoredEvidence {
    const segmentCount = countSegments(samples);
    const moveCount = movementSamples(samples);
    const hasMouse =
      samples.length > 0 &&
      (segmentCount >= MIN_SEGMENTS || moveCount >= MIN_SEGMENTS) &&
      windowMs >= MIN_WINDOW_MS;

    const clickWindowMs = clicks.length >= 2 ? clicks[clicks.length - 1].t - clicks[0].t : 0;
    // El autoscroll humano se excluye ANTES de contar evidencia: si solo hay
    // autoscroll, la señal de scroll queda sin evidencia (null).
    const scoredScrolls = withoutAutoscroll(scrolls);
    const scrollWindowMs =
      scoredScrolls.length >= 2
        ? scoredScrolls[scoredScrolls.length - 1].t - scoredScrolls[0].t
        : 0;
    const hasClick = clicks.length >= MIN_CLICKS && clickWindowMs >= MIN_WINDOW_MS;
    const hasScroll = scoredScrolls.length >= MIN_SCROLLS && scrollWindowMs >= MIN_WINDOW_MS;
    const hasKeyboard = hasKeyboardEvidence(keys, inputs);
    const keyWindowMs = keyboardWindowMs(keys);

    const mouseFeatures: MouseFeatures | null = hasMouse ? extractMouseFeatures(samples) : null;
    const clickFeatures: ClickFeatures | null = hasClick ? extractClickFeatures(clicks) : null;
    const scrollFeatures: ScrollFeatures | null = hasScroll
      ? extractScrollFeatures(scoredScrolls)
      : null;
    const keyboardFeatures: KeyboardFeatures | null = hasKeyboard
      ? extractKeyboardFeatures(keys, inputs)
      : null;

    this.signalScores = {
      mouse: mouseFeatures ? computeScore(mouseFeatures) : null,
      click: clickFeatures ? computeClickScore(clickFeatures) : null,
      scroll: scrollFeatures ? computeScrollScore(scrollFeatures) : null,
      keyboard: keyboardFeatures ? computeKeyboardScore(keyboardFeatures) : null,
    };

    if (!hasMouse && !hasClick && !hasScroll && !hasKeyboard) {
      return { score: null, confidence: 0, reasons: [] };
    }

    // Combinación ponderada entre señales CON evidencia; se normaliza por la
    // suma de pesos usados. Con solo mouse da el score del mouse (peso 1).
    let weighted = 0;
    let weightTotal = 0;
    if (hasMouse) {
      weighted += SIGNAL_WEIGHTS.mouse * (this.signalScores.mouse as number);
      weightTotal += SIGNAL_WEIGHTS.mouse;
    }
    if (hasClick) {
      weighted += SIGNAL_WEIGHTS.click * (this.signalScores.click as number);
      weightTotal += SIGNAL_WEIGHTS.click;
    }
    if (hasScroll) {
      weighted += SIGNAL_WEIGHTS.scroll * (this.signalScores.scroll as number);
      weightTotal += SIGNAL_WEIGHTS.scroll;
    }
    if (hasKeyboard) {
      weighted += SIGNAL_WEIGHTS.keyboard * (this.signalScores.keyboard as number);
      weightTotal += SIGNAL_WEIGHTS.keyboard;
    }
    const raw = weightTotal > 0 ? weighted / weightTotal : 0.5;

    const smoothed = this.ema === null ? raw : EMA_ALPHA * raw + (1 - EMA_ALPHA) * this.ema;
    this.ema = clamp(smoothed, 0, 1);

    // La misma fórmula de confianza del mouse, extendida con el resto de
    // señales solo cuando aportan evidencia. Con solo mouse es idéntica.
    const evidenceCount =
      moveCount +
      (hasClick ? clicks.length : 0) +
      (hasScroll ? scoredScrolls.length : 0) +
      (hasKeyboard ? countKeyDowns(keys) + inputs.length : 0);
    const maxWindowMs = Math.max(
      windowMs,
      hasClick ? clickWindowMs : 0,
      hasScroll ? scrollWindowMs : 0,
      hasKeyboard ? keyWindowMs : 0,
    );
    const confidence = clamp(
      0.5 * (Math.min(evidenceCount / 25, 1) + Math.min(maxWindowMs / 2000, 1)),
      0,
      1,
    );

    const reasons: string[] = [];
    if (mouseFeatures) reasons.push(...scoreReasons(mouseFeatures));
    if (clickFeatures) reasons.push(...clickReasons(clickFeatures));
    if (scrollFeatures) reasons.push(...scrollReasons(scrollFeatures));
    if (keyboardFeatures) reasons.push(...keyboardReasons(keyboardFeatures));

    return { score: this.ema, confidence, reasons };
  }
}
