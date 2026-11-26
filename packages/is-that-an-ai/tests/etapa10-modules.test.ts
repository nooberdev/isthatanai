// Etapa 10 — módulos independientes de combinación de señales y trampas.
// 100% determinista: sin reloj de pared, sin DOM real, sin red ni storage.
// Cubre TODOS los exports nuevos y entradas numéricas hostiles.

import { describe, expect, it } from "bun:test";
import { LivenessMonitor } from "../src/core/liveness";
import { formulaRhythm, noiseHumanity } from "../src/core/noise";
import {
  detectReplay,
  type ReplayInput,
  type ReplaySignals,
  ReplayTracker,
} from "../src/core/replay";
import { type SurpriseCheck, surpriseCoherenceCheck } from "../src/core/surprise";
import { type IntegrityReport, integrityFingerprint, verifyIntegrity } from "../src/core/tamper";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";

// ---------------------------------------------------------------------------
// Utilidades deterministas
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeSession(seed: number, n = 24): ReplayInput {
  const rng = lcg(seed);
  const points: PointerSample[] = Array.from({ length: n }, (_, i) => ({
    seq: i,
    x: rng() * 800,
    y: rng() * 600,
    t: i * 32 + rng() * 8,
    kind: 0,
    pointerType: 0,
    trusted: 1,
  }));
  const clicks: ClickSample[] = Array.from({ length: Math.floor(n / 2) }, (_, i) => ({
    seq: i,
    x: 100 + rng() * 300,
    y: 100 + rng() * 200,
    t: i * 90 + rng() * 5,
    kind: (i % 2) as 0 | 1,
    button: 0,
    trusted: 1,
  }));
  const scrolls: ScrollSample[] = Array.from({ length: Math.floor(n / 2) }, (_, i) => ({
    seq: i,
    dx: rng() * 20 - 10,
    dy: rng() * 40 - 20,
    t: i * 120 + rng() * 6,
    trusted: 1,
    source: 0,
  }));
  const keys: KeySample[] = Array.from({ length: n }, (_, i) => ({
    seq: i,
    t: i * 55 + rng() * 7,
    kind: (i % 2) as 0 | 1,
    category: (i % 8) as KeySample["category"],
    trusted: 1,
  }));
  const inputs: InputSample[] = Array.from({ length: Math.floor(n / 3) }, (_, i) => ({
    seq: i,
    t: i * 70 + rng() * 4,
    kind: 0,
    inputType: (i % 6) as InputSample["inputType"],
    trusted: 1,
  }));
  return { points, clicks, scrolls, keys, inputs };
}

function clone(input: ReplayInput): ReplayInput {
  return {
    points: input.points.map((s) => ({ ...s })),
    clicks: input.clicks.map((s) => ({ ...s })),
    scrolls: input.scrolls.map((s) => ({ ...s })),
    keys: input.keys.map((s) => ({ ...s })),
    inputs: input.inputs.map((s) => ({ ...s })),
  };
}

function expectUnit(value: number, label: string): void {
  expect(typeof value, `${label}: tipo`).toBe("number");
  expect(Number.isFinite(value), `${label}: finito`).toBe(true);
  expect(value, `${label}: >= 0`).toBeGreaterThanOrEqual(0);
  expect(value, `${label}: <= 1`).toBeLessThanOrEqual(1);
}

