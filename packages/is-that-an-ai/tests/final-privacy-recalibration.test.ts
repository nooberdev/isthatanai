import { describe, expect, it } from "bun:test";
import {
  applyCalibration,
  type CalibrationResult,
  type CalibrationSession,
  calibrationFromSession,
} from "../src/calibration/recalibrate";
import { aggregatesOnlyStats, doNotTrack, roundTiming } from "../src/utils/privacy-shape";

// Cobertura final de los ítems L205/L206/L207 (forma de datos privada) y L224
// (recalibración acotada a partir de una sesión local). Los "secretos" son
// marcadores inventados: sirven para demostrar que NUNCA aparecen en la salida.

const SECRET = "SECRET-DO-NOT-EXPOSE-9f3b";

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function child(code: string): ChildResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", code],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function fromDeltas(deltas: number[], start = 1000): number[] {
  let t = start;
  return deltas.map((delta) => {
    t += delta;
    return t;
  });
}

function keySession(deltas: number[], hold: number): CalibrationSession {
  const times = fromDeltas(deltas);
  const keys: NonNullable<CalibrationSession["keys"]> = [];
  for (let i = 0; i < times.length; i += 1) {
    const category = i % 8;
    keys.push({ t: times[i], kind: 0, category, trusted: 1 });
    keys.push({ t: times[i] + hold, kind: 1, category, trusted: 1 });
  }
  return { keys };
}

function pointerSession(deltas: number[]): CalibrationSession {
  const times = fromDeltas(deltas, 2000);
  return {
    points: times.map((t, i) => ({ t, x: i * 1.5, y: i * 2.5, trusted: 1 })),
  };
}

const HUMAN_DELTAS = [180, 220, 150, 260, 190, 210, 170, 240, 200, 230, 160, 250, 185, 215, 195];
const HUMAN_POINTER = [
  42, 58, 37, 66, 51, 45, 70, 39, 55, 62, 44, 68, 48, 57, 41, 64, 53, 60, 46, 69, 50, 43, 61, 56,
];
const SLOWER_DELTAS = [280, 310, 250, 330, 290, 300, 270, 320, 285, 305, 260, 315, 295, 275, 305];

function humanSession(): CalibrationSession {
  return { ...keySession(HUMAN_DELTAS, 90), ...pointerSession(HUMAN_POINTER) };
}

function botSession(): CalibrationSession {
  return {
    ...keySession(Array(15).fill(10), 5),
    ...pointerSession(Array(24).fill(8)),
  };
}

function factorsInBounds(result: CalibrationResult): boolean {
  return Object.values(result.adjustments).every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0.8 && value <= 1.2,
  );
}

