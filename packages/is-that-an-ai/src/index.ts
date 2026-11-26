// Superficie pública de la librería. Sin acceso a window/document/navigator al importar.

export type { ClickCollector, ClickCollectorOptions } from "./collectors/click";
export { createClickCollector } from "./collectors/click";
export type { MouseCollector, MouseCollectorOptions } from "./collectors/mouse";
export { createMouseCollector } from "./collectors/mouse";
export type { ScrollCollector, ScrollCollectorOptions } from "./collectors/scroll";
export { createScrollCollector, LINES_TO_PX, PAGES_TO_PX } from "./collectors/scroll";
export { IsThatAnAI } from "./core/detector";
export type { ClickFeatures } from "./features/click";
// Medidas de click y scroll (funciones puras, sin DOM ni layout).
export {
  CLICK_FEATURE_WEIGHTS,
  CLICK_NEUTRAL,
  clickAimConsistency,
  clickBurstiness,
  clickDownUpDrift,
  clickDurationRegularity,
  clickIntervalRegularity,
  clickNoPauses,
  clickReasons,
  clickSingleButton,
  computeClickScore,
  extractClickFeatures,
} from "./features/click";
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
export type { ScrollFeatures } from "./features/scroll";
export {
  AUTOSCROLL_MAX_ABS_DY,
  AUTOSCROLL_MAX_MEDIAN_DT_MS,
  AUTOSCROLL_MIN_SAMPLES,
  computeScrollScore,
  extractScrollFeatures,
  SCROLL_FEATURE_WEIGHTS,
  SCROLL_NEUTRAL,
  scrollAxisLock,
  scrollDecelerationProfile,
  scrollDeltaUniformity,
  scrollDirectionChanges,
  scrollIntervalRegularity,
  scrollLargeJumps,
  scrollNoPauses,
  scrollReasons,
  scrollRoundDeltas,
  withoutAutoscroll,
} from "./features/scroll";
export type { ScoredEvidence } from "./scoring/score";
// Scoring.
export {
  AI_CORE,
  AI_MIN,
  computeScore,
  doubtFor,
  HUMAN_CORE,
  HUMAN_MAX,
  MIN_CLICKS,
  MIN_SCROLLS,
  MIN_SEGMENTS,
  MIN_WINDOW_MS,
  ScoreComputer,
  SIGNAL_WEIGHTS,
  scoreReasons,
} from "./scoring/score";
export type { FeatureWeights } from "./scoring/weights";
export type {
  ClickSample,
  Collector,
  CollectorStats,
  DetectorOptions,
  Options,
  PointerKind,
  PointerSample,
  PointerTypeCode,
  Sample,
  Score,
  ScrollSample,
  Signal,
  SignalScores,
  Verdict,
  VerdictCallback,
} from "./types";
