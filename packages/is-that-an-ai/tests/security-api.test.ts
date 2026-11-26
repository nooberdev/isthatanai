// Red-team determinista de la superficie pública y de configuración.
// Todas las entradas son hostiles y 100% locales: sin red, sin DOM real, sin reloj de pared.

import { describe, expect, it } from "bun:test";
import { IsThatAnAI, ScoreComputer } from "../src/index";
import {
  AI_CONFIRM_MS,
  AI_MIN,
  DEFAULT_SCORING_CONFIG,
  doubtFor,
  EMA_ALPHA,
  HUMAN_CONFIRM_MS,
  HUMAN_MAX,
  SCORED_SIGNALS,
  SIGNAL_DIFFICULTY,
  SIGNAL_WEIGHTS,
} from "../src/scoring/score";
import type { DetectorOptions, PointerSample, Verdict } from "../src/types";

const MEASURING: Verdict = {
  state: "measuring",
  score: null,
  confidence: 0,
  doubt: 1,
  reasons: [],
};

const DEFAULTS = {
  thresholds: { humanMax: HUMAN_MAX, aiMin: AI_MIN },
  signalWeights: { ...SIGNAL_WEIGHTS },
  device: "auto" as const,
  combination: "weighted" as const,
  accessibilityProtection: false,
  confirmMs: { human: HUMAN_CONFIRM_MS, ai: AI_CONFIRM_MS },
  emaAlpha: EMA_ALPHA,
};

function event(type: string, props: Record<string, unknown>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(result, key, { value, configurable: true });
  }
  return result;
}

function move(x: number, t: number): Event {
  return event("pointermove", {
    clientX: x,
    clientY: x * 2,
    timeStamp: t,
    pointerType: "mouse",
    isTrusted: false,
  });
}

function teleportSequence(count: number, t0 = 0, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % 8 === 0 ? 300 : 0), t0 + i * dt),
  );
}

function runConfirmed(detector: IsThatAnAI, target: EventTarget, events: Event[], every = 5): void {
  for (let i = 0; i < events.length; i += 1) {
    target.dispatchEvent(events[i] as Event);
    if ((i + 1) % every === 0 || i === events.length - 1) detector.evaluate();
  }
}

/** Sesión aislada con reloj fijo; stop() SIEMPRE limpia el intervalo. */
function session<T>(options: DetectorOptions, body: (d: IsThatAnAI, target: EventTarget) => T): T {
  const detector = new IsThatAnAI(options);
  const target = new EventTarget();
  detector.attachTo(target);
  detector.start();
  try {
    return body(detector, target);
  } finally {
    detector.stop();
  }
}

function fixedSession<T>(body: (d: IsThatAnAI, target: EventTarget) => T): T {
  return session({ now: () => 0 }, body);
}

// ---------------------------------------------------------------------------
// configure(): entradas hostiles
// ---------------------------------------------------------------------------