describe("L206: roundTiming elimina precisión identificatoria", () => {
  it("redondea al paso por defecto (50 ms) y a pasos explícitos", () => {
    expect(roundTiming(124)).toBe(100);
    expect(roundTiming(126)).toBe(150);
    expect(roundTiming(1000)).toBe(1000);
    expect(roundTiming(1234, 100)).toBe(1200);
    expect(roundTiming(127, 25)).toBe(125);
    expect(roundTiming(124) % 50).toBe(0);
    expect(roundTiming(1234, 100) % 100).toBe(0);
  });

  it("entradas hostiles: NaN -> 0, infinitos y negativos -> 0, pasos inválidos -> 50", () => {
    expect(roundTiming(Number.NaN)).toBe(0);
    expect(roundTiming(Number.POSITIVE_INFINITY)).toBe(0);
    expect(roundTiming(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(roundTiming(-125)).toBe(0);
    expect(roundTiming(126, 0)).toBe(150);
    expect(roundTiming(126, -5)).toBe(150);
    expect(roundTiming(126, Number.NaN)).toBe(150);
    expect(roundTiming(126, Number.POSITIVE_INFINITY)).toBe(150);
    expect(roundTiming(1e308, 1e-300)).toBe(0);
    for (const t of [124, 126, -5, Number.NaN, 1e308]) {
      expect(Number.isFinite(roundTiming(t))).toBe(true);
    }
  });
});

describe("L205: aggregatesOnlyStats expone solo conteos y tiempos redondeados", () => {
  it("publica SOLO conteos y timings; nunca timestamps, identidades ni tasas", () => {
    const stats: Record<string, unknown> = {
      sampleCount: 12.9,
      keyCount: 7,
      totalEvents: 3,
      meanMs: 187,
      p50Ms: 124,
      durationMs: 1000,
      lastEventAt: 1_700_000_000_000,
      timestamp: 12_345,
      timeStamp: 123,
      rawT: 7,
      t: 99,
      key: SECRET,
      keyId: SECRET,
      letter: "a",
      char: "z",
      text: SECRET,
      value: SECRET,
      code: SECRET,
      password: SECRET,
      trustedRatio: 0.9,
      bufferFill: 0.5,
      eventsPerSecond: 4,
      points: [1, 2, 3],
      nested: { meanMs: 5 },
      nanMs: Number.NaN,
      infMs: Number.POSITIVE_INFINITY,
    };

    const out = aggregatesOnlyStats(stats);
    expect(Object.keys(out).sort()).toEqual([
      "durationMs",
      "keyCount",
      "meanMs",
      "p50Ms",
      "sampleCount",
      "totalEvents",
    ]);
    expect(out).toEqual({
      sampleCount: 12,
      keyCount: 7,
      totalEvents: 3,
      meanMs: 200,
      p50Ms: 100,
      durationMs: 1000,
    });

    const json = JSON.stringify(out);
    for (const forbidden of [
      SECRET,
      "lastEventAt",
      "timestamp",
      "timeStamp",
      "rawT",
      "trustedRatio",
      "bufferFill",
      "eventsPerSecond",
      "points",
      "nested",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("fail-closed con entradas nulas, getters que lanzan y valores no numéricos", () => {
    expect(aggregatesOnlyStats(null as unknown as Record<string, unknown>)).toEqual({});
    expect(aggregatesOnlyStats(42 as unknown as Record<string, unknown>)).toEqual({});

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "meanMs", {
      enumerable: true,
      get(): number {
        throw new Error("boom meanMs");
      },
    });
    Object.defineProperty(hostile, "sampleCount", { enumerable: true, value: 5 });
    Object.defineProperty(hostile, "key", { enumerable: true, value: SECRET });
    expect(() => aggregatesOnlyStats(hostile)).not.toThrow();
    expect(aggregatesOnlyStats(hostile)).toEqual({ sampleCount: 5 });
    expect(JSON.stringify(aggregatesOnlyStats(hostile))).not.toContain(SECRET);
  });
});

describe("L207: doNotTrack es inyectable, solo runtime y SSR-safe", () => {
  it("pistas inyectadas: '1'/1/true -> true; todo lo demás -> false", () => {
    expect(doNotTrack({ doNotTrack: "1" })).toBe(true);
    expect(doNotTrack({ doNotTrack: 1 })).toBe(true);
    expect(doNotTrack({ doNotTrack: true })).toBe(true);
    for (const value of ["0", 0, false, "yes", "", null, undefined, {}, [], SECRET]) {
      expect(doNotTrack({ doNotTrack: value })).toBe(false);
    }
    // Pista ausente NO consulta el navegador cuando el objeto no la contiene.
    expect(doNotTrack({})).toBe(false);
    expect(doNotTrack(undefined)).toBe(false);
  });

  it("pista hostil que lanza no derriba la llamada", () => {
    const hostile = new Proxy(
      {},
      {
        get(): unknown {
          throw new Error("boom get");
        },
        getOwnPropertyDescriptor(): undefined {
          throw new Error("boom descriptor");
        },
      },
    );
    expect(() => doNotTrack(hostile)).not.toThrow();
    expect(doNotTrack(hostile)).toBe(false);
  });

  it("navegador: solo en runtime, doNotTrack/msDoNotTrack y SSR sin navigator", () => {
    const url = new URL("../src/utils/privacy-shape.ts", import.meta.url).href;
    const runtime = child(
      [
        `const { doNotTrack } = await import(${JSON.stringify(url)});`,
        'const set = (nav) => Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });',
        'set({ doNotTrack: "1" }); console.log(String(doNotTrack()));',
        'set({ doNotTrack: "0" }); console.log(String(doNotTrack()));',
        'set({ msDoNotTrack: "1" }); console.log(String(doNotTrack()));',
        "set({}); console.log(String(doNotTrack()));",
        'Reflect.deleteProperty(globalThis, "navigator"); console.log(String(doNotTrack()));',
      ].join("\n"),
    );
    expect(runtime.exitCode).toBe(0);
    expect(runtime.stdout.trim().split("\n")).toEqual(["true", "false", "true", "false", "false"]);

    // Importar con un getter de navigator que lanza demuestra que NO se toca
    // el DOM al importar; la llamada en runtime tampoco lanza y falla cerrado.
    const ssr = child(
      [
        'Object.defineProperty(globalThis, "navigator", { configurable: true, get() { throw new Error("navigator-touched"); } });',
        `const mod = await import(${JSON.stringify(url)});`,
        "console.log(typeof mod.doNotTrack);",
        "console.log(String(mod.doNotTrack()));",
        'console.log(String(mod.doNotTrack({ doNotTrack: "1" })));',
      ].join("\n"),
    );
    expect(ssr.exitCode).toBe(0);
    expect(ssr.stdout.trim().split("\n")).toEqual(["function", "false", "true"]);
  });
});

describe("L224: recalibración deriva ajustes reales, acotados y por sesión", () => {
  it("sesión humana: aplica, cuenta muestras y produce factores dentro de ±20 %", () => {
    const result = calibrationFromSession(humanSession());
    expect(result.applied).toBe(true);
    expect(result.samples).toBeGreaterThanOrEqual(12 + 24);
    expect(Object.keys(result.adjustments).sort()).toEqual(["pauseMs", "rhythmTolerance"]);
    expect(factorsInBounds(result)).toBe(true);
    expect(result.reasons).toContain("calibrated-from-keys");
    expect(result.reasons).toContain("calibrated-from-pointer");
    // El factor NO es neutro por defecto: viene del ritmo observado.
    expect(result.adjustments.rhythmTolerance).not.toBe(1);
    expect(result.adjustments.pauseMs).not.toBe(1);
  });

  it("sesiones distintas producen ajustes distintos (no valores constantes)", () => {
    const human = calibrationFromSession(humanSession());
    const slower = calibrationFromSession({
      ...keySession(SLOWER_DELTAS, 90),
      ...pointerSession(HUMAN_POINTER),
    });
    const bot = calibrationFromSession(botSession());

    expect(human.applied && slower.applied && bot.applied).toBe(true);
    expect(human.adjustments).not.toEqual(slower.adjustments);
    expect(human.adjustments).not.toEqual(bot.adjustments);

    const many = [bot, human, slower, calibrationFromSession(keySession(Array(15).fill(1e6), 5e5))];
    const rhythms = new Set(many.map((r) => r.adjustments.rhythmTolerance));
    expect(rhythms.size).toBeGreaterThanOrEqual(3);
  });

  it("bot metronómico recibe ajustes MÁS estrictos, nunca una dispensa", () => {
    const result = calibrationFromSession(botSession());
    expect(result.applied).toBe(true);
    expect(result.adjustments.rhythmTolerance).toBeLessThan(1);
    expect(result.adjustments.pauseMs).toBeGreaterThan(1);
    const applied = applyCalibration({ pauseMs: 1000, rhythmTolerance: 0.5 }, result);
    expect(applied.pauseMs).toBeGreaterThan(1000);
    expect(applied.rhythmTolerance).toBeLessThan(0.5);
  });

  it("rechaza pocas muestras: ni 12 keydowns ni 20 muestras de puntero", () => {
    const fewKeys = calibrationFromSession(keySession(Array(10).fill(100), 90));
    const fewPointer = calibrationFromSession(pointerSession(Array(18).fill(50)));
    for (const result of [fewKeys, fewPointer]) {
      expect(result.applied).toBe(false);
      expect(result.adjustments).toEqual({});
      expect(result.reasons).toContain("insufficient-samples");
    }
    // justo en el umbral sí aplica.
    expect(calibrationFromSession(keySession(Array(12).fill(150), 90)).applied).toBe(true);
    expect(calibrationFromSession(pointerSession(Array(20).fill(45))).applied).toBe(true);
  });

  it("sesiones hostiles/malformadas no lanzan y nunca filtran secretos", () => {
    const hostile = new Proxy(
      {},
      {
        get(): unknown {
          throw new Error("boom get");
        },
        getOwnPropertyDescriptor(): undefined {
          throw new Error("boom descriptor");
        },
      },
    );
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      SECRET,
      [],
      {},
      hostile,
      {
        keys: [null, SECRET, 7, { t: Number.NaN }, { t: -1 }, { t: Number.POSITIVE_INFINITY }],
        points: ["x", { t: -5 }, hostile],
        inputs: [{ t: SECRET }, { t: 10 }],
        verdict: "human",
      },
    ];
    for (const session of malformed) {
      const run = (): CalibrationResult => calibrationFromSession(session);
      expect(run).not.toThrow();
      const result = run();
      expect(typeof result.applied).toBe("boolean");
      expect(Number.isFinite(result.samples)).toBe(true);
      expect(result.reasons.every((reason) => typeof reason === "string")).toBe(true);
      if (result.applied) expect(factorsInBounds(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain("human");
    }
  });

  it("extremos: los factores se saturan en 0.8/1.2 y los umbrales en rangos seguros", () => {
    const ultraFast = calibrationFromSession(keySession(Array(15).fill(0.001), 0.001));
    const ultraSlow = calibrationFromSession(keySession(Array(15).fill(1e6), 5e5));
    expect(ultraFast.adjustments).toEqual({ pauseMs: 1.2, rhythmTolerance: 0.8 });
    expect(ultraSlow.adjustments).toEqual({ pauseMs: 0.8, rhythmTolerance: 1.2 });

    const applied = applyCalibration({ pauseMs: 1e9, rhythmTolerance: 5 }, ultraFast);
    expect(applied).toEqual({ pauseMs: 3000, rhythmTolerance: 0.9 });
    expect(applyCalibration({ pauseMs: -5, rhythmTolerance: -1 }, ultraSlow)).toEqual({
      pauseMs: 400,
      rhythmTolerance: 0.1,
    });
  });

  it("NUNCA hay salida directa de veredicto ni desactivación de compuertas", () => {
    // Sesión forjada con campos que intentan fijar el resultado. Se ignoran.
    const forged = {
      ...humanSession(),
      verdict: "human",
      state: "human",
      bypass: true,
      trusted: true,
      pauseMs: 0,
      rhythmTolerance: 1,
      adjustments: { pauseMs: 99, rhythmTolerance: 99 },
    };
    const result = calibrationFromSession(forged);
    expect(Object.keys(result).sort()).toEqual(["adjustments", "applied", "reasons", "samples"]);
    expect(Object.keys(result.adjustments).sort()).toEqual(["pauseMs", "rhythmTolerance"]);
    expect(factorsInBounds(result)).toBe(true);
    expect(result.reasons.join(" ")).not.toMatch(/verdict|humano|human|bot|bypass|gate|pass/i);
    const json = JSON.stringify(result);
    for (const word of ["verdict", "bypass", "state", "human", "trusted"]) {
      expect(json).not.toContain(word);
    }

    // Ni siquiera un resultado forjado puede introducir un veredicto al aplicar.
    const fake = {
      applied: true,
      samples: 999,
      verdict: "human",
      adjustments: { pauseMs: 99, rhythmTolerance: -99, verdict: "human", bypass: true },
      reasons: ["human"],
    } as unknown as CalibrationResult;
    const applied = applyCalibration({ pauseMs: 1000, rhythmTolerance: 0.5 }, fake);
    expect(Object.keys(applied).sort()).toEqual(["pauseMs", "rhythmTolerance"]);
    expect(applied).toEqual({ pauseMs: 1200, rhythmTolerance: 0.4 });
    expect(JSON.stringify(applied)).not.toContain("human");
  });

  it("sin evidencia no se inventa confianza: applied=false deja los umbrales intactos", () => {
    const empty = calibrationFromSession({});
    expect(empty.applied).toBe(false);
    expect(empty.adjustments).toEqual({});
    const applied = applyCalibration({ pauseMs: 1000, rhythmTolerance: 0.5 }, empty);
    expect(applied).toEqual({ pauseMs: 1000, rhythmTolerance: 0.5 });
    expect(Object.keys(applied)).not.toContain("state");
    expect(Object.keys(applied)).not.toContain("verdict");
  });

  it("applyCalibration usa los factores reales de la sesión y re-clampa entradas hostiles", () => {
    const result = calibrationFromSession(humanSession());
    const applied = applyCalibration({ pauseMs: 1000, rhythmTolerance: 0.5 }, result);
    expect(applied.pauseMs).toBeCloseTo(1000 * result.adjustments.pauseMs, 6);
    expect(applied.rhythmTolerance).toBeCloseTo(0.5 * result.adjustments.rhythmTolerance, 6);

    // Bases no finitas -> defaults neutrales (a los que se aplica el factor
    // de la sesión); nunca NaN en la salida.
    const fromInvalidBase = applyCalibration(
      { pauseMs: Number.NaN, rhythmTolerance: Number.POSITIVE_INFINITY },
      result,
    );
    expect(fromInvalidBase.pauseMs).toBeCloseTo(1000 * result.adjustments.pauseMs, 6);
    expect(fromInvalidBase.rhythmTolerance).toBeCloseTo(
      0.5 * result.adjustments.rhythmTolerance,
      6,
    );
    expect(Number.isFinite(fromInvalidBase.pauseMs)).toBe(true);
    expect(
      applyCalibration(
        { pauseMs: 1000, rhythmTolerance: 0.5 },
        null as unknown as CalibrationResult,
      ),
    ).toEqual({ pauseMs: 1000, rhythmTolerance: 0.5 });
  });

  it("SSR: importar recalibrate sin DOM y calibrar una sesión funciona", () => {
    const url = new URL("../src/calibration/recalibrate.ts", import.meta.url).href;
    const result = child(
      [
        'Reflect.deleteProperty(globalThis, "window");',
        'Reflect.deleteProperty(globalThis, "document");',
        'Reflect.deleteProperty(globalThis, "navigator");',
        `const mod = await import(${JSON.stringify(url)});`,
        "const session = { keys: Array.from({ length: 15 }, (_, i) => ({ t: i * 180, kind: 0, category: i % 8 })) };",
        "const out = mod.calibrationFromSession(session);",
        "console.log(String(out.applied));",
        "console.log(String(Object.keys(out.adjustments).sort().join(',')));",
      ].join("\n"),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["true", "pauseMs,rhythmTolerance"]);
  });
});
