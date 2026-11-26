import { describe, expect, it } from "bun:test";
import type { ClickSample, PointerSample, ScrollSample } from "../src/index";
import { IsThatAnAI, ScoreComputer } from "../src/index";

function event(type: string, props: Record<string, unknown>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(result, key, { value, configurable: true });
  }
  return result;
}

function straightLine(n: number): PointerSample[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    x: i * 10,
    y: 0,
    t: i * 60,
    kind: 0 as const,
    pointerType: 0 as const,
    trusted: 1 as const,
  }));
}

function pointerEvents(n: number): Event[] {
  return straightLine(n).map((sample) =>
    event("pointermove", {
      clientX: sample.x,
      clientY: sample.y,
      timeStamp: sample.t,
      pointerType: "mouse",
      isTrusted: true,
    }),
  );
}

function botClickSamples(count: number): ClickSample[] {
  const out: ClickSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i * 100;
    out.push({ seq: out.length + 1, x: 500.5, y: 300.25, t, kind: 0, button: 0, trusted: 1 });
    out.push({
      seq: out.length + 1,
      x: 500.5,
      y: 300.25,
      t: t + 60,
      kind: 1,
      button: 0,
      trusted: 1,
    });
  }
  return out;
}

function botScrollSamples(count: number): ScrollSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: 100,
    t: i * 60,
    trusted: 1,
    source: 0,
  }));
}

function botClickEvents(count: number, t0: number): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = t0 + i * 100;
    out.push(
      event("pointerdown", {
        clientX: 500.5,
        clientY: 300.25,
        timeStamp: base,
        button: 0,
        isTrusted: false,
      }),
    );
    out.push(
      event("pointerup", {
        clientX: 500.5,
        clientY: 300.25,
        timeStamp: base + 60,
        button: 0,
        isTrusted: false,
      }),
    );
  }
  return out;
}

function botWheelEvents(count: number, t0: number): Event[] {
  return Array.from({ length: count }, (_, i) =>
    event("wheel", {
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      timeStamp: t0 + i * 60,
      isTrusted: false,
    }),
  );
}

function documentScroll(t: number): Event {
  return event("scroll", { timeStamp: t, isTrusted: false });
}

function fakeWindow(): { target: EventTarget; clock: () => number; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  const target = new EventTarget();
  let t = 0;
  const original = target.dispatchEvent.bind(target);
  target.dispatchEvent = ((e: Event) => {
    if (Number.isFinite(e.timeStamp)) t = e.timeStamp;
    return original(e);
  }) as typeof target.dispatchEvent;
  globals.window = target;
  return {
    target,
    clock: () => t,
    restore: () => {
      if (previous === undefined) delete globals.window;
      else globals.window = previous;
    },
  };
}

function dispatchAll(target: EventTarget, events: Event[]): void {
  for (const e of events) target.dispatchEvent(e);
}

describe("ScoreComputer con señales", () => {
  it("sin clicks/scrolls (o con evidencia insuficiente) el score es idéntico al mouse", () => {
    const samples = straightLine(30);
    const windowMs = 30 * 60;
    const mouseOnly = new ScoreComputer().evaluate(samples, windowMs);
    const emptySignals = new ScoreComputer().evaluate(samples, windowMs, [], []);
    const tooFew = new ScoreComputer().evaluate(
      samples,
      windowMs,
      botClickSamples(2),
      botScrollSamples(3),
    );
    expect(emptySignals).toEqual(mouseOnly);
    expect(tooFew).toEqual(mouseOnly);
    expect(new ScoreComputer().getSignalScores()).toEqual({
      mouse: null,
      click: null,
      scroll: null,
    });
  });

  it("getSignalScores expone cada señal y el mouse sigue intacto", () => {
    const computer = new ScoreComputer();
    const samples = straightLine(30);
    const mouseOnly = computer.evaluate(samples, 30 * 60).score;
    expect(computer.getSignalScores()).toEqual({
      mouse: mouseOnly,
      click: null,
      scroll: null,
    });

    const combined = computer.evaluate(samples, 30 * 60, botClickSamples(8), botScrollSamples(9));
    expect(combined.score).toBeGreaterThan(mouseOnly as number);
    const signalScores = computer.getSignalScores();
    expect(signalScores.mouse).toBe(mouseOnly);
    expect(signalScores.click).toBeGreaterThan(0.9);
    expect(signalScores.scroll).toBeGreaterThan(0.9);
  });

  it("solo clicks con evidencia suficiente también produce score", () => {
    const computer = new ScoreComputer();
    const result = computer.evaluate([], 0, botClickSamples(8), []);
    expect(result.score).toBeGreaterThan(0.9);
    expect(computer.getSignalScores()).toEqual({
      mouse: null,
      click: result.score,
      scroll: null,
    });
  });
});

