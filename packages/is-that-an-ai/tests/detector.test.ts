import { describe, expect, it } from "bun:test";
import { AI_MIN, IsThatAnAI } from "../src/index";

function pointerEvent(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    // Bun expone isTrusted como accessor propio no configurable; los eventos
    // sintéticos ya tienen isTrusted === false, que es lo que queremos probar.
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

function move(x: number, timeStamp: number): Event {
  return pointerEvent("pointermove", {
    clientX: x,
    clientY: x * 2,
    timeStamp,
    pointerType: "mouse",
    isTrusted: false,
  });
}

function dispatchAll(target: EventTarget, events: Event[]): void {
  for (const event of events) target.dispatchEvent(event);
}

/** Emite eventos y evalúa cada pocos eventos para respetar la confirmación temporal. */
function runConfirmed(detector: IsThatAnAI, target: EventTarget, events: Event[], every = 5): void {
  for (let i = 0; i < events.length; i += 1) {
    target.dispatchEvent(events[i]);
    if ((i + 1) % every === 0 || i === events.length - 1) detector.evaluate();
  }
}

const MEASURING = { state: "measuring", score: null, confidence: 0, doubt: 1, reasons: [] };

/** Secuencia "IA": camino recto, velocidad constante, intervalos constantes. */
function aiSequence(count: number, t0 = 0, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) => move(10 * i, t0 + i * dt));
}

/** Zoom bajo + mouse rápido: pasos CSS grandes (80px) y uniformes cada 20ms. */
function zoomSequence(count: number, t0 = 0, dt = 20): Event[] {
  return Array.from({ length: count }, (_, i) => move(80 * i, t0 + i * dt));
}

/** Bot obvio: línea recta con saltos imposibles cada 8 eventos. */
function teleportSequence(count: number, t0 = 0, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % 8 === 0 ? 300 : 0), t0 + i * dt),
  );
}

/** Secuencia "humano": pasos fractionarios variables, dt irregulares y retrocesos ocasionales. */
function humanSequence(count: number, t0 = 0): Event[] {
  const out: Event[] = [];
  let x = 0.5;
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    const stepDt = 35 + ((i * 29) % 65);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    const dy = ((i * 5) % 7) - 3 + 0.2;
    if (i % 5 === 2) x -= dx * 0.8;
    else x += dx;
    y += dy;
    out.push(
      pointerEvent("pointermove", {
        clientX: x,
        clientY: y,
        timeStamp: t0 + i * stepDt,
        pointerType: "mouse",
        isTrusted: false,
      }),
    );
  }
  return out;
}

function fakeWindow(): { target: EventTarget; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown };
  const previousWindow = globals.window;
  const target = new EventTarget();
  globals.window = target;
  return {
    target,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
    },
  };
}

/**
 * Igual que fakeWindow, pero el reloj inyectado sigue el timeStamp del último
 * evento despachado. Así una misma sesión puede envejecer muestras de fases
 * anteriores sin reloj de pared; la confirmación sigue usando timeStamps.
 */
function clockedWindow(): { target: EventTarget; clock: () => number; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown };
  const previousWindow = globals.window;
  const target = new EventTarget();
  let t = 0;
  const original = target.dispatchEvent.bind(target);
  target.dispatchEvent = ((event: Event) => {
    if (Number.isFinite(event.timeStamp)) t = event.timeStamp;
    return original(event);
  }) as typeof target.dispatchEvent;
  globals.window = target;
  return {
    target,
    clock: () => t,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
    },
  };
}

function lastT(events: Event[]): number {
  return (events[events.length - 1] as unknown as { timeStamp: number }).timeStamp;
}

/** Humano convincente (score < HUMAN_CORE): dt muy irregular con pausas breves. */
function convincingHumanRun(count: number, startT = 0): Event[] {
  const out: Event[] = [];
  let x = 0.5;
  let y = 0;
  let t = startT;
  for (let i = 0; i < count; i += 1) {
    const stepDt = 35 + ((i * 37) % 130) + (i % 7 === 3 ? 200 : 0);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    const dy = ((i * 5) % 7) - 3 + 0.2;
    if (i % 5 === 2) x -= dx * 0.8;
    else x += dx;
    y += dy;
    t += stepDt;
    out.push(
      pointerEvent("pointermove", {
        clientX: x,
        clientY: y,
        timeStamp: t,
        pointerType: "mouse",
        isTrusted: false,
      }),
    );
  }
  return out;
}

