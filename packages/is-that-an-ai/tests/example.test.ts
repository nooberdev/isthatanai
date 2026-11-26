import { describe, expect, it } from "bun:test";
import { IsThatAnAI } from "../src/index";

describe("IsThatAnAI (Etapa 4)", () => {
  it("arranca en estado measuring con el veredicto derivado de las muestras", () => {
    const detector = new IsThatAnAI();
    expect(detector.getVerdict()).toEqual({
      state: "measuring",
      score: null,
      confidence: 0,
      doubt: 1,
      reasons: [],
    });
  });
});
