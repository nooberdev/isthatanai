// Superficie pública de la librería. Sin acceso a window/document/navigator al importar.

export { autoStart } from "./auto-start";
export type { ReferenceQuantiles } from "./calibration/external-reference";
export {
  AGENT_KEYBOARD_REFERENCE,
  CMU_KEYBOARD_REFERENCE,
  FURTHER_REFERENCES,
} from "./calibration/external-reference";
export type { HumanTypingBaseline, TypingDistribution } from "./calibration/human-typing";
// Perfil de teclado humano calibrado con una sesión real (solo tiempos/conteos).
export {
  EXACT_RHYTHM_UNIQUE_HIGH,
  EXACT_RHYTHM_UNIQUE_LOW,
  HUMAN_PAUSE_MS,
  HUMAN_TYPING_BASELINE,
  HUMAN_UNIQUE_INTERVAL_SHARE,
} from "./calibration/human-typing";
export * from "./calibration/recalibrate";
export * from "./collectors/attention";
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
// Superficie adicional de la última tanda del checklist: se re-exporta completa
// para que todas las medidas y tipos nuevos estén disponibles al consumidor.
export * from "./collectors/touch";
export type { CoherenceDetailed, CoherenceSignals } from "./core/coherence";
export {
  evaluateCoherence,
  evaluateCoherenceDetailed,
  PRIOR_EVENT_LOOKBACK_MS,
} from "./core/coherence";
// Etapa 10: coherencia, replay, integridad, liveness, sorpresa y ruido.
export type { LivenessCallback } from "./core/detector";
export { IsThatAnAI } from "./core/detector";
export type { DeviceHints, ResolvedDeviceProfile } from "./core/device-profile";
export {
  DETAILED_TO_COARSE,
  inferDetailedDevice,
  inferDeviceProfile,
  TV_MIN_KEY_DOWNS,
  TV_NAV_SHARE,
} from "./core/device-profile";
export * from "./core/environment";
export { declaredVsBehavior, humanizationRisk, injectionRisk } from "./core/injection";
export type { LivenessStatus } from "./core/liveness";
export { LivenessMonitor } from "./core/liveness";
export { formulaRhythm, noiseHumanity } from "./core/noise";
export type { ReplayInput, ReplaySignals } from "./core/replay";
export { detectReplay, ReplayTracker } from "./core/replay";
export type { SurpriseCheck, SurpriseInput } from "./core/surprise";
export { surpriseCoherenceCheck } from "./core/surprise";
export type { IntegrityReport } from "./core/tamper";
export { integrityFingerprint, verifyIntegrity } from "./core/tamper";
export * from "./features/attention";
export type { ClickFeatures, ClickPartialFeatures } from "./features/click";
export * from "./features/click";
// Medidas de click y scroll (funciones puras, sin DOM ni layout).
export {
  CLICK_FEATURE_WEIGHTS,
  CLICK_NEUTRAL,
  CLICK_PARTIAL_FEATURE_WEIGHTS,
  clickAimConsistency,
  clickBurstiness,
  clickDoubleClickRhythm,
  clickDownUpDrift,
  clickDurationRegularity,
  clickInstantaneous,
  clickIntervalRegularity,
  clickNoPauses,
  clickReasons,
  clickSecondaryButtons,
  clickSingleButton,
  computeClickScore,
  extractClickFeatures,
  extractPartialClickFeatures,
} from "./features/click";
export type { KeyboardFeatures } from "./features/keyboard";
export * from "./features/keyboard";
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
  keyboardArrowUsage,
  keyboardAutocompleteFalsePositive,
  keyboardCapitalization,
  keyboardCorrectionBursts,
  keyboardEnterSubmit,
  keyboardExactRhythm,
  keyboardHoldRegularity,
  keyboardIntervalDistribution,
  keyboardIntervalRegularity,
  keyboardModifierShortcuts,
  keyboardNoPauses,
  keyboardPasteRatio,
  keyboardPauseAfterError,
  keyboardProgrammaticKeys,
  keyboardReasons,
  keyboardSelectionDeletion,
  keyboardSentenceEndPauses,
  keyboardTextWithoutKeydown,
  keyboardTypingSpeed,
  keyboardWindowMs,
  keyboardWordPauses,
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
// Medidas adicionales del checklist (peso 0 por defecto: no alteran el score).
export type { MouseFeatures, MousePartialFeatures } from "./features/mouse";
export * from "./features/mouse";
// Medidas de mouse (funciones puras sobre PointerSample[]).
export {
  countSegments,
  extractMouseFeatures,
  extractPartialMouseFeatures,
  MOUSE_PARTIAL_FEATURE_WEIGHTS,
  mouseAverageSpeed,
  mouseBellProfile,
  mouseClickPrecision,
  mouseCorrectedMisses,
  mouseCurvature,
  mouseDeviceType,
  mouseDirectionChanges,
  mouseEdgeEntries,
  mouseFineCorrection,
  mouseImpossibleSpeed,
  mouseIntervalRegularity,
  mouseJerk,
  mouseLargeJumps,
  mouseMicroPauses,
  mouseOvershoot,
  mouseRoundSteps,
  mouseSpeedUniformity,
  mouseSpeedVariation,
  mouseStraightness,
  mouseSubpixel,
  mouseTeleport,
  mouseTemporalResolution,
  mouseTremor,
  mouseTurnSmoothness,
  mouseZigzag,
  NEUTRAL,
} from "./features/mouse";
export type { ScrollFeatures, ScrollPartialFeatures } from "./features/scroll";
export * from "./features/scroll";
export {
  AUTOSCROLL_MAX_ABS_DY,
  AUTOSCROLL_MAX_MEDIAN_DT_MS,
  AUTOSCROLL_MIN_SAMPLES,
  computeScrollScore,
  extractPartialScrollFeatures,
  extractScrollFeatures,
  SCROLL_FEATURE_WEIGHTS,
  SCROLL_NEUTRAL,
  SCROLL_PARTIAL_FEATURE_WEIGHTS,
  scrollAxisLock,
  scrollDecelerationProfile,
  scrollDeltaUniformity,
  scrollDirectionChanges,
  scrollInstantEnd,
  scrollIntervalRegularity,
  scrollLargeJumps,
  scrollNoPauses,
  scrollReasons,
  scrollRoundDeltas,
  scrollSpeed,
  withoutAutoscroll,
} from "./features/scroll";
export * from "./features/touch";
export type { DetectorHandle } from "./frameworks/react";
export { createDetectorHandle, createReactDetector } from "./frameworks/react";
export { createSvelteDetector } from "./frameworks/svelte";
export { createVueDetector } from "./frameworks/vue";
export type { Locale, TranslationKey, TranslationParams } from "./i18n";
// i18n: 12 idiomas, detección del sistema y fallback a inglés.
export { detectLocale, LOCALES, t } from "./i18n";
export type {
  ScoredEvidence,
  ScoringConfig,
  ScoringSnapshot,
  SensitivityPreset,
} from "./scoring/score";
// Scoring.
export {
  ACCESSIBILITY_SCORE_FACTOR,
  ADVANCED_MAX_SHARE,
  AI_CORE,
  AI_MIN,
  computeScore,
  DEFAULT_SCORING_CONFIG,
  doubtFor,
  emptyGuardrailRisk,
  HUMAN_CORE,
  HUMAN_MAX,
  JITTER_SESSION_THRESHOLD,
  MIN_CLICKS,
  MIN_SCROLLS,
  MIN_SEGMENTS,
  MIN_WINDOW_MS,
  NO_JITTER_SEED,
  SCORED_SIGNALS,
  ScoreComputer,
  SENSITIVITIES,
  SENSITIVITY_PRESETS,
  SIGNAL_DIFFICULTY,
  SIGNAL_WEIGHTS,
  scoreReasons,
} from "./scoring/score";
export type { FeatureWeights } from "./scoring/weights";
// Coherencia, inyección, humanización y privacidad (checklist Etapa 10).
export type {
  ChangeCallback,
  ClickSample,
  Collector,
  CollectorStats,
  CombinationMode,
  ConfirmTimes,
  DetailedDevice,
  DetectorConfig,
  DetectorOptions,
  DeviceProfile,
  EmaInfo,
  GuardrailRiskEvidence,
  HandoverInfo,
  InputSample,
  InputTypeCode,
  KeyCategory,
  KeySample,
  Options,
  PointerKind,
  PointerSample,
  PointerTypeCode,
  PrivacyMode,
  Sample,
  Score,
  ScoreBreakdown,
  ScoredSignal,
  ScrollSample,
  Sensitivity,
  Signal,
  SignalScores,
  SignalWeights,
  ThresholdCallback,
  Thresholds,
  Verdict,
  VerdictCallback,
} from "./types";
export { PRIVACY_NOTICE, privacyAudit } from "./utils/privacy-audit";
export * from "./utils/privacy-shape";
