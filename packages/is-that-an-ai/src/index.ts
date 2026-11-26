// Superficie pública de la librería. Sin acceso a window/document/navigator al importar.

export type { MouseCollector, MouseCollectorOptions } from "./collectors/mouse";
export { createMouseCollector } from "./collectors/mouse";
export { IsThatAnAI } from "./core/detector";
export type { MouseFeatures } from "./features/mouse";

// Medidas de mouse (funciones puras sobre PointerSample[]).
export {
  countSegments,
  extractMouseFeatures,
  mouseIntervalRegularity,
  mouseJerk,
  mouseMicroPauses,
  mouseOvershoot,
  mouseRoundSteps,
  mouseSpeedUniformity,
  mouseStraightness,
  mouseTeleport,
  mouseTremor,
  mouseTurnSmoothness,
  NEUTRAL,
} from "./features/mouse";
// Scoring.
export {
  AI_CORE,
  AI_MIN,
  computeScore,
  doubtFor,
  HUMAN_CORE,
  HUMAN_MAX,
  MIN_SEGMENTS,
  MIN_WINDOW_MS,
  ScoreComputer,
  scoreReasons,
} from "./scoring/score";
export type { FeatureWeights } from "./scoring/weights";
export type {
  Collector,
  CollectorStats,
  DetectorOptions,
  Options,
  PointerKind,
  PointerSample,
  PointerTypeCode,
  Sample,
  Score,
  Signal,
  Verdict,
  VerdictCallback,
} from "./types";
