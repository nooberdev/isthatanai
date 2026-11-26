import { describe, expect, it } from "bun:test";
import type { ClickFeatures, ScrollFeatures } from "../src/index";
import {
  CLICK_FEATURE_WEIGHTS,
  clickReasons,
  SCROLL_FEATURE_WEIGHTS,
  scrollReasons,
} from "../src/index";

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
    const reasons = clickReasons(clickFeatures(1), 7);
    expect(reasons).toContain("Ritmo de clics demasiado regular");
    expect(reasons).toContain("Ráfagas de clics seguidos");
    expect(reasons).toContain("Duraciones de clic casi idénticas");
    expect(reasons).toContain("Puntería repetida en el mismo punto");
    // Peso 0: deriva, botón único y pausas (los falsos positivos del E2E).
    expect(reasons).not.toContain("Clic sin desplazamiento al soltar");
    expect(reasons).not.toContain("Un solo botón usado siempre");
    expect(reasons).not.toContain("Sin pausas entre clics");
  });

  it("scroll: medidas con peso 0 nunca aparecen, aunque valgan 1", () => {
    const reasons = scrollReasons(scrollFeatures(1), 7);
    expect(reasons).toContain("Ritmo de scroll demasiado regular");
    expect(reasons).toContain("Sin desaceleración al terminar el scroll");
    expect(reasons).toContain("Desplazamientos de scroll uniformes");
    expect(reasons).toContain("Sin pausas entre gestos de scroll");
    expect(reasons).toContain("Deltas de scroll numéricamente redondos");
    // Peso 0 en scroll: solo axisLock. `directionChanges` sí pesa 0.10 y
    // por la regla weighted-only debe seguir apareciendo.
    expect(reasons).toContain("Scroll siempre en la misma dirección");
    expect(reasons).not.toContain("Scroll bloqueado en un solo eje");
  });

  it("solo medidas con peso 0 por encima del umbral -> sin razones", () => {
    const clicks = clickFeatures(0.5) as Record<keyof ClickFeatures, number>;
    clicks.downUpDrift = 1;
    clicks.singleButton = 1;
    clicks.noPauses = 1;
    expect(clickReasons(clicks as ClickFeatures, 7)).toEqual([]);

    const scrolls = scrollFeatures(0.5) as Record<keyof ScrollFeatures, number>;
    scrolls.axisLock = 1;
    expect(scrollReasons(scrolls as ScrollFeatures, 7)).toEqual([]);
  });

  it("se ordenan por peso × valor, no solo por valor", () => {
    const clicks = clickFeatures(0.5) as Record<keyof ClickFeatures, number>;
    clicks.burstiness = 0.6; // 0.30 × 0.60 = 0.18
    clicks.durationRegularity = 1; // 0.10 × 1 = 0.10 (valor mayor, aporte menor)
    clicks.intervalRegularity = 1; // 0.35 × 1 = 0.35
    expect(clickReasons(clicks as ClickFeatures, 3)).toEqual([
      "Ritmo de clics demasiado regular",
      "Ráfagas de clics seguidos",
      "Duraciones de clic casi idénticas",
    ]);

    const scrolls = scrollFeatures(0.5) as Record<keyof ScrollFeatures, number>;
    scrolls.roundDeltas = 1; // 0.05 × 1 = 0.05
    scrolls.noPauses = 1; // 0.10 × 1 = 0.10
    scrolls.intervalRegularity = 0.8; // 0.45 × 0.8 = 0.36
    expect(scrollReasons(scrolls as ScrollFeatures, 3)).toEqual([
      "Ritmo de scroll demasiado regular",
      "Sin pausas entre gestos de scroll",
      "Deltas de scroll numéricamente redondos",
    ]);
  });
});
