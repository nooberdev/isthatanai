import { describe, expect, it } from "bun:test";
import { t } from "../src/i18n";
import { translateReasons } from "../src/i18n/reason-translator";
import type { ClickFeatures, ScrollFeatures } from "../src/index";
import {
  CLICK_FEATURE_WEIGHTS,
  clickReasons,
  SCROLL_FEATURE_WEIGHTS,
  scrollReasons,
} from "../src/index";

// Las funciones de features siguen produciendo las cadenas históricas en
// español; la API pública las localiza. El test aplica el mismo puente.
function toEnglish(reasons: string[]): string[] {
  return translateReasons(reasons, "en");
}

function clickFeatures(value: number): ClickFeatures {
  return Object.fromEntries(
    Object.keys(CLICK_FEATURE_WEIGHTS).map((key) => [key, value]),
  ) as ClickFeatures;
}

function scrollFeatures(value: number): ScrollFeatures {
  return Object.fromEntries(
    Object.keys(SCROLL_FEATURE_WEIGHTS).map((key) => [key, value]),
  ) as ScrollFeatures;
}

describe("razones ponderadas", () => {
  it("click: medidas con peso 0 nunca aparecen, aunque valgan 1", () => {
    const reasons = toEnglish(clickReasons(clickFeatures(1), 7));
    expect(reasons).toContain(t("reason.click.intervalRegularity", "en"));
    expect(reasons).toContain(t("reason.click.burstiness", "en"));
    expect(reasons).toContain(t("reason.click.durationRegularity", "en"));
    expect(reasons).toContain(t("reason.click.aimConsistency", "en"));
    // Peso 0: deriva, botón único y pausas (los falsos positivos del E2E).
    expect(reasons).not.toContain(t("reason.click.downUpDrift", "en"));
    expect(reasons).not.toContain(t("reason.click.singleButton", "en"));
    expect(reasons).not.toContain(t("reason.click.noPauses", "en"));
  });

  it("scroll: medidas con peso 0 nunca aparecen, aunque valgan 1", () => {
    const reasons = toEnglish(scrollReasons(scrollFeatures(1), 7));
    expect(reasons).toContain(t("reason.scroll.intervalRegularity", "en"));
    expect(reasons).toContain(t("reason.scroll.decelerationProfile", "en"));
    expect(reasons).toContain(t("reason.scroll.deltaUniformity", "en"));
    expect(reasons).toContain(t("reason.scroll.noPauses", "en"));
    expect(reasons).toContain(t("reason.scroll.roundDeltas", "en"));
    // Peso 0 en scroll: solo axisLock. `directionChanges` sí pesa 0.10 y
    // por la regla weighted-only debe seguir apareciendo.
    expect(reasons).toContain(t("reason.scroll.directionChanges", "en"));
    expect(reasons).not.toContain(t("reason.scroll.axisLock", "en"));
  });

  it("solo medidas con peso 0 por encima del umbral -> sin razones", () => {
    const clicks = clickFeatures(0.5) as Record<keyof ClickFeatures, number>;
    clicks.downUpDrift = 1;
    clicks.singleButton = 1;
    clicks.noPauses = 1;
    expect(toEnglish(clickReasons(clicks as ClickFeatures, 7))).toEqual([]);

    const scrolls = scrollFeatures(0.5) as Record<keyof ScrollFeatures, number>;
    scrolls.axisLock = 1;
    expect(toEnglish(scrollReasons(scrolls as ScrollFeatures, 7))).toEqual([]);
  });

  it("se ordenan por peso × valor, no solo por valor", () => {
    const clicks = clickFeatures(0.5) as Record<keyof ClickFeatures, number>;
    clicks.burstiness = 0.6; // 0.30 × 0.60 = 0.18
    clicks.durationRegularity = 1; // 0.10 × 1 = 0.10 (valor mayor, aporte menor)
    clicks.intervalRegularity = 1; // 0.35 × 1 = 0.35
    expect(toEnglish(clickReasons(clicks as ClickFeatures, 3))).toEqual([
      t("reason.click.intervalRegularity", "en"),
      t("reason.click.burstiness", "en"),
      t("reason.click.durationRegularity", "en"),
    ]);

    const scrolls = scrollFeatures(0.5) as Record<keyof ScrollFeatures, number>;
    scrolls.roundDeltas = 1; // 0.05 × 1 = 0.05
    scrolls.noPauses = 1; // 0.10 × 1 = 0.10
    scrolls.intervalRegularity = 0.8; // 0.45 × 0.8 = 0.36
    expect(toEnglish(scrollReasons(scrolls as ScrollFeatures, 3))).toEqual([
      t("reason.scroll.intervalRegularity", "en"),
      t("reason.scroll.noPauses", "en"),
      t("reason.scroll.roundDeltas", "en"),
    ]);
  });
});