describe("configure: fail closed ante entradas hostiles", () => {
  it("null, arrays, strings, funciones y números no lanzan y no cambian nada", () => {
    const detector = new IsThatAnAI();
    for (const bad of [null, undefined, [], ["x"], "texto", () => 1, 42, 0, true]) {
      expect(() =>
        (detector as unknown as { configure: (v: unknown) => void }).configure(bad),
      ).not.toThrow();
      expect(detector.getConfig()).toEqual(DEFAULTS);
    }
  });

  it("propiedades heredadas y las claves __proto__/constructor se ignoran", () => {
    const detector = new IsThatAnAI();
    const poisoned = Object.create({
      device: "tv",
      thresholds: { humanMax: 1, aiMin: 0 },
      signalWeights: { mouse: 1, click: 1, scroll: 1, keyboard: 1 },
      confirmMs: { human: 0, ai: 0 },
      emaAlpha: 1,
      combination: "adaptive",
    });
    (detector as unknown as { configure: (v: unknown) => void }).configure(poisoned);
    expect(detector.getConfig()).toEqual(DEFAULTS);

    const ownProto = {};
    Object.defineProperty(ownProto, "__proto__", {
      value: { device: "tv", thresholds: { humanMax: 1, aiMin: 0 } },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(ownProto, "constructor", {
      value: { signalWeights: { mouse: 1 } },
      enumerable: true,
    });
    (detector as unknown as { configure: (v: unknown) => void }).configure(ownProto);
    expect(detector.getConfig()).toEqual(DEFAULTS);
    expect(({} as Record<string, unknown>).device).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    detector.configure({ thresholds: Object.create({ humanMax: 1, aiMin: 0 }) });
    expect(detector.getConfig().thresholds).toEqual(DEFAULTS.thresholds);
  });

  it("getters hostiles: se leen una vez y sus excepciones quedan aisladas", () => {
    const detector = new IsThatAnAI();
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "thresholds", {
      enumerable: true,
      get() {
        reads += 1;
        return { humanMax: Number.NaN, aiMin: Number.POSITIVE_INFINITY };
      },
    });
    expect(() =>
      (detector as unknown as { configure: (v: unknown) => void }).configure(hostile),
    ).not.toThrow();
    expect(reads).toBe(1);
    expect(detector.getConfig().thresholds).toEqual(DEFAULTS.thresholds);

    const explosive = {};
    Object.defineProperty(explosive, "thresholds", {
      enumerable: true,
      get() {
        throw new Error("getter hostil");
      },
    });
    expect(() =>
      (detector as unknown as { configure: (v: unknown) => void }).configure(explosive),
    ).not.toThrow();
    expect(detector.getConfig()).toEqual(DEFAULTS);
  });

  it("objetos congelados y proxies que lanzan no rompen configure()", () => {
    const detector = new IsThatAnAI();
    const frozen = Object.freeze({
      device: "tv",
      thresholds: Object.freeze({ humanMax: 0.2, aiMin: 0.9 }),
      signalWeights: Object.freeze({ mouse: 0.7 }),
    });
    expect(() => detector.configure(frozen)).not.toThrow();
    expect(detector.getConfig()).toEqual({
      ...DEFAULTS,
      device: "tv",
      thresholds: { humanMax: 0.2, aiMin: 0.9 },
      signalWeights: { ...SIGNAL_WEIGHTS, mouse: 0.7 },
    });

    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("proxy hostil");
        },
        get() {
          throw new Error("proxy hostil");
        },
      },
    );
    const before = detector.getConfig();
    expect(() =>
      (detector as unknown as { configure: (v: unknown) => void }).configure(proxy),
    ).not.toThrow();
    expect(detector.getConfig()).toEqual(before);
  });

  it("NaN/Infinity/negativos/fuera de rango vuelven a los defaults", () => {
    const detector = new IsThatAnAI();
    detector.configure({
      thresholds: { humanMax: Number.NaN, aiMin: Number.NEGATIVE_INFINITY },
      signalWeights: {
        mouse: Number.POSITIVE_INFINITY,
        click: -1,
        scroll: 2,
        keyboard: Number.NaN,
      },
      confirmMs: { human: -5, ai: Number.POSITIVE_INFINITY },
      emaAlpha: Number.NaN,
      device: "desconocido" as "auto",
      combination: "inventada" as "weighted",
    });
    expect(detector.getConfig()).toEqual(DEFAULTS);
  });

  it("bandas solapadas y perfil inventado se descartan (nunca todo humano)", () => {
    const detector = new IsThatAnAI();
    detector.configure({
      thresholds: { humanMax: 1, aiMin: 0 },
      device: "evil" as "auto",
      confirmMs: { human: 0, ai: 0 },
    });
    expect(detector.getConfig()).toEqual(DEFAULTS);

    fixedSession((d, target) => {
      d.configure({ thresholds: { humanMax: 1, aiMin: 0 }, confirmMs: { human: 0 } });
      runConfirmed(d, target, teleportSequence(30));
      expect(d.getVerdict().state).toBe("ai");
    });
  });

  it("pesos todos a cero no inventan un 0.5 que confirme humano", () => {
    fixedSession((d, target) => {
      d.configure({
        signalWeights: { mouse: 0, click: 0, scroll: 0, keyboard: 0 },
      });
      runConfirmed(d, target, teleportSequence(30));
      expect(d.getVerdict().score).toBeNull();
      expect(d.getVerdict().state).toBe("measuring");
    });
  });

  it("config hostil nunca convierte ausencia de evidencia en humano", () => {
    fixedSession((d, target) => {
      d.configure({
        thresholds: { humanMax: 1, aiMin: 0 },
        confirmMs: { human: 0, ai: 0 },
        signalWeights: { mouse: 0, click: 0, scroll: 0, keyboard: 0 },
      });
      for (let i = 0; i < 5; i += 1) target.dispatchEvent(move(i * 10, i * 60));
      d.evaluate();
      expect(d.getVerdict()).toEqual(MEASURING);
    });
  });

  it("configure() copia: mutar el objeto del llamador después no cambia nada", () => {
    const detector = new IsThatAnAI();
    const config = {
      signalWeights: { mouse: 0.9 },
      thresholds: { aiMin: 0.8 },
      confirmMs: { ai: 123 },
    };
    detector.configure(config);
    const snapshot = detector.getConfig();
    config.signalWeights.mouse = 0;
    config.thresholds.aiMin = 0;
    config.confirmMs.ai = 0;
    expect(detector.getConfig()).toEqual(snapshot);
    expect(snapshot.signalWeights.mouse).toBe(0.9);
    expect(snapshot.thresholds.aiMin).toBe(0.8);
    expect(snapshot.confirmMs.ai).toBe(123);
    // El propio getConfig() también es una copia.
    snapshot.thresholds.aiMin = 0;
    expect(detector.getConfig().thresholds.aiMin).toBe(0.8);
  });

  it("las opciones del constructor tampoco se conservan por referencia", () => {
    const options: DetectorOptions = {
      now: () => 0,
      mouse: { bufferSize: 4, maxAgeMs: 100 },
    };
    const detector = new IsThatAnAI(options);
    const target = new EventTarget();
    detector.attachTo(target);
    detector.start();
    try {
      const mutable = options.mouse as { bufferSize: number; maxAgeMs: number };
      mutable.bufferSize = 1e12;
      mutable.maxAgeMs = -1;
      target.dispatchEvent(move(1, 10));
      expect(() => detector.evaluate()).not.toThrow();
      expect(Number.isFinite(detector.getStats().bufferFill)).toBe(true);
    } finally {
      detector.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Constantes exportadas congeladas en runtime
// ---------------------------------------------------------------------------

describe("constantes exportadas inmutables en runtime", () => {
  it("SIGNAL_WEIGHTS, DEFAULT_SCORING_CONFIG, SIGNAL_DIFFICULTY y SCORED_SIGNALS están congelados", () => {
    expect(Object.isFrozen(SIGNAL_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCORING_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCORING_CONFIG.signalWeights)).toBe(true);
    expect(Object.isFrozen(SIGNAL_DIFFICULTY)).toBe(true);
    expect(Object.isFrozen(SCORED_SIGNALS)).toBe(true);

    expect(SIGNAL_WEIGHTS).toEqual({ mouse: 0.6, click: 0.2, scroll: 0.2, keyboard: 0.15 });
    expect(DEFAULT_SCORING_CONFIG.signalWeights).toEqual({ ...SIGNAL_WEIGHTS });
    expect(DEFAULT_SCORING_CONFIG.emaAlpha).toBe(EMA_ALPHA);
    expect(SCORED_SIGNALS).toEqual(["mouse", "click", "scroll", "keyboard"]);

    expect(() => {
      (SIGNAL_WEIGHTS as unknown as Record<string, number>).mouse = 9;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_SCORING_CONFIG as unknown as Record<string, number>).emaAlpha = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_SCORING_CONFIG.signalWeights as unknown as Record<string, number>).mouse = 9;
    }).toThrow(TypeError);
    expect(() => {
      (SIGNAL_DIFFICULTY as unknown as Record<string, number>).mouse = 99;
    }).toThrow(TypeError);
    expect(() => {
      (SCORED_SIGNALS as unknown as string[]).push("falso");
    }).toThrow(TypeError);

    expect(SIGNAL_WEIGHTS.mouse).toBe(0.6);
    expect(new ScoreComputer().getConfig()).toEqual(DEFAULT_SCORING_CONFIG);
  });

  it("ScoreComputer.configure() también ignora entradas hostiles", () => {
    const computer = new ScoreComputer();
    const before = computer.getConfig();
    for (const bad of [null, [], "x", 5]) {
      expect(() =>
        (computer as unknown as { configure: (v: unknown) => void }).configure(bad),
      ).not.toThrow();
      expect(computer.getConfig()).toEqual(before);
    }
    (computer as unknown as { configure: (v: unknown) => void }).configure(
      Object.create({ signalWeights: { mouse: 1 } }),
    );
    expect(computer.getConfig()).toEqual(before);

    computer.configure({
      signalWeights: { mouse: Number.NaN, click: -1, scroll: 7 },
      emaAlpha: Number.POSITIVE_INFINITY,
      combination: "rara" as "weighted",
    });
    expect(computer.getConfig()).toEqual(before);
    expect(() => computer.evaluate(null as unknown as [], Number.NaN)).not.toThrow();
    expect(computer.evaluate(null as unknown as [], Number.NaN).score).toBeNull();
  });

  it("muestras con coordenadas no finitas no filtran NaN al score", () => {
    const computer = new ScoreComputer();
    const samples: PointerSample[] = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      x: Number.NaN,
      y: i % 2 === 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      t: i * 60,
      kind: 0,
      pointerType: 0,
      trusted: 1,
    }));
    const evidence = computer.evaluate(samples, 29 * 60);
    expect(evidence.score === null || Number.isFinite(evidence.score)).toBe(true);
    expect(Number.isFinite(evidence.confidence)).toBe(true);
    for (const value of Object.values(computer.getSignalScores())) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it("doubtFor sanea límites y scores hostiles", () => {
    expect(doubtFor("measuring", Number.NaN)).toBe(1);
    expect(doubtFor("human", Number.NaN)).toBe(1);
    expect(doubtFor("ai", Number.POSITIVE_INFINITY)).toBe(1);
    const doubt = doubtFor("human", 0.3, {
      humanMax: Number.NaN,
      aiMin: Number.POSITIVE_INFINITY,
    });
    expect(Number.isFinite(doubt)).toBe(true);
    expect(doubt).toBeCloseTo((0.3 - 0.15) / (AI_MIN - 0.15), 6);
  });
});

