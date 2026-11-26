import { describe, expect, it } from "bun:test";
import { type AttentionSample, createAttentionCollector } from "../src/collectors/attention";
import { createTouchCollector, type TouchSample } from "../src/collectors/touch";
import * as attentionFeatures from "../src/features/attention";
import * as touchFeatures from "../src/features/touch";

// ---------------------------------------------------------------------------
// Targeting deterministico: no hay DOM ni eventos reales. Los listeners se
// disparan con objetos planos, lo que permite inyectar getters hostiles.
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly added: Array<{ type: string; options?: AddEventListenerOptions }> = [];
  readonly removed: string[] = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    this.added.push({ type, options });
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: AddEventListenerOptions,
  ): void {
    this.removed.push(type);
    this.listeners.get(type)?.delete(listener as Listener);
  }

  dispatch(type: string, props: Record<string, unknown> = {}): void {
    this.dispatchRaw(type, { type, isTrusted: false, timeStamp: 0, ...props });
  }

  dispatchRaw(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  asTarget(): EventTarget {
    return this as unknown as EventTarget;
  }
}

function touchEvent(
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    pointerType: "touch",
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    pressure: 0.5,
    radiusX: 5,
    radiusY: 5,
    rotationAngle: 0,
    isTrusted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Colector táctil
// ---------------------------------------------------------------------------

describe("createTouchCollector: listeners reales y muestras numericas", () => {
  it("registra down/move/up de touch y pen; ignora mouse; trusted solo true", () => {
    const target = new FakeTarget();
    let clock = 0;
    const collector = createTouchCollector({ target: target.asTarget(), now: () => clock });

    collector.attach();
    target.dispatch(
      "pointerdown",
      touchEvent("pointerdown", {
        clientX: 10.5,
        clientY: 20.25,
        timeStamp: 100,
        pressure: 0.4,
        radiusX: 5.5,
        radiusY: 6,
        rotationAngle: 30,
        isTrusted: true,
      }),
    );
    clock = 120;
    target.dispatch(
      "pointermove",
      touchEvent("pointermove", {
        clientX: 11,
        clientY: 21,
        timeStamp: 120,
        pressure: 0.5,
        radiusX: 6,
        radiusY: 7,
        rotationAngle: 45,
        isTrusted: true,
      }),
    );
    clock = 200;
    target.dispatch(
      "pointerup",
      touchEvent("pointerup", {
        clientX: 11,
        clientY: 21,
        timeStamp: 200,
        pressure: 0.1,
        radiusX: 4,
        radiusY: 4,
        rotationAngle: 10,
      }),
    );
    target.dispatch("pointerdown", {
      ...touchEvent("pointerdown", {
        pointerType: "pen",
        clientX: 1,
        clientY: 2,
        timeStamp: 300,
        pressure: 0.9,
        radiusX: 1,
        radiusY: 2,
        rotationAngle: 90,
        isTrusted: 1,
      }),
    });
    target.dispatch(
      "pointerdown",
      touchEvent("pointerdown", {
        pointerType: "mouse",
        clientX: 7,
        clientY: 8,
        timeStamp: 400,
        isTrusted: true,
      }),
    );

    const samples = collector.getSamples();
    expect(samples).toEqual([
      {
        seq: 1,
        t: 100,
        kind: 0,
        x: 10.5,
        y: 20.25,
        pointerType: 2,
        pressure: 0.4,
        radiusX: 5.5,
        radiusY: 6,
        rotationAngle: 30,
        trusted: 1,
      },
      {
        seq: 2,
        t: 120,
        kind: 0,
        x: 11,
        y: 21,
        pointerType: 2,
        pressure: 0.5,
        radiusX: 6,
        radiusY: 7,
        rotationAngle: 45,
        trusted: 1,
      },
      {
        seq: 3,
        t: 200,
        kind: 1,
        x: 11,
        y: 21,
        pointerType: 2,
        pressure: 0.1,
        radiusX: 4,
        radiusY: 4,
        rotationAngle: 10,
        trusted: 0,
      },
      {
        seq: 4,
        t: 300,
        kind: 0,
        x: 1,
        y: 2,
        pointerType: 1,
        pressure: 0.9,
        radiusX: 1,
        radiusY: 2,
        rotationAngle: 90,
        trusted: 0,
      },
    ]);
    expect(collector.lastEventAt).toBe(300);
    expect(collector.eventsSince(0)).toBe(4);
    expect(collector.eventsSince(121)).toBe(2);
    expect(collector.eventsSince(Number.NaN)).toBe(0);
    expect(collector.eventsSince(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("attach/detach son idempotentes, pasivos y limpian los listeners", () => {
    const target = new FakeTarget();
    const collector = createTouchCollector({ target: target.asTarget() });
    collector.attach();
    collector.attach();
    expect(target.added).toEqual([
      { type: "pointerdown", options: { passive: true, capture: true } },
      { type: "pointermove", options: { passive: true, capture: true } },
      { type: "pointerup", options: { passive: true, capture: true } },
    ]);
    collector.detach();
    collector.detach();
    expect(target.removed).toEqual(["pointerdown", "pointermove", "pointerup"]);
    target.dispatch("pointerdown", touchEvent("pointerdown", { timeStamp: 10 }));
    expect(collector.getSamples()).toEqual([]);
    collector.attach();
    target.dispatch("pointerdown", touchEvent("pointerdown", { timeStamp: 20 }));
    expect(collector.getSamples().length).toBe(1);
  });

  it("recorta el buffer circular y clear reinicia todo el estado", () => {
    const target = new FakeTarget();
    const collector = createTouchCollector({ target: target.asTarget(), bufferSize: 3 });
    collector.attach();
    for (let i = 1; i <= 5; i += 1) {
      target.dispatch("pointerdown", touchEvent("pointerdown", { timeStamp: i * 10 }));
    }
    expect(collector.getSamples().map((sample) => sample.seq)).toEqual([3, 4, 5]);
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
    expect(collector.lastEventAt).toBe(0);
    expect(collector.eventsSince(0)).toBe(0);
  });

  it("getters/proxies hostiles y reloj hostil nunca lanzan fuera del listener", () => {
    const target = new FakeTarget();
    const hostile = new Proxy(
      {},
      {
        get(_object, key) {
          if (key === "pointerType") return "touch";
          if (key === "clientX" || key === "isTrusted") throw new Error("getter hostil");
          if (key === "timeStamp") return Number.NaN;
          return 0;
        },
      },
    );
    const collector = createTouchCollector({
      target: target.asTarget(),
      now: () => {
        throw new Error("reloj hostil");
      },
    });
    collector.attach();
    expect(() => target.dispatchRaw("pointerdown", hostile)).not.toThrow();
    const samples = collector.getSamples();
    expect(samples.length).toBe(1);
    expect(samples[0].x).toBe(0);
    expect(samples[0].t).toBe(0);
    expect(samples[0].trusted).toBe(0);
    expect(collector.eventsSince(0)).toBe(0);

    const hostileTarget = {
      addEventListener() {
        throw new Error("add hostil");
      },
      removeEventListener() {
        throw new Error("remove hostil");
      },
    } as unknown as EventTarget;
    const guarded = createTouchCollector({ target: hostileTarget });
    expect(() => guarded.attach()).not.toThrow();
    expect(() => guarded.detach()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Colector de atención
// ---------------------------------------------------------------------------

describe("createAttentionCollector: listeners reales y codigos numericos", () => {
  it("registra visible/hidden/focus/blur/resize/idle/active", () => {
    const target = new FakeTarget();
    let clock = 0;
    const collector = createAttentionCollector({ target: target.asTarget(), now: () => clock });
    collector.attach();
    target.dispatch("visibilitychange", {
      hidden: false,
      visibilityState: "visible",
      timeStamp: 100,
      isTrusted: true,
    });
    clock = 150;
    target.dispatch("visibilitychange", {
      hidden: true,
      visibilityState: "hidden",
      timeStamp: 150,
      isTrusted: false,
    });
    clock = 200;
    target.dispatch("focus", { timeStamp: 200, isTrusted: true });
    target.dispatch("blur", { timeStamp: 210 });
    target.dispatch("resize", { timeStamp: 220 });
    target.dispatch("idle", { timeStamp: 300 });
    target.dispatch("active", { timeStamp: 310 });

    expect(collector.getSamples()).toEqual([
      { seq: 1, t: 100, kind: 0, trusted: 1 },
      { seq: 2, t: 150, kind: 1, trusted: 0 },
      { seq: 3, t: 200, kind: 2, trusted: 1 },
      { seq: 4, t: 210, kind: 3, trusted: 0 },
      { seq: 5, t: 220, kind: 4, trusted: 0 },
      { seq: 6, t: 300, kind: 5, trusted: 0 },
      { seq: 7, t: 310, kind: 6, trusted: 0 },
    ]);
    expect(collector.lastEventAt).toBe(310);
    expect(collector.eventsSince(0)).toBe(7);
    expect(collector.eventsSince(151)).toBe(5);
  });

  it("attach/detach son idempotentes y cancelan temporizadores y listeners", () => {
    const target = new FakeTarget();
    const collector = createAttentionCollector({ target: target.asTarget() });
    collector.attach();
    collector.attach();
    expect(target.added.map((entry) => entry.type)).toEqual([
      "visibilitychange",
      "focus",
      "blur",
      "resize",
      "idle",
      "active",
      "pointermove",
      "pointerdown",
      "keydown",
    ]);
    expect(target.added.every((entry) => entry.options?.passive === true)).toBe(true);
    collector.detach();
    collector.detach();
    expect(target.removed.length).toBe(9);
    target.dispatch("focus", { timeStamp: 10 });
    expect(collector.getSamples()).toEqual([]);
  });

  it("actividad mientras esta idle genera kind 6 una sola vez", () => {
    const target = new FakeTarget();
    const collector = createAttentionCollector({ target: target.asTarget() });
    collector.attach();
    target.dispatch("idle", { timeStamp: 100 });
    target.dispatch("pointermove", { timeStamp: 110 });
    target.dispatch("pointermove", { timeStamp: 120 });
    expect(collector.getSamples().map((sample) => sample.kind)).toEqual([5, 6]);
  });

  it("recorta el buffer y clear reinicia el estado", () => {
    const target = new FakeTarget();
    const collector = createAttentionCollector({ target: target.asTarget(), bufferSize: 3 });
    collector.attach();
    for (let i = 1; i <= 5; i += 1) {
      target.dispatch("focus", { timeStamp: i * 10 });
    }
    expect(collector.getSamples().map((sample) => sample.seq)).toEqual([3, 4, 5]);
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
    expect(collector.lastEventAt).toBe(0);
    expect(collector.eventsSince(0)).toBe(0);
  });

  it("getters hostiles y target hostil no lanzan; trusted requiere true", () => {
    const target = new FakeTarget();
    const collector = createAttentionCollector({
      target: target.asTarget(),
      now: () => {
        throw new Error("reloj hostil");
      },
    });
    collector.attach();
    const hostile = new Proxy(
      {},
      {
        get(_object, key) {
          if (key === "hidden") throw new Error("getter hostil");
          if (key === "timeStamp") return Number.POSITIVE_INFINITY;
          if (key === "isTrusted") return 1;
          return undefined;
        },
      },
    );
    expect(() => target.dispatchRaw("visibilitychange", hostile)).not.toThrow();
    const samples = collector.getSamples();
    expect(samples.length).toBe(1);
    expect(samples[0].kind).toBe(0);
    expect(samples[0].t).toBe(0);
    expect(samples[0].trusted).toBe(0);
    expect(collector.eventsSince(0)).toBe(0);

    const hostileTarget = {
      addEventListener() {
        throw new Error("add hostil");
      },
      removeEventListener() {
        throw new Error("remove hostil");
      },
    } as unknown as EventTarget;
    const guarded = createAttentionCollector({ target: hostileTarget });
    expect(() => guarded.attach()).not.toThrow();
    expect(() => guarded.detach()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Importación SSR de los cuatro módulos (proceso hijo sin globals de DOM)
// ---------------------------------------------------------------------------

describe("SSR: importar los cuatro modulos sin window/document/navigator", () => {
  it("los cuatro modulos se importan en un proceso limpio", () => {
    const entries = [
      "../src/collectors/touch.ts",
      "../src/collectors/attention.ts",
      "../src/features/touch.ts",
      "../src/features/attention.ts",
    ].map((file) => new URL(file, import.meta.url).href);
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      ...entries.map((entry) => `await import(${JSON.stringify(entry)});`),
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Medidas táctiles: caso discriminante + caso vacío para CADA una de las 10
// ---------------------------------------------------------------------------

function touchSeq(rows: Array<Partial<TouchSample>>): TouchSample[] {
  const base: TouchSample = {
    seq: 1,
    t: 0,
    kind: 0,
    x: 100,
    y: 100,
    pointerType: 2,
    pressure: 0.5,
    radiusX: 5,
    radiusY: 5,
    rotationAngle: 0,
    trusted: 1,
  };
  return rows.map((row, index) => ({ ...base, ...row, seq: index + 1 }));
}

describe("10 medidas táctiles: discriminan y manejan entrada vacia", () => {
  it("L114 presion: presion constante vs. variable", () => {
    const constant = touchSeq([{}, {}, {}, {}, {}].map(() => ({ pressure: 0.5 })));
    const variable = touchSeq([
      { pressure: 0.1 },
      { pressure: 0.9 },
      { pressure: 0.2 },
      { pressure: 0.8 },
      { pressure: 0.3 },
    ]);
    expect(touchFeatures.touchPressure(constant)).toBe(1);
    expect(touchFeatures.touchPressure(variable)).toBe(0);
    expect(touchFeatures.touchPressure([])).toBe(0);
  });

  it("L115 area de contacto: area constante vs. variable", () => {
    const constant = touchSeq([{}, {}, {}, {}, {}]);
    const variable = touchSeq([
      { radiusX: 1, radiusY: 10 },
      { radiusX: 4, radiusY: 10 },
      { radiusX: 1.2, radiusY: 10 },
      { radiusX: 3.6, radiusY: 10 },
      { radiusX: 1.5, radiusY: 10 },
    ]);
    expect(touchFeatures.touchContactArea(constant)).toBe(1);
    expect(touchFeatures.touchContactArea(variable)).toBe(0);
    expect(touchFeatures.touchContactArea([])).toBe(0);
  });

  it("L116 inclinacion: rotationAngle fijo vs. repartido", () => {
    const fixed = touchSeq([{}, {}, {}, {}, {}].map(() => ({ rotationAngle: 10 })));
    const varied = touchSeq([
      { rotationAngle: 0 },
      { rotationAngle: 90 },
      { rotationAngle: 180 },
      { rotationAngle: 270 },
      { rotationAngle: 45 },
    ]);
    expect(touchFeatures.touchTilt(fixed)).toBe(1);
    expect(touchFeatures.touchTilt(varied)).toBe(0);
    expect(touchFeatures.touchTilt([])).toBe(0);
  });

  it("L117 duracion: duraciones identicas vs. irregulares", () => {
    const steady = touchSeq([
      { t: 0 },
      { t: 100, kind: 1 },
      { t: 1000 },
      { t: 1100, kind: 1 },
      { t: 2000 },
      { t: 2100, kind: 1 },
    ]);
    const irregular = touchSeq([
      { t: 0 },
      { t: 50, kind: 1 },
      { t: 1000 },
      { t: 1200, kind: 1 },
      { t: 2000 },
      { t: 2080, kind: 1 },
    ]);
    expect(touchFeatures.touchDuration(steady)).toBe(1);
    expect(touchFeatures.touchDuration(irregular)).toBe(0);
    expect(touchFeatures.touchDuration([])).toBe(0);
  });

  it("L118 inercia: velocidad constante vs. desaceleracion natural", () => {
    const constantSpeed = touchSeq([
      { x: 0, t: 0 },
      { x: 10, t: 100 },
      { x: 20, t: 200 },
      { x: 30, t: 300 },
      { x: 30, t: 400, kind: 1 },
    ]);
    const decelerating = touchSeq([
      { x: 0, t: 0 },
      { x: 12, t: 100 },
      { x: 18, t: 200 },
      { x: 21, t: 300 },
      { x: 21, t: 400, kind: 1 },
    ]);
    expect(touchFeatures.touchInertialSlide(constantSpeed)).toBe(1);
    expect(touchFeatures.touchInertialSlide(decelerating)).toBe(0);
    expect(touchFeatures.touchInertialSlide([])).toBe(0);
  });

  it("L119 multidedo: un dedo vs. salto brusco de otro dedo", () => {
    const single = touchSeq([
      { x: 0, t: 0 },
      { x: 10, t: 100 },
      { x: 20, t: 200 },
      { x: 30, t: 300 },
      { x: 30, t: 400, kind: 1 },
    ]);
    const twoFingers = touchSeq([
      { x: 0, t: 0 },
      { x: 100, t: 10 },
      { x: 110, t: 20 },
      { x: 120, t: 30 },
      { x: 120, t: 100, kind: 1 },
    ]);
    expect(touchFeatures.touchMultiTouch(single)).toBe(1);
    expect(touchFeatures.touchMultiTouch(twoFingers)).toBe(0);
    expect(touchFeatures.touchMultiTouch([])).toBe(0);
  });

  it("L120 pinza/zoom: sin expansion vs. expansion clara", () => {
    const flat = touchSeq([
      { x: 0, t: 0 },
      { x: 10, t: 100 },
      { x: 20, t: 200 },
      { x: 30, t: 300 },
      { x: 30, t: 400, kind: 1 },
    ]);
    const pinch = touchSeq([
      { x: 0, t: 0 },
      { x: 10, t: 100 },
      { x: 40, t: 200 },
      { x: 90, t: 300 },
      { x: 90, t: 400, kind: 1 },
    ]);
    expect(touchFeatures.touchPinchZoom(flat)).toBe(1);
    expect(touchFeatures.touchPinchZoom(pinch)).toBe(0);
    expect(touchFeatures.touchPinchZoom([])).toBe(0);
  });

  it("L121 toque falso: toques de 0ms sin recorrido vs. toques reales", () => {
    const fakes = touchSeq([
      { t: 0 },
      { t: 1, kind: 1 },
      { t: 1000 },
      { t: 1001, kind: 1 },
      { t: 2000 },
      { t: 2001, kind: 1 },
    ]);
    const real = touchSeq([
      { x: 100, t: 0 },
      { x: 110, t: 100, kind: 1 },
      { x: 100, t: 1000 },
      { x: 110, t: 1100, kind: 1 },
      { x: 100, t: 2000 },
      { x: 110, t: 2100, kind: 1 },
    ]);
    expect(touchFeatures.touchVsClickFalse(fakes)).toBe(1);
    expect(touchFeatures.touchVsClickFalse(real)).toBe(0);
    expect(touchFeatures.touchVsClickFalse([])).toBe(0);
  });

  it("L122 movimiento del dispositivo (proxy numerico): inmovil vs. micro-jitter", () => {
    const staticFinger = touchSeq([
      { x: 100, t: 0 },
      { x: 100, t: 10 },
      { x: 100, t: 20 },
      { x: 100, t: 30 },
      { x: 100, t: 40 },
      { x: 100, t: 50, kind: 1 },
    ]);
    const jitter = touchSeq([
      { x: 100, t: 0 },
      { x: 100.2, t: 10 },
      { x: 99.8, t: 20 },
      { x: 100.2, t: 30 },
      { x: 99.8, t: 40 },
      { x: 99.8, t: 50, kind: 1 },
    ]);
    expect(touchFeatures.touchDeviceMotion(staticFinger)).toBe(1);
    expect(touchFeatures.touchDeviceMotion(jitter)).toBe(0);
    expect(touchFeatures.touchDeviceMotion([])).toBe(0);
  });

  it("L123 temblor de mano: trayectoria limpia vs. zigzag perpendicular", () => {
    const smooth = touchSeq([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 100 },
      { x: 20, y: 0, t: 200 },
      { x: 30, y: 0, t: 300 },
      { x: 30, y: 0, t: 400, kind: 1 },
    ]);
    const shaky = touchSeq([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 100 },
      { x: 0, y: 0, t: 200 },
      { x: 10, y: 0, t: 300 },
      { x: 0, y: 0, t: 400 },
      { x: 0, y: 0, t: 500, kind: 1 },
    ]);
    expect(touchFeatures.touchHandTremor(smooth)).toBe(1);
    expect(touchFeatures.touchHandTremor(shaky)).toBe(0);
    expect(touchFeatures.touchHandTremor([])).toBe(0);
  });

  it("extractor: forma exacta, valores finitos y defensividad ante valores hostiles", () => {
    expect(Object.keys(touchFeatures.extractTouchFeatures([]))).toEqual([
      "pressure",
      "contactArea",
      "tilt",
      "duration",
      "inertialSlide",
      "multiTouch",
      "pinchZoom",
      "touchVsClick",
      "deviceMotion",
      "handTremor",
    ]);
    expect(touchFeatures.extractTouchFeatures([])).toEqual({
      pressure: 0,
      contactArea: 0,
      tilt: 0,
      duration: 0,
      inertialSlide: 0,
      multiTouch: 0,
      pinchZoom: 0,
      touchVsClick: 0,
      deviceMotion: 0,
      handTremor: 0,
    });
    const hostile = touchSeq([
      {
        x: Number.NaN,
        y: Number.POSITIVE_INFINITY,
        t: Number.NEGATIVE_INFINITY,
        pressure: Number.NaN,
        radiusX: 1e308,
        radiusY: 1e308,
        rotationAngle: Number.NaN,
      },
      {
        x: -1e308,
        y: 1e308,
        t: 1e308,
        pressure: -5,
        radiusX: -10,
        radiusY: Number.POSITIVE_INFINITY,
        rotationAngle: 1e308,
      },
      { t: 100, kind: 1 },
    ]);
    const features = touchFeatures.extractTouchFeatures(hostile);
    for (const value of Object.values(features)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Medidas de atención: caso discriminante + caso vacío para CADA una de las 11
// ---------------------------------------------------------------------------

function attentionSeq(rows: Array<{ kind: number; t: number }>): AttentionSample[] {
  return rows.map((row, index) => ({ seq: index + 1, t: row.t, kind: row.kind, trusted: 1 }));
}

describe("11 medidas de atención: discriminan y manejan entrada vacia", () => {
  it("L125 cambios de pestaña: 5 transiciones hidden->visible vs. ninguna", () => {
    const many = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 1, t: 200 },
      { kind: 0, t: 300 },
      { kind: 1, t: 400 },
      { kind: 0, t: 500 },
      { kind: 1, t: 600 },
      { kind: 0, t: 700 },
      { kind: 1, t: 800 },
      { kind: 0, t: 900 },
    ]);
    const none = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 2, t: 100 },
    ]);
    expect(attentionFeatures.attentionTabSwitches(many)).toBe(1);
    expect(attentionFeatures.attentionTabSwitches(none)).toBe(0);
    expect(attentionFeatures.attentionTabSwitches([])).toBe(0);
  });

  it("L126 segundo plano: tiempo hidden predominante vs. siempre visible", () => {
    const background = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 1, t: 100 },
      { kind: 0, t: 1000 },
    ]);
    const foreground = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 0, t: 100 },
    ]);
    expect(attentionFeatures.attentionBackground(background)).toBe(1);
    expect(attentionFeatures.attentionBackground(foreground)).toBe(0);
    expect(attentionFeatures.attentionBackground([])).toBe(0);
  });

  it("L127 perdida de foco: 5 blur vs. ninguno", () => {
    const blurs = attentionSeq(Array.from({ length: 5 }, (_, i) => ({ kind: 3, t: i * 100 })));
    const focused = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 2, t: 100 },
    ]);
    expect(attentionFeatures.attentionFocusLoss(blurs)).toBe(1);
    expect(attentionFeatures.attentionFocusLoss(focused)).toBe(0);
    expect(attentionFeatures.attentionFocusLoss([])).toBe(0);
  });

  it("L128 activo vs. inactivo: sin idle vs. mayormente idle", () => {
    const alwaysActive = attentionSeq([
      { kind: 6, t: 0 },
      { kind: 6, t: 100 },
      { kind: 6, t: 200 },
    ]);
    const mostlyIdle = attentionSeq([
      { kind: 5, t: 0 },
      { kind: 5, t: 100 },
      { kind: 5, t: 200 },
      { kind: 6, t: 300 },
      { kind: 6, t: 400 },
    ]);
    expect(attentionFeatures.attentionActiveInactive(alwaysActive)).toBe(1);
    expect(attentionFeatures.attentionActiveInactive(mostlyIdle)).toBe(0);
    expect(attentionFeatures.attentionActiveInactive([])).toBe(0);
  });

  it("L129 regreso del cursor (por blur->focus): ritmo fijo vs. variable", () => {
    const steady = attentionSeq([
      { kind: 3, t: 0 },
      { kind: 2, t: 100 },
      { kind: 3, t: 200 },
      { kind: 2, t: 300 },
      { kind: 3, t: 400 },
      { kind: 2, t: 500 },
    ]);
    const variable = attentionSeq([
      { kind: 3, t: 0 },
      { kind: 2, t: 50 },
      { kind: 3, t: 200 },
      { kind: 2, t: 400 },
      { kind: 3, t: 600 },
      { kind: 2, t: 1400 },
    ]);
    expect(attentionFeatures.attentionCursorReturn(steady)).toBe(1);
    expect(attentionFeatures.attentionCursorReturn(variable)).toBe(0);
    expect(attentionFeatures.attentionCursorReturn([])).toBe(0);
  });

  it("L130 resize: tres cambios vs. ninguno", () => {
    const resizes = attentionSeq([
      { kind: 4, t: 0 },
      { kind: 4, t: 100 },
      { kind: 4, t: 200 },
    ]);
    const stable = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 6, t: 100 },
    ]);
    expect(attentionFeatures.attentionResize(resizes)).toBe(1);
    expect(attentionFeatures.attentionResize(stable)).toBe(0);
    expect(attentionFeatures.attentionResize([])).toBe(0);
  });

  it("L131 tiempo de lectura: actuar en 10ms vs. en 500ms", () => {
    const instant = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 6, t: 10 },
      { kind: 0, t: 100 },
      { kind: 6, t: 110 },
      { kind: 0, t: 200 },
      { kind: 6, t: 210 },
      { kind: 0, t: 300 },
      { kind: 6, t: 310 },
    ]);
    const reading = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 6, t: 500 },
      { kind: 0, t: 1000 },
      { kind: 6, t: 1500 },
      { kind: 0, t: 2000 },
      { kind: 6, t: 2500 },
      { kind: 0, t: 3000 },
      { kind: 6, t: 3500 },
    ]);
    expect(attentionFeatures.attentionReadingTime(instant)).toBe(1);
    expect(attentionFeatures.attentionReadingTime(reading)).toBe(0);
    expect(attentionFeatures.attentionReadingTime([])).toBe(0);
  });

  it("L132 tiempo de reaccion: 10ms vs. 1000ms", () => {
    const quick = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 110 },
      { kind: 1, t: 1000 },
      { kind: 0, t: 1100 },
      { kind: 6, t: 1110 },
    ]);
    const slow = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 1100 },
      { kind: 1, t: 2000 },
      { kind: 0, t: 2100 },
      { kind: 6, t: 3100 },
    ]);
    expect(attentionFeatures.attentionReactionTime(quick)).toBe(1);
    expect(attentionFeatures.attentionReactionTime(slow)).toBe(0);
    expect(attentionFeatures.attentionReactionTime([])).toBe(0);
  });

  it("L133 variacion del tiempo de reaccion: constante vs. irregular", () => {
    const constant = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 200 },
      { kind: 1, t: 1000 },
      { kind: 0, t: 1100 },
      { kind: 6, t: 1200 },
      { kind: 1, t: 2000 },
      { kind: 0, t: 2100 },
      { kind: 6, t: 2200 },
    ]);
    const irregular = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 120 },
      { kind: 1, t: 1000 },
      { kind: 0, t: 1100 },
      { kind: 6, t: 1600 },
      { kind: 1, t: 2000 },
      { kind: 0, t: 2100 },
      { kind: 6, t: 2160 },
    ]);
    expect(attentionFeatures.attentionReactionVariation(constant)).toBe(1);
    expect(attentionFeatures.attentionReactionVariation(irregular)).toBe(0);
    expect(attentionFeatures.attentionReactionVariation([])).toBe(0);
  });

  it("L134 curva de cansancio: reaccion plana vs. cada vez mas lenta", () => {
    const flat = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 200 },
      { kind: 1, t: 1000 },
      { kind: 0, t: 1100 },
      { kind: 6, t: 1200 },
      { kind: 1, t: 2000 },
      { kind: 0, t: 2100 },
      { kind: 6, t: 2200 },
      { kind: 1, t: 3000 },
      { kind: 0, t: 3100 },
      { kind: 6, t: 3200 },
      { kind: 1, t: 4000 },
      { kind: 0, t: 4100 },
      { kind: 6, t: 4200 },
    ]);
    const tiring = attentionSeq([
      { kind: 1, t: 0 },
      { kind: 0, t: 100 },
      { kind: 6, t: 200 },
      { kind: 1, t: 1000 },
      { kind: 0, t: 1100 },
      { kind: 6, t: 1300 },
      { kind: 1, t: 2000 },
      { kind: 0, t: 2100 },
      { kind: 6, t: 2500 },
      { kind: 1, t: 3000 },
      { kind: 0, t: 3100 },
      { kind: 6, t: 3900 },
      { kind: 1, t: 4000 },
      { kind: 0, t: 4100 },
      { kind: 6, t: 5300 },
    ]);
    expect(attentionFeatures.attentionFatigue(flat)).toBe(1);
    expect(attentionFeatures.attentionFatigue(tiring)).toBe(0);
    expect(attentionFeatures.attentionFatigue([])).toBe(0);
  });

  it("L135 pausas largas: sin pausas vs. huecos de 10s", () => {
    const continuous = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 6, t: 100 },
      { kind: 6, t: 200 },
      { kind: 0, t: 300 },
    ]);
    const paused = attentionSeq([
      { kind: 0, t: 0 },
      { kind: 0, t: 10000 },
      { kind: 0, t: 20000 },
    ]);
    expect(attentionFeatures.attentionLongPauses(continuous)).toBe(1);
    expect(attentionFeatures.attentionLongPauses(paused)).toBe(0);
    expect(attentionFeatures.attentionLongPauses([])).toBe(0);
  });

  it("extractor: forma exacta, valores finitos y defensividad ante valores hostiles", () => {
    expect(Object.keys(attentionFeatures.extractAttentionFeatures([]))).toEqual([
      "tabSwitches",
      "background",
      "focusLoss",
      "activeInactive",
      "cursorReturn",
      "resize",
      "readingTime",
      "reactionTime",
      "reactionVariation",
      "fatigue",
      "longPauses",
    ]);
    expect(attentionFeatures.extractAttentionFeatures([])).toEqual({
      tabSwitches: 0,
      background: 0,
      focusLoss: 0,
      activeInactive: 0,
      cursorReturn: 0,
      resize: 0,
      readingTime: 0,
      reactionTime: 0,
      reactionVariation: 0,
      fatigue: 0,
      longPauses: 0,
    });
    const hostile: AttentionSample[] = [
      { seq: 1, t: Number.NaN, kind: 1, trusted: 1 },
      { seq: 2, t: Number.POSITIVE_INFINITY, kind: 99, trusted: 0 },
      { seq: 3, t: -1e308, kind: -5, trusted: 0 },
      { seq: 4, t: 1e308, kind: 0, trusted: 1 },
      { seq: 5, t: 1e308 + 100, kind: 6, trusted: 1 },
    ];
    const features = attentionFeatures.extractAttentionFeatures(hostile);
    for (const value of Object.values(features)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Pesos a 0 e invarianza de score: ninguna senal puede cambiar un veredicto
// ---------------------------------------------------------------------------

function weightedScore(
  weights: Readonly<Record<string, number>>,
  features: Readonly<Record<string, number>>,
): number {
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(weights)) {
    const weight = weights[key];
    if (typeof weight === "number" && Number.isFinite(weight) && weight > 0) {
      weighted += weight * features[key];
      total += weight;
    }
  }
  return total > 0 ? weighted / total : 0.5;
}

describe("pesos cero: calibracion intacta e invarianza de score", () => {
  it("las diez medidas táctiles tienen peso 0 y son inmutables", () => {
    const keys = Object.keys(touchFeatures.extractTouchFeatures([]));
    expect(Object.keys(touchFeatures.TOUCH_FEATURE_WEIGHTS)).toEqual(keys);
    expect(Object.values(touchFeatures.TOUCH_FEATURE_WEIGHTS).every((weight) => weight === 0)).toBe(
      true,
    );
    expect(Object.isFrozen(touchFeatures.TOUCH_FEATURE_WEIGHTS)).toBe(true);
    const allOnes = Object.fromEntries(keys.map((key) => [key, 1]));
    const allZeros = Object.fromEntries(keys.map((key) => [key, 0]));
    expect(weightedScore(touchFeatures.TOUCH_FEATURE_WEIGHTS, allOnes)).toBe(0.5);
    expect(weightedScore(touchFeatures.TOUCH_FEATURE_WEIGHTS, allZeros)).toBe(0.5);
  });

  it("las once medidas de atención tienen peso 0 y son inmutables", () => {
    const keys = Object.keys(attentionFeatures.extractAttentionFeatures([]));
    expect(Object.keys(attentionFeatures.ATTENTION_FEATURE_WEIGHTS)).toEqual(keys);
    expect(
      Object.values(attentionFeatures.ATTENTION_FEATURE_WEIGHTS).every((weight) => weight === 0),
    ).toBe(true);
    expect(Object.isFrozen(attentionFeatures.ATTENTION_FEATURE_WEIGHTS)).toBe(true);
    const allOnes = Object.fromEntries(keys.map((key) => [key, 1]));
    const allZeros = Object.fromEntries(keys.map((key) => [key, 0]));
    expect(weightedScore(attentionFeatures.ATTENTION_FEATURE_WEIGHTS, allOnes)).toBe(0.5);
    expect(weightedScore(attentionFeatures.ATTENTION_FEATURE_WEIGHTS, allZeros)).toBe(0.5);
  });

  it("ninguna de las 21 medidas devuelve constantes: cada una discrimina", () => {
    const discriminatingTouch = [
      touchFeatures.touchPressure,
      touchFeatures.touchContactArea,
      touchFeatures.touchTilt,
      touchFeatures.touchDuration,
      touchFeatures.touchInertialSlide,
      touchFeatures.touchMultiTouch,
      touchFeatures.touchPinchZoom,
      touchFeatures.touchVsClickFalse,
      touchFeatures.touchDeviceMotion,
      touchFeatures.touchHandTremor,
    ];
    const discriminatingAttention = [
      attentionFeatures.attentionTabSwitches,
      attentionFeatures.attentionBackground,
      attentionFeatures.attentionFocusLoss,
      attentionFeatures.attentionActiveInactive,
      attentionFeatures.attentionCursorReturn,
      attentionFeatures.attentionResize,
      attentionFeatures.attentionReadingTime,
      attentionFeatures.attentionReactionTime,
      attentionFeatures.attentionReactionVariation,
      attentionFeatures.attentionFatigue,
      attentionFeatures.attentionLongPauses,
    ];
    expect(discriminatingTouch.length + discriminatingAttention.length).toBe(21);
    for (const measure of discriminatingTouch) expect(typeof measure([])).toBe("number");
    for (const measure of discriminatingAttention) expect(typeof measure([])).toBe("number");
  });
});
