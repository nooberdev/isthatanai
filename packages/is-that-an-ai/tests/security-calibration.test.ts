import { describe, expect, it } from "bun:test";
import {
  AGENT_KEYBOARD_REFERENCE,
  CMU_KEYBOARD_REFERENCE,
  EXACT_RHYTHM_UNIQUE_HIGH,
  FURTHER_REFERENCES,
  HUMAN_PAUSE_MS,
  HUMAN_TYPING_BASELINE,
} from "../src/index";

import { weights as mouseWeights } from "../src/scoring/weights";

describe("endurecimiento de los datos de calibración", () => {
  it("el perfil humano no puede ser mutado por un script de la página", () => {
    const before = HUMAN_TYPING_BASELINE.wpm;
    const high = EXACT_RHYTHM_UNIQUE_HIGH;
    expect(Object.isFrozen(HUMAN_TYPING_BASELINE)).toBe(true);
    expect(Object.isFrozen(HUMAN_TYPING_BASELINE.counts)).toBe(true);
    expect(Object.isFrozen(HUMAN_TYPING_BASELINE.keyHoldMs)).toBe(true);
    expect(Object.isFrozen(HUMAN_TYPING_BASELINE.longPausesMs)).toBe(true);
    expect(() => {
      (HUMAN_TYPING_BASELINE as unknown as { wpm: number }).wpm = 999;
    }).toThrow();
    expect(() => {
      (HUMAN_TYPING_BASELINE.longPausesMs as unknown as number[]).push(1);
    }).toThrow();
    expect(HUMAN_TYPING_BASELINE.wpm).toBe(before);
    expect(EXACT_RHYTHM_UNIQUE_HIGH).toBe(high);
    expect(HUMAN_PAUSE_MS).toBe(1000);
  });

  it("la tabla de pesos del mouse no puede alterarse en caliente", () => {
    expect(Object.isFrozen(mouseWeights)).toBe(true);
    const before = mouseWeights.teleport;
    expect(() => {
      (mouseWeights as unknown as { teleport: number }).teleport = 0;
    }).toThrow();
    expect(mouseWeights.teleport).toBe(before);
  });

  it("las referencias externas son solo lectura", () => {
    expect(Object.isFrozen(FURTHER_REFERENCES)).toBe(true);
    expect(Object.isFrozen(FURTHER_REFERENCES[0])).toBe(true);
    expect(Object.isFrozen(CMU_KEYBOARD_REFERENCE)).toBe(true);
    expect(Object.isFrozen(CMU_KEYBOARD_REFERENCE.holdMs)).toBe(true);
    expect(Object.isFrozen(AGENT_KEYBOARD_REFERENCE)).toBe(true);
    expect(Object.isFrozen(AGENT_KEYBOARD_REFERENCE.interKeyMs)).toBe(true);
    expect(() => {
      (CMU_KEYBOARD_REFERENCE.holdMs as unknown as { p50: number }).p50 = 1;
    }).toThrow();
  });
});