function expectSignals(signals: ReplaySignals, label: string): void {
  for (const key of ["repeatedPath", "repeatedTiming", "identicalSequence"] as const) {
    expectUnit(signals[key], `${label}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// replay.ts
// ---------------------------------------------------------------------------

describe("replay: detectReplay", () => {
  it("una sesión idéntica da 1 en las tres señales", () => {
    const original = makeSession(0xa11ce);
    const signals = detectReplay(original, clone(original));
    expectSignals(signals, "idéntica");
    expect(signals.repeatedPath).toBe(1);
    expect(signals.repeatedTiming).toBe(1);
    expect(signals.identicalSequence).toBe(1);
  });

  it("una sesión nueva (otro seed) no se marca como replay", () => {
    const a = makeSession(0x1234);
    const b = makeSession(0x9876);
    const signals = detectReplay(a, b);
    expectSignals(signals, "nueva");
    expect(signals.identicalSequence).toBeLessThan(0.6);
    expect(signals.repeatedPath).toBeLessThan(0.7);
  });

  it("replay truncado y desplazado puntúa menos que uno idéntico pero más que una sesión nueva", () => {
    const original = makeSession(0xbeef);
    const identical = detectReplay(original, clone(original)).identicalSequence;

    const truncated: ReplayInput = {
      points: original.points.slice(0, Math.floor(original.points.length * 0.6)),
      clicks: original.clicks.slice(0, Math.floor(original.clicks.length * 0.6)),
      scrolls: original.scrolls.slice(0, Math.floor(original.scrolls.length * 0.6)),
      keys: original.keys.slice(0, Math.floor(original.keys.length * 0.6)),
      inputs: original.inputs.slice(0, Math.floor(original.inputs.length * 0.6)),
    };
    const cut = detectReplay(original, truncated);
    expectSignals(cut, "truncado");
    expect(cut.identicalSequence).toBeGreaterThan(0);
    expect(cut.identicalSequence).toBeLessThan(identical);

    // Desplazamiento constante de coordenadas y de `t`: sigue siendo el mismo
    // replay, la normalización por media y centrado debe conservarlo.
    const shifted: ReplayInput = {
      points: original.points.map((s) => ({
        ...s,
        x: s.x + 250,
        y: s.y - 120,
        t: s.t + 10_000,
      })),
      clicks: original.clicks.map((s) => ({ ...s, t: s.t + 10_000 })),
      scrolls: original.scrolls.map((s) => ({ ...s, t: s.t + 10_000 })),
      keys: original.keys.map((s) => ({ ...s, t: s.t + 10_000 })),
      inputs: original.inputs.map((s) => ({ ...s, t: s.t + 10_000 })),
    };
    const shiftedSignals = detectReplay(original, shifted);
    expectSignals(shiftedSignals, "desplazado");
    expect(shiftedSignals.repeatedTiming).toBe(1);
    expect(shiftedSignals.repeatedPath).toBeGreaterThan(0.8);
    expect(shiftedSignals.identicalSequence).toBeGreaterThan(0.8);

    // Desplazamiento de VENTANA (se descartan las primeras muestras): señal
    // parcial, nunca igual que la copia exacta ni igual que una sesión nueva.
    const skipped = Math.floor(original.points.length * 0.2);
    const windowed: ReplayInput = {
      points: original.points.slice(skipped),
      clicks: original.clicks,
      scrolls: original.scrolls,
      keys: original.keys,
      inputs: original.inputs,
    };
    const windowedSignals = detectReplay(original, windowed);
    expectSignals(windowedSignals, "ventana desplazada");
    expect(windowedSignals.identicalSequence).toBeGreaterThan(0);
    expect(windowedSignals.identicalSequence).toBeLessThan(identical);
  });

  it("sin evidencia no acusa (fail closed)", () => {
    const empty: ReplayInput = { points: [], clicks: [], scrolls: [], keys: [], inputs: [] };
    expect(detectReplay(empty, empty)).toEqual({
      repeatedPath: 0,
      repeatedTiming: 0,
      identicalSequence: 0,
    });
    expect(detectReplay(makeSession(1), empty).identicalSequence).toBe(0);
  });

  it("nunca compara texto: solo categorías numéricas de teclado", () => {
    const a = makeSession(0x321);
    const b = clone(a);
    // Dos "textos" distintos con las mismas categorías numéricas son iguales.
    for (let i = 0; i < b.keys.length; i += 1) b.keys[i].category = a.keys[i].category;
    expect(detectReplay(a, b).identicalSequence).toBe(1);
  });

  it("entradas hostiles (NaN/Infinity/negativas/enormes) siguen en [0,1]", () => {
    const rng = lcg(0x0bad);
    const evil = [...makeSession(7).points];
    for (let i = 0; i < evil.length; i += 1) {
      const pick = Math.floor(rng() * 4);
      evil[i] = {
        ...evil[i],
        x:
          pick === 0
            ? Number.NaN
            : pick === 1
              ? Number.POSITIVE_INFINITY
              : pick === 2
                ? -1e308
                : evil[i].x,
        y: pick === 0 ? Number.NEGATIVE_INFINITY : evil[i].y,
        t: pick === 3 ? -1000 : evil[i].t,
      };
    }
    const hostile: ReplayInput = {
      points: evil,
      clicks: [],
      scrolls: [],
      keys: [],
      inputs: [],
    };
    expectSignals(detectReplay(hostile, clone(hostile)), "hostil");
    expectSignals(detectReplay(hostile, makeSession(9)), "hostil vs normal");
    // API defendida también contra null/undefined en tiempo de ejecución.
    expectSignals(detectReplay(null as unknown as ReplayInput, makeSession(1)), "null");
    expectSignals(
      detectReplay(undefined as unknown as ReplayInput, undefined as unknown as ReplayInput),
      "undefined",
    );
  });
});

describe("replay: ReplayTracker", () => {
  it("detecta un replay dentro del historial y se limpia con reset()", () => {
    const tracker = new ReplayTracker({ historySize: 4 });
    const a = makeSession(0x5150);
    const b = makeSession(0x5151);
    expectSignals(tracker.signals(), "sin muestras");
    tracker.push(a);
    expect(tracker.signals().identicalSequence).toBe(0);
    tracker.push(b);
    tracker.push(clone(a));
    expect(tracker.signals().identicalSequence).toBe(1);
    tracker.reset();
    expect(tracker.signals().identicalSequence).toBe(0);
  });

  it("historySize hostil usa un default finito y acotado", () => {
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 1e12]) {
      const tracker = new ReplayTracker({ historySize: size });
      expect(() => tracker.push(makeSession(3))).not.toThrow();
      expectSignals(tracker.signals(), `historySize=${size}`);
    }
  });

  it("copia la instantánea: mutar el original después no altera las señales", () => {
    const tracker = new ReplayTracker({ historySize: 2 });
    const a = makeSession(0xabc);
    tracker.push(a);
    for (const point of a.points) {
      point.x = 0;
      point.y = 0;
      point.t = 0;
    }
    tracker.push(clone(a));
    expectSignals(tracker.signals(), "copia");
  });
});

// ---------------------------------------------------------------------------
// tamper.ts
// ---------------------------------------------------------------------------

describe("tamper: verifyIntegrity", () => {
  it("en el entorno sano todas las comprobaciones pasan", () => {
    const report: IntegrityReport = verifyIntegrity();
    expect(report.ok).toBe(true);
    const names = report.checks.map((check) => check.name);
    expect(names).toEqual([
      "api-surface",
      "weights-frozen",
      "weights-sane",
      "thresholds-sane",
      "clock-usable",
    ]);
    for (const check of report.checks) expect(check.ok).toBe(true);
  });

  it("un reloj parcheado (o ausente) se informa como ok:false", () => {
    const globals = globalThis as {
      performance?: unknown;
      Date?: DateConstructor;
    };
    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalDateNow = globals.Date?.now;
    try {
      Object.defineProperty(globalThis, "performance", {
        value: { now: () => Number.NaN },
        configurable: true,
      });
      if (globals.Date) globals.Date.now = () => Number.NaN;
      const report = verifyIntegrity();
      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.name === "clock-usable")?.ok).toBe(false);
    } finally {
      if (performanceDescriptor)
        Object.defineProperty(globalThis, "performance", performanceDescriptor);
      if (globals.Date && originalDateNow) globals.Date.now = originalDateNow;
    }
    expect(verifyIntegrity().ok).toBe(true);
  });

  it("un reloj retrógrado no es utilizable", () => {
    const globals = globalThis as { performance?: unknown; Date?: DateConstructor };
    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalDateNow = globals.Date?.now;
    let tick = 0;
    const retrograde = (): number => {
      tick += 1;
      return tick === 1 ? 100 : 50;
    };
    try {
      Object.defineProperty(globalThis, "performance", {
        value: { now: retrograde },
        configurable: true,
      });
      if (globals.Date) globals.Date.now = () => 100;
      expect(verifyIntegrity().checks.find((c) => c.name === "clock-usable")?.ok).toBe(false);
    } finally {
      if (performanceDescriptor)
        Object.defineProperty(globalThis, "performance", performanceDescriptor);
      if (globals.Date && originalDateNow) globals.Date.now = originalDateNow;
    }
  });
});

describe("tamper: integrityFingerprint", () => {
  it("es determinista, hexadecimal de 8 caracteres y no depende del reloj", () => {
    const first = integrityFingerprint();
    const second = integrityFingerprint();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// liveness.ts
// ---------------------------------------------------------------------------

describe("liveness: LivenessMonitor", () => {
  it("idle -> live -> stale con los defaults documentados", () => {
    const monitor = new LivenessMonitor();
    expect(monitor.intervalMs).toBe(1000);
    expect(monitor.staleMs).toBe(5000);
    expect(monitor.status(0)).toBe("idle");
    monitor.beat(1000);
    expect(monitor.status(1000)).toBe("live");
    expect(monitor.status(5000)).toBe("live"); // 4000 ms < staleMs
    expect(monitor.status(6001)).toBe("stale"); // 5001 ms > staleMs
    const edge = new LivenessMonitor();
    edge.beat(1000);
    expect(edge.status(6000)).toBe("live"); // age === staleMs
    expect(edge.status(6001)).toBe("stale");
  });

  it("opciones custom y hostiles: intervalMs <= staleMs, valores finitos", () => {
    const custom = new LivenessMonitor({ intervalMs: 50, staleMs: 120 });
    expect(custom.intervalMs).toBe(50);
    expect(custom.staleMs).toBe(120);
    custom.beat(10);
    expect(custom.status(100)).toBe("live");
    expect(custom.status(131)).toBe("stale");

    const bad = new LivenessMonitor({ intervalMs: Number.NaN, staleMs: -1e12 });
    expect(Number.isFinite(bad.intervalMs)).toBe(true);
    expect(bad.staleMs).toBeGreaterThanOrEqual(bad.intervalMs);
    const huge = new LivenessMonitor({ intervalMs: 1e12, staleMs: Number.POSITIVE_INFINITY });
    expect(huge.intervalMs).toBeLessThanOrEqual(3_600_000);
    expect(huge.staleMs).toBe(huge.intervalMs);
  });

  it("latidos no finitos o retrógrados se ignoran; reloj roto -> stale", () => {
    const monitor = new LivenessMonitor({ intervalMs: 10, staleMs: 20 });
    monitor.beat(Number.NaN);
    monitor.beat(Number.POSITIVE_INFINITY);
    expect(monitor.status(100)).toBe("idle");
    monitor.beat(100);
    monitor.beat(50); // retrógrado
    expect(monitor.status(105)).toBe("live");
    expect(monitor.status(Number.NaN)).toBe("stale");
    expect(monitor.status(Number.NEGATIVE_INFINITY)).toBe("stale");
    expect(monitor.status(121)).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// surprise.ts
// ---------------------------------------------------------------------------

describe("surprise: surpriseCoherenceCheck", () => {
  const base = {
    mouseScore: null as number | null,
    keyboardScore: null as number | null,
    clickScore: null as number | null,
    scrollScore: null as number | null,
    mouseEvidence: false,
    keyboardEvidence: false,
    clickEvidence: false,
    scrollEvidence: false,
  };

  it("pasa cuando las señales con evidencia coinciden", () => {
    const check: SurpriseCheck = surpriseCoherenceCheck({
      ...base,
      mouseScore: 0.9,
      keyboardScore: 0.8,
      mouseEvidence: true,
      keyboardEvidence: true,
    });
    expect(check.passed).toBe(true);
    expect(check.reason.length).toBeGreaterThan(0);
  });

  it("falla con ratón de IA y teclado humano, ambos con evidencia", () => {
    const check = surpriseCoherenceCheck({
      ...base,
      mouseScore: 0.9,
      keyboardScore: 0.1,
      mouseEvidence: true,
      keyboardEvidence: true,
    });
    expect(check.passed).toBe(false);
    expect(check.reason).toContain("mouse-keyboard");
  });

  it("falla también en la contradicción inversa y en clic vs ratón", () => {
    expect(
      surpriseCoherenceCheck({
        ...base,
        mouseScore: 0.1,
        keyboardScore: 0.9,
        mouseEvidence: true,
        keyboardEvidence: true,
      }).passed,
    ).toBe(false);
    expect(
      surpriseCoherenceCheck({
        ...base,
        mouseScore: 0.9,
        clickScore: 0.1,
        mouseEvidence: true,
        clickEvidence: true,
      }).passed,
    ).toBe(false);
  });

  it("fail closed: sin dos señales con evidencia no acusa", () => {
    const cases = [
      { ...base, mouseScore: 0.9, mouseEvidence: true },
      {
        ...base,
        mouseScore: 0.9,
        keyboardScore: 0.1,
        mouseEvidence: true,
        keyboardEvidence: false,
      },
      {
        ...base,
        mouseScore: Number.NaN,
        keyboardScore: Number.POSITIVE_INFINITY,
        mouseEvidence: true,
        keyboardEvidence: true,
      },
      null as unknown as typeof base,
    ];
    for (const input of cases) {
      const check = surpriseCoherenceCheck(input);
      expect(check.passed).toBe(true);
      expect(check.reason.length).toBeGreaterThan(0);
    }
  });

  it("scores en la zona gris no se clasifican como humano/IA", () => {
    const check = surpriseCoherenceCheck({
      ...base,
      mouseScore: 0.4,
      keyboardScore: 0.5,
      mouseEvidence: true,
      keyboardEvidence: true,
    });
    expect(check.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// noise.ts
// ---------------------------------------------------------------------------

describe("noise: noiseHumanity / formulaRhythm", () => {
  function uniform(n = 48): number[] {
    const rng = lcg(0xabc123);
    return Array.from({ length: n }, () => 50 + rng() * 100);
  }

  function humanJitter(n = 48): number[] {
    const rng = lcg(0x5eed);
    let value = 120;
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      value = 0.75 * value + 0.25 * 120 + (rng() - 0.5) * 30;
      if (rng() < 0.1) value += 100 + rng() * 150;
      out.push(Math.max(30, value));
    }
    return out;
  }

  it("RNG uniforme: sin humanidad ni fórmula", () => {
    const values = uniform();
    expect(noiseHumanity(values)).toBeLessThan(0.25);
    expect(formulaRhythm(values)).toBeLessThan(0.4);
  });

  it("jitter humano correlacionado: humanidad alta, sin fórmula", () => {
    const values = humanJitter();
    expect(noiseHumanity(values)).toBeGreaterThan(0.5);
    expect(formulaRhythm(values)).toBeLessThan(0.5);
  });

  it("fórmula exacta (ciclo, metrónomo y rampa): formulaRhythm = 1, humanidad 0", () => {
    const cycle = Array.from({ length: 48 }, (_, i) => 100 + (i % 4) * 10);
    expect(formulaRhythm(cycle)).toBe(1);
    expect(noiseHumanity(cycle)).toBe(0);
    expect(formulaRhythm(Array.from({ length: 48 }, () => 100))).toBe(1);
    const ramp = Array.from({ length: 48 }, (_, i) => 50 + i * 5);
    expect(formulaRhythm(ramp)).toBe(1);
  });

  it("vacío y muestras cortas devuelven 0", () => {
    expect(noiseHumanity([])).toBe(0);
    expect(formulaRhythm([])).toBe(0);
    expect(noiseHumanity([100, 110, 120])).toBe(0);
    expect(formulaRhythm([100, 110, 120])).toBe(0);
  });

  it("entradas hostiles siempre finitas en [0,1]", () => {
    const hostile = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -100,
      0,
      1e308,
      -1e308,
      10,
      20,
      Number.NaN,
      30,
    ];
    expectUnit(noiseHumanity(hostile), "noiseHumanity(hostil)");
    expectUnit(formulaRhythm(hostile), "formulaRhythm(hostil)");
    expectUnit(noiseHumanity(null as unknown as number[]), "noiseHumanity(null)");
    expectUnit(formulaRhythm(undefined as unknown as number[]), "formulaRhythm(undefined)");
  });
});