// ---------------------------------------------------------------------------
// attachTo / ciclo de vida / callbacks
// ---------------------------------------------------------------------------

describe("ciclo de vida y callbacks hostiles", () => {
  it("attachTo rechaza null, objetos planos, add-only y getters que lanzan", () => {
    const detector = new IsThatAnAI();
    const addOnly = { addEventListener() {}, dispatchEvent: () => true };
    const hostile = {};
    Object.defineProperty(hostile, "addEventListener", {
      get() {
        throw new Error("getter hostil");
      },
    });
    for (const bad of [null, {}, { addEventListener() {} }, addOnly, hostile]) {
      expect(() =>
        (detector as unknown as { attachTo: (v: unknown) => void }).attachTo(bad),
      ).toThrow(TypeError);
    }
  });

  it("un window falso sin removeEventListener no rompe start()/stop()", () => {
    const globals = globalThis as unknown as { window?: unknown };
    const previous = globals.window;
    globals.window = { addEventListener() {}, dispatchEvent: () => true };
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      expect(() => {
        detector.start();
        detector.stop();
      }).not.toThrow();
    } finally {
      if (previous === undefined) delete globals.window;
      else globals.window = previous;
    }
  });

  it("evaluate() antes de start(), doble start() y doble stop() son seguros", () => {
    const detector = new IsThatAnAI({ now: () => 0 });
    expect(() => detector.evaluate()).not.toThrow();
    expect(detector.getVerdict()).toEqual(MEASURING);
    expect(() => detector.stop()).not.toThrow();
    detector.attachTo(new EventTarget());
    detector.start();
    detector.start();
    detector.stop();
    detector.stop();
    expect(detector.getVerdict()).toEqual(MEASURING);
  });

  it("ciclos repetidos y re-attach no filtran listeners", () => {
    const target = new EventTarget();
    let added = 0;
    let removed = 0;
    const originalAdd = target.addEventListener.bind(target);
    const originalRemove = target.removeEventListener.bind(target);
    target.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
      added += 1;
      return originalAdd(...args);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((...args: Parameters<EventTarget["removeEventListener"]>) => {
      removed += 1;
      return originalRemove(...args);
    }) as typeof target.removeEventListener;

    const detector = new IsThatAnAI({ now: () => 0 });
    detector.attachTo(target);
    try {
      for (let i = 0; i < 25; i += 1) {
        detector.start();
        detector.start();
        detector.stop();
        detector.stop();
      }
      expect(added).toBeGreaterThan(0);
      expect(added).toBe(removed);

      const other = new EventTarget();
      detector.start();
      detector.attachTo(other);
      detector.attachTo(other);
      detector.stop();
      expect(added).toBe(removed);
    } finally {
      detector.stop();
    }
  });

  it("reset() desde onVerdict aborta el onChange obsoleto", () => {
    const changes: string[] = [];
    fixedSession((d, target) => {
      d.onChange((state) => changes.push(state));
      d.onVerdict(() => d.reset());
      runConfirmed(d, target, teleportSequence(30));
      expect(changes).toEqual([]);
      // reset() limpió la histeresis: no se confirma ningún estado aunque
      // sigan entrando muestras nuevas.
      expect(d.getVerdict().state).toBe("measuring");
    });
  });

  it("reset() desde onChange impide que los siguientes callbacks vean un estado muerto", () => {
    const seen: string[] = [];
    fixedSession((d, target) => {
      d.onChange(() => {
        seen.push("primero");
        d.reset();
      });
      d.onChange((state) => seen.push(`segundo:${state}`));
      runConfirmed(d, target, teleportSequence(30));
      expect(seen).toEqual(["primero"]);
      expect(d.getVerdict().state).toBe("measuring");
    });
  });

  it("callbacks que lanzan se aíslan y no rompen la máquina de estados", () => {
    const seen: string[] = [];
    fixedSession((d, target) => {
      d.onVerdict((verdict) => {
        seen.push(`boom:${verdict.state}`);
        throw new Error("callback hostil");
      });
      d.onVerdict((verdict) => seen.push(`ok:${verdict.state}`));
      d.onChange(() => {
        throw new Error("callback hostil");
      });
      d.onChange((state) => seen.push(`change:${state}`));
      expect(() => runConfirmed(d, target, teleportSequence(30))).not.toThrow();
      expect(seen).toContain("ok:ai");
      expect(seen).toContain("change:ai");
      expect(d.getVerdict().state).toBe("ai");
    });
  });

  it("re-entrar evaluate() desde un callback se descarta (sin recursión)", () => {
    let emitted = 0;
    fixedSession((d, target) => {
      d.onVerdict(() => {
        emitted += 1;
        d.evaluate();
      });
      runConfirmed(d, target, teleportSequence(30));
      expect(emitted).toBe(1);
    });
  });

  it("darse de baja durante el dispatch impide llamar a los posteriores", () => {
    const seen: string[] = [];
    fixedSession((d, target) => {
      let unsubscribe = () => {};
      d.onVerdict((verdict) => {
        seen.push(`a:${verdict.state}`);
        unsubscribe();
      });
      unsubscribe = d.onVerdict((verdict) => seen.push(`b:${verdict.state}`));
      runConfirmed(d, target, teleportSequence(30));
      expect(seen).toEqual(["a:ai"]);
    });
  });

  it("mutar el Verdict recibido no altera el estado interno", () => {
    fixedSession((d, target) => {
      d.onVerdict((verdict) => {
        (verdict as unknown as Record<string, unknown>).state = "human";
        (verdict as unknown as Record<string, unknown>).score = 0;
        verdict.reasons.push("mutado");
      });
      runConfirmed(d, target, teleportSequence(30));
      const verdict = d.getVerdict();
      expect(verdict.state).toBe("ai");
      expect(verdict.score).toBeGreaterThanOrEqual(AI_MIN);
      expect(verdict.reasons).not.toContain("mutado");
    });
  });
});