/** Borde recto recorrido despacio: score en la banda media (duda humano alta). */
function edgeRun(count: number, startT = 0, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    pointerEvent("pointermove", {
      clientX: 5,
      clientY: 850 - i * 20,
      timeStamp: startT + i * dt,
      pointerType: "mouse",
      isTrusted: false,
    }),
  );
}

/** Saltos poco frecuentes: score justo bajo AI_MIN (duda de IA alta). */
function rareTeleportRun(count: number, startT = 0, every = 20, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % every === 0 ? 300 : 0), startT + i * dt),
  );
}

/** Saltos imposibles cada 8 eventos: IA obvia (duda 0). */
function teleportRun(count: number, startT = 0, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % 8 === 0 ? 300 : 0), startT + i * dt),
  );
}

describe("IsThatAnAI (Etapa 3)", () => {
  it("getVerdict devuelve el objeto fijo de medición", () => {
    const detector = new IsThatAnAI();
    expect(detector.getVerdict()).toEqual(MEASURING);
  });

  it("no registra nada antes de start y getStats está vacío", () => {
    const detector = new IsThatAnAI();
    expect(detector.getRecentPoints()).toEqual([]);
    expect(detector.getStats()).toEqual({
      sampleCount: 0,
      droppedCount: 0,
      eventsPerSecond: 0,
      bufferFill: 0,
      trustedRatio: 0,
      lastEventAt: 0,
      clickCount: 0,
      scrollCount: 0,
    });
  });

  it("start dos veces no duplica listeners; stop deja de grabar y limpia", () => {
    const { target, restore } = fakeWindow();
    try {
      let added = 0;
      const add = target.addEventListener.bind(target);
      target.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
        added += 1;
        return add(...args);
      }) as typeof target.addEventListener;
      const detector = new IsThatAnAI({ mouse: { bufferSize: 4, maxAgeMs: 15000 } });
      detector.start();
      detector.start();
      // 3 de mouse + 2 de click (down/up) + 2 de scroll (wheel + scroll).
      expect(added).toBe(7);

      target.dispatchEvent(move(1, 10));
      target.dispatchEvent(move(2, 20));

      const points = detector.getRecentPoints();
      expect(points.map((sample) => sample.seq)).toEqual([1, 2]);
      expect(detector.getRecentPoints(1).map((sample) => sample.seq)).toEqual([2]);

      const stats = detector.getStats();
      expect(stats.sampleCount).toBe(2);
      expect(stats.eventsPerSecond).toBe(2);
      expect(stats.bufferFill).toBe(0.5);
      expect(stats.trustedRatio).toBe(0);
      expect(stats.lastEventAt).toBe(20);

      detector.stop();
      expect(detector.getRecentPoints()).toEqual([]);
      target.dispatchEvent(move(3, 30));
      expect(detector.getRecentPoints()).toEqual([]);
      expect(detector.getStats().lastEventAt).toBe(0);
      expect(() => detector.stop()).not.toThrow();
    } finally {
      restore();
    }
  });

  it("onVerdict registra un unsubscribe y no emite todavía", () => {
    const detector = new IsThatAnAI();
    let calls = 0;
    const unsubscribe = detector.onVerdict(() => {
      calls += 1;
    });
    detector.start();
    detector.stop();
    expect(calls).toBe(0);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});