describe("IsThatAnAI (Etapa 6)", () => {
  it("expone muestras, contadores y scores por señal; stop limpia todo", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      dispatchAll(target, botClickEvents(8, 0));
      dispatchAll(target, botWheelEvents(9, 0));
      detector.evaluate();

      expect(detector.getRecentClicks()).toHaveLength(16);
      expect(detector.getRecentScrolls()).toHaveLength(9);
      expect(detector.getRecentClicks(15).map((sample) => sample.seq)).toEqual([16]);
      expect(detector.getRecentScrolls(8).map((sample) => sample.seq)).toEqual([9]);
      const stats = detector.getStats();
      expect(stats.clickCount).toBe(16);
      expect(stats.scrollCount).toBe(9);
      expect(stats.sampleCount).toBe(0);
      const scores = detector.getSignalScores();
      expect(scores.mouse).toBeNull();
      expect(scores.click).toBeGreaterThan(0.9);
      expect(scores.scroll).toBeGreaterThan(0.9);

      detector.stop();
      expect(detector.getRecentClicks()).toEqual([]);
      expect(detector.getRecentScrolls()).toEqual([]);
      expect(detector.getStats().clickCount).toBe(0);
      expect(detector.getStats().scrollCount).toBe(0);
      expect(detector.getSignalScores()).toEqual({ mouse: null, click: null, scroll: null });
    } finally {
      restore();
    }
  });

  it("añadir clicks/scrolls bot sube el score respecto al mouse solo", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      dispatchAll(target, pointerEvents(30));
      detector.evaluate();
      const before = detector.getVerdict().score as number;
      dispatchAll(target, botClickEvents(8, 2000));
      dispatchAll(target, botWheelEvents(9, 2000));
      detector.evaluate();
      const after = detector.getVerdict().score as number;
      expect(after).toBeGreaterThan(before);
      expect(detector.getSignalScores().click).toBeGreaterThan(0.9);
      expect(detector.getSignalScores().scroll).toBeGreaterThan(0.9);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("el clic medio se expone en getRecentClicks pero no altera el score", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      dispatchAll(target, botClickEvents(8, 0));
      detector.evaluate();
      const before = detector.getSignalScores().click;

      dispatchAll(target, [
        event("pointerdown", {
          clientX: 12.5,
          clientY: 34.75,
          timeStamp: 3000,
          button: 1,
          isTrusted: false,
        }),
        event("pointerup", {
          clientX: 900.25,
          clientY: 800.5,
          timeStamp: 6000,
          button: 1,
          isTrusted: false,
        }),
      ]);
      detector.evaluate();
      expect(detector.getSignalScores().click).toBe(before);

      const clicks = detector.getRecentClicks();
      expect(clicks).toHaveLength(18);
      expect(clicks.filter((sample) => sample.button === 1)).toHaveLength(2);
      expect(clicks[17].t - clicks[16].t).toBe(3000);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("autoscroll simulado (solo eventos scroll, sin wheel) produce score de scroll", () => {
    const { target, restore } = fakeWindow();
    try {
      const host = target as EventTarget & { scrollX: number; scrollY: number };
      host.scrollX = 0;
      host.scrollY = 0;
      const detector = new IsThatAnAI();
      detector.start();
      for (let i = 0; i < 12; i += 1) {
        host.scrollY = i * 100; // el autoscroll mueve el documento antes del evento
        target.dispatchEvent(documentScroll(i * 60));
      }
      detector.evaluate();

      const scores = detector.getSignalScores();
      expect(scores.mouse).toBeNull();
      expect(scores.scroll).toBeGreaterThan(0.9);
      const scrolls = detector.getRecentScrolls();
      expect(scrolls).toHaveLength(12);
      expect(scrolls.every((sample) => sample.source === 1)).toBe(true);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("window.scrollTo() de un bot queda registrado como source=1", () => {
    const { target, restore } = fakeWindow();
    try {
      const host = target as EventTarget & { scrollX: number; scrollY: number };
      host.scrollX = 0;
      host.scrollY = 0;
      const detector = new IsThatAnAI();
      detector.start();
      dispatchAll(target, [documentScroll(100)]);
      host.scrollY = 500; // window.scrollTo(0, 500) del bot
      dispatchAll(target, [documentScroll(160)]);

      const scrolls = detector.getRecentScrolls();
      expect(scrolls).toHaveLength(2);
      expect(scrolls.map((sample) => sample.source)).toEqual([1, 1]);
      expect(scrolls[0].dy).toBe(0);
      expect(scrolls[1].dy).toBe(500);
      expect(scrolls[1].dx).toBe(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("el veredicto conserva la histeresis al combinar señales", () => {
    const { target, clock, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI({ now: clock });
      const emitted: string[] = [];
      detector.onVerdict((verdict) => emitted.push(verdict.state));
      detector.start();

      dispatchAll(target, botClickEvents(8, 0));
      dispatchAll(target, botWheelEvents(9, 0));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("measuring");
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("measuring");
      expect(emitted).toEqual([]);

      // Más de AI_CONFIRM_MS (600ms) después: ahora sí cambia a ai.
      dispatchAll(target, botClickEvents(8, 1400));
      dispatchAll(target, botWheelEvents(9, 1200));
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      expect(emitted).toEqual(["ai"]);
      detector.stop();
    } finally {
      restore();
    }
  });
});

describe("SSR", () => {
  it("importa sin DOM y expone getStats con los contadores nuevos", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      "const detector = new IsThatAnAI();",
      "console.log(JSON.stringify({ stats: detector.getStats(), scores: detector.getSignalScores() }));",
    ].join("\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(JSON.parse(output)).toEqual({
      stats: {
        sampleCount: 0,
        droppedCount: 0,
        eventsPerSecond: 0,
        bufferFill: 0,
        trustedRatio: 0,
        lastEventAt: 0,
        clickCount: 0,
        scrollCount: 0,
      },
      scores: { mouse: null, click: null, scroll: null },
    });
  });
});