// ---------------------------------------------------------------------------
// Relojes y marcas de tiempo
// ---------------------------------------------------------------------------

describe("relojes hostiles y marcas de tiempo", () => {
  const hostileClocks: Array<[string, () => number]> = [
    ["NaN", () => Number.NaN],
    ["Infinity", () => Number.POSITIVE_INFINITY],
    ["-Infinity", () => Number.NEGATIVE_INFINITY],
    ["negativo", () => -1e12],
    ["enorme", () => 1e300],
    [
      "que lanza",
      () => {
        throw new Error("reloj hostil");
      },
    ],
  ];

  for (const [label, clock] of hostileClocks) {
    it(`now() = ${label}: sin NaN/Infinity en veredicto ni estadísticas`, () => {
      session({ now: clock }, (d, target) => {
        runConfirmed(d, target, teleportSequence(30));
        const verdict = d.getVerdict();
        expect(verdict.score === null || Number.isFinite(verdict.score)).toBe(true);
        expect(Number.isFinite(verdict.confidence)).toBe(true);
        expect(Number.isFinite(verdict.doubt)).toBe(true);
        for (const value of Object.values(d.getStats())) {
          expect(Number.isFinite(value)).toBe(true);
        }
      });
    });
  }

  it("marcas retrógradas y repetidas no adelantan la histeresis", () => {
    fixedSession((d, target) => {
      for (const sample of teleportSequence(30)) target.dispatchEvent(sample);
      d.evaluate(); // candidato a ai desde t=1740
      expect(d.getVerdict().state).toBe("measuring");

      target.dispatchEvent(move(10 * 30 + 300, 1700)); // hacia atrás
      d.evaluate();
      expect(d.getVerdict().state).toBe("measuring");

      target.dispatchEvent(move(10 * 31 + 300, 2350)); // 2350 - 1740 = 610 >= 600
      d.evaluate();
      expect(d.getVerdict().state).toBe("ai");
    });
  });

  it("bufferSize hostil no provoca asignaciones gigantes ni scores corruptos", () => {
    const options = {
      now: () => 0,
      mouse: { bufferSize: 1e12 },
      click: { bufferSize: -1 },
      scroll: { bufferSize: Number.NaN },
      keyboard: { bufferSize: Number.POSITIVE_INFINITY },
      input: { bufferSize: 1.5 },
    };
    session(options, (d, target) => {
      runConfirmed(d, target, teleportSequence(40));
      const stats = d.getStats();
      expect(stats.bufferFill).toBeGreaterThanOrEqual(0);
      expect(stats.bufferFill).toBeLessThanOrEqual(1);
      expect(Number.isFinite(d.getVerdict().confidence)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Formas públicas y scores fijados (regresión)
// ---------------------------------------------------------------------------

describe("superficie pública estable", () => {
  it("formas enumerables y score con 6 decimales no cambian", () => {
    const detector = new IsThatAnAI({ now: () => 0 });
    expect(Object.keys(detector.getConfig())).toEqual([
      "thresholds",
      "signalWeights",
      "device",
      "combination",
      "accessibilityProtection",
      "confirmMs",
      "emaAlpha",
    ]);
    expect(Object.keys(detector.getVerdict())).toEqual([
      "state",
      "score",
      "confidence",
      "doubt",
      "reasons",
    ]);
    expect(Object.keys(detector.getSignalScores())).toEqual(["mouse", "click", "scroll"]);
    expect(Object.keys(detector.getStats())).toEqual([
      "sampleCount",
      "droppedCount",
      "eventsPerSecond",
      "bufferFill",
      "trustedRatio",
      "lastEventAt",
      "clickCount",
      "scrollCount",
    ]);
    expect(detector.getConfig()).toEqual(DEFAULTS);

    fixedSession((d, target) => {
      const samples: PointerSample[] = Array.from({ length: 30 }, (_, i) => ({
        seq: i + 1,
        x: i * 10,
        y: 0,
        t: i * 60,
        kind: 0,
        pointerType: 0,
        trusted: 1,
      }));
      for (const sample of samples) target.dispatchEvent(move(sample.x, sample.t));
      d.evaluate();
      const expected = new ScoreComputer().evaluate(samples, 29 * 60).score;
      expect(d.getVerdict().score).toBe(expected);
    });
  });
});