describe("IsThatAnAI (Etapa 4)", () => {
  it("evidencia insuficiente -> measuring con score null y doubt 1", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      dispatchAll(target, aiSequence(5, 0, 20));
      detector.evaluate();
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("measuring");
      expect(verdict.score).toBeNull();
      expect(verdict.doubt).toBe(1);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("secuencia IA obvia -> veredicto ai con score y razones", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      runConfirmed(detector, target, teleportSequence(30, 0, 60));
      detector.evaluate();
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("ai");
      expect(verdict.score).not.toBeNull();
      expect(verdict.score).toBeGreaterThanOrEqual(AI_MIN);
      expect(verdict.confidence).toBeGreaterThan(0);
      expect(verdict.reasons.length).toBeGreaterThan(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("contradicción humano -> IA -> humano", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      const verdicts: string[] = [];
      detector.onVerdict((verdict) => verdicts.push(verdict.state));

      // Fase 1: interacción humana.
      detector.start();
      runConfirmed(detector, target, humanSequence(30, 0));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("human");

      // Fase 2: nuevo turno con movimiento de IA obvio.
      detector.stop();
      detector.start();
      runConfirmed(detector, target, teleportSequence(30, 0, 60));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");

      // Fase 3: nuevo turno con movimiento humano.
      detector.stop();
      detector.start();
      runConfirmed(detector, target, humanSequence(30, 0));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("human");

      expect(verdicts).toEqual(["human", "ai", "human"]);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("onVerdict solo dispara en cambio de estado y unsubscribe detiene las emisiones", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      const verdicts: string[] = [];
      const unsubscribe = detector.onVerdict((verdict) => verdicts.push(verdict.state));

      detector.start();
      runConfirmed(detector, target, humanSequence(30, 0));
      detector.evaluate();
      expect(verdicts).toEqual(["human"]);

      // mismo estado: sin nueva emisión
      detector.evaluate();
      expect(verdicts).toEqual(["human"]);

      unsubscribe();
      runConfirmed(detector, target, aiSequence(30, 1800, 20));
      detector.evaluate();
      expect(verdicts).toEqual(["human"]);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("getMouseFeatures expone las 10 medidas tras la evaluación y se limpia al parar", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      expect(detector.getMouseFeatures()).toBeNull();
      runConfirmed(detector, target, aiSequence(30, 0, 60));
      detector.evaluate();
      const features = detector.getMouseFeatures();
      expect(features).not.toBeNull();
      expect(Object.keys(features as object).length).toBe(10);
      for (const value of Object.values(features as Record<string, number>)) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      detector.stop();
      expect(detector.getMouseFeatures()).toBeNull();
    } finally {
      restore();
    }
  });

  it("subir por el borde en línea recta sigue siendo human con doubt alto", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      const edge = Array.from({ length: 30 }, (_, i) =>
        pointerEvent("pointermove", {
          clientX: 5,
          clientY: 850 - i * 20,
          timeStamp: i * 60,
          pointerType: "mouse",
          isTrusted: false,
        }),
      );
      runConfirmed(detector, target, edge);
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("human");
      expect(verdict.score as number).toBeLessThan(AI_MIN);
      expect(verdict.doubt).toBeGreaterThan(0.3);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("zoom bajo con mouse rápido nunca da ai (teleport escala-invariante)", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      runConfirmed(detector, target, zoomSequence(60, 0, 20));
      const verdict = detector.getVerdict();
      // Antes: cada paso d=80>40 y v>4 -> teleport=1 -> score~0.92 -> ai.
      // Ahora: pasos uniformes -> teleport=0 -> score en banda / humano.
      expect(verdict.state).not.toBe("ai");
      expect(verdict.score as number).toBeLessThan(AI_MIN);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("estado humano conserva score/confianza/razones reales", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      runConfirmed(detector, target, humanSequence(30, 0));
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("human");
      expect(verdict.score).not.toBeNull();
      expect(verdict.confidence).toBeGreaterThan(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("stop sin start no falla y reinicia scoring/veredicto a measuring", () => {
    const detector = new IsThatAnAI();
    expect(() => detector.stop()).not.toThrow();
    expect(detector.getVerdict()).toEqual(MEASURING);

    // start dos veces: un solo timer, stop() limpia.
    const { target, restore } = fakeWindow();
    try {
      detector.start();
      detector.start();
      runConfirmed(detector, target, teleportSequence(30, 0, 60));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      detector.stop();
      expect(detector.getVerdict()).toEqual(MEASURING);
    } finally {
      restore();
    }
  });
});

describe("IsThatAnAI (doubt: sospecha reversible)", () => {
  /** Devuelve el doubt tras cada fase (hueco de 3000 ms, maxAgeMs=2500). */
  function runPhases(detector: IsThatAnAI, target: EventTarget, phases: Event[][]): number[] {
    const doubts: number[] = [];
    for (const phase of phases) {
      runConfirmed(detector, target, phase, 10);
      doubts.push(detector.getVerdict().doubt);
    }
    return doubts;
  }

  it("humano convincente -> doubt 0", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      runConfirmed(detector, target, convincingHumanRun(30, 0));
      // El EMA se asienta sobre el buffer completo (mismo score, sin nuevos eventos).
      detector.evaluate();
      detector.evaluate();
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("human");
      expect(verdict.score as number).toBeLessThanOrEqual(0.15);
      expect(verdict.doubt).toBe(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("AI obvia (teletransporte) -> doubt 0", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      runConfirmed(detector, target, teleportSequence(30, 0, 60));
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("ai");
      expect(verdict.score as number).toBeGreaterThanOrEqual(0.85);
      expect(verdict.doubt).toBe(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("human -> doubt alto -> doubt bajo SIN cambiar de estado", () => {
    const { target, clock, restore } = clockedWindow();
    try {
      const emitted: string[] = [];
      const detector = new IsThatAnAI({ now: clock, mouse: { maxAgeMs: 2500 } });
      detector.onVerdict((verdict) => emitted.push(verdict.state));
      detector.start();

      let start = 0;
      const convincing = convincingHumanRun(60, start);
      start = lastT(convincing) + 3000;
      const doubtfulHuman = edgeRun(60, start);
      start = lastT(doubtfulHuman) + 3000;
      const convincingAgain = convincingHumanRun(60, start);
      const doubts = runPhases(detector, target, [convincing, doubtfulHuman, convincingAgain]);

      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("human");
      // Sospecha reversible: 0 -> alto -> 0, sin cambiar de estado ni emitir.
      expect(doubts[0]).toBeLessThanOrEqual(0.01);
      expect(doubts[1]).toBeGreaterThan(0.3);
      expect(doubts[2]).toBeLessThanOrEqual(0.01);
      expect(emitted).toEqual(["human"]);
      detector.stop();
      expect(detector.getVerdict().doubt).toBe(1);
    } finally {
      restore();
    }
  });

  it("ai -> doubt alto -> doubt bajo SIN cambiar de estado", () => {
    const { target, clock, restore } = clockedWindow();
    try {
      const emitted: string[] = [];
      const detector = new IsThatAnAI({ now: clock, mouse: { maxAgeMs: 2500 } });
      detector.onVerdict((verdict) => emitted.push(verdict.state));
      detector.start();

      let start = 0;
      const obviousAi = teleportRun(60, start);
      start = lastT(obviousAi) + 3000;
      const doubtfulAi = rareTeleportRun(60, start);
      start = lastT(doubtfulAi) + 3000;
      const obviousAgain = teleportRun(60, start);
      const doubts = runPhases(detector, target, [obviousAi, doubtfulAi, obviousAgain]);

      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("ai");
      // Sospecha reversible dentro de ai: 0 -> alto -> bajo, sin emitir.
      expect(doubts[0]).toBeLessThanOrEqual(0.01);
      expect(doubts[1]).toBeGreaterThan(0.7);
      expect(doubts[2]).toBeLessThan(0.1);
      expect(emitted).toEqual(["ai"]);
      detector.stop();
      expect(detector.getVerdict().doubt).toBe(1);
    } finally {
      restore();
    }
  });

  it("onVerdict no emite cuando cambia solo la duda", () => {
    const { target, clock, restore } = clockedWindow();
    try {
      const seen: Array<{ state: string; doubt: number }> = [];
      const detector = new IsThatAnAI({ now: clock, mouse: { maxAgeMs: 2500 } });
      detector.onVerdict((verdict) => seen.push({ state: verdict.state, doubt: verdict.doubt }));
      detector.start();

      let start = 0;
      const convincing = convincingHumanRun(60, start);
      start = lastT(convincing) + 3000;
      const edge = edgeRun(60, start);
      runPhases(detector, target, [convincing, edge]);

      // getVerdict sí refleja la duda recalculada, aunque no haya cambio de estado.
      expect(detector.getVerdict().state).toBe("human");
      expect(detector.getVerdict().doubt).toBeGreaterThan(0.3);
      expect(seen).toEqual([{ state: "human", doubt: 0 }]);
      detector.stop();
    } finally {
      restore();
    }
  });
});
