// Superficie pública de la librería. Sin acceso a window/document/navigator al importar.

export type { ClickCollector, ClickCollectorOptions } from "./collectors/click";
export { createClickCollector } from "./collectors/click";
export type { KeyboardCollector, KeyboardCollectorOptions } from "./collectors/keyboard";
export { createKeyboardCollector, keyCategoryOf } from "./collectors/keyboard";
export type { MouseCollector, MouseCollectorOptions } from "./collectors/mouse";
export { createMouseCollector } from "./collectors/mouse";
export type { ScrollCollector, ScrollCollectorOptions } from "./collectors/scroll";
export { createScrollCollector, LINES_TO_PX, PAGES_TO_PX } from "./collectors/scroll";
export type { TextInputCollector, TextInputCollectorOptions } from "./collectors/text-input";
export { createTextInputCollector, inputTypeCodeOf } from "./collectors/text-input";
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
export type { KeyboardFeatures } from "./features/keyboard";
// Medidas de teclado (funciones puras sobre KeySample[] / InputSample[]).
export {
  CORRECTION_GAP_MS,
  computeKeyboardScore,
  countKeyDowns,
  EXTREME_EXACT_RHYTHM,
  EXTREME_INTERVAL_REGULARITY,
  EXTREME_RHYTHM_MIN_DOWNS,
  extractKeyboardFeatures,
  hasKeyboardEvidence,
  INTERVAL_CV_HIGH,
  INTERVAL_CV_LOW,
  KEYBOARD_FEATURE_WEIGHTS,
  KEYBOARD_NEUTRAL,
  KEYDOWN_LOOKBACK_MS,
  keyboardCorrectionBursts,
  keyboardExactRhythm,
  keyboardHoldRegularity,
  keyboardIntervalRegularity,
  keyboardModifierShortcuts,
  keyboardNoPauses,
  keyboardPasteRatio,
  keyboardReasons,
  keyboardTextWithoutKeydown,
  keyboardWindowMs,
  MIN_HOLD_MS,
  MIN_INPUTS_WITH_PASTE,
  MIN_KEY_DOWNS,
  MIN_KEY_WINDOW_MS,
  NO_PAUSES_MIN_DOWNS,
  NO_PAUSES_MIN_WINDOW_MS,
  ORPHAN_TEXT_MIN_INPUTS,
  ORPHAN_TEXT_RATIO,
  PAUSE_FACTOR,
  PAUSE_MIN_MS,
  SHORTCUT_GAP_MS,
} from "./features/keyboard";
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
  InputSample,
  InputTypeCode,
  KeyCategory,
  KeySample,
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
