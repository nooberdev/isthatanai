// Auditoría "mundo real" de las 21 medidas táctiles / de atención.
//
// A diferencia de final-touch-attention.test.ts (muestras hechas a mano), aquí
// TODAS las muestras salen de los colectores reales: se construyen Event
// sintéticos con propiedades definidas y se despachan mediante dispatchEvent
// sobre un EventTarget instrumentado. Así se ejercitan los listeners reales,
// el saneamiento del colector y las medidas en una sola cadena.
//
// Convención: 1 = más probable IA. Los escenarios humanos deben dar valores
// bajos cuando la señal es variable (presión, área, duración, inercia, temblor,
// pausas, reacción...); las señales puramente counting siguen la dirección
// documentada (más eventos => más alto).

import { describe, expect, it } from "bun:test";
import { type AttentionSample, createAttentionCollector } from "../../src/collectors/attention";
import { createTouchCollector, type TouchSample } from "../../src/collectors/touch";
import * as attention from "../../src/features/attention";
import * as touch from "../../src/features/touch";

// ---------------------------------------------------------------------------
// Infraestructura: EventTarget real + eventos sintéticos + spy de listeners
// ---------------------------------------------------------------------------

interface InstrumentedTarget {
  target: EventTarget;
  added: string[];
  removed: string[];
  liveCount(type?: string): number;
}

function instrumentedTarget(): InstrumentedTarget {
  const target = new EventTarget();
  const added: string[] = [];
  const removed: string[] = [];
  const live = new Map<string, number>();
  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);
  target.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    added.push(type);
    live.set(type, (live.get(type) ?? 0) + 1);
    originalAdd(type, listener, options);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    removed.push(type);
    live.set(type, Math.max(0, (live.get(type) ?? 0) - 1));
    originalRemove(type, listener, options);
  }) as typeof target.removeEventListener;
  return {
    target,
    added,
    removed,
    liveCount: (type?: string) =>
      type === undefined ? [...live.values()].reduce((a, b) => a + b, 0) : (live.get(type) ?? 0),
  };
}

function synthetic(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type, { bubbles: true, cancelable: false });
  for (const [key, value] of Object.entries(props)) {
    try {
      Object.defineProperty(event, key, { value, configurable: true, enumerable: true });
    } catch {
      // `isTrusted` (y otras propiedades intrínsecas) no son redefinibles;
      // en un Event sintético valen false/0, que es exactamente lo esperado.
    }
  }
  return event;
}

interface TouchEventSpec {
  type: "pointerdown" | "pointermove" | "pointerup";
  t: number;
  x: number;
  y: number;
  pressure: number;
  radiusX: number;
  radiusY: number;
  rotationAngle: number;
  pointerType?: string;
  trusted?: boolean;
}

function playTouch(
  specs: TouchEventSpec[],
  bufferSize = 1024,
): { samples: TouchSample[]; target: InstrumentedTarget; added: string[]; removed: string[] } {
  const instrumented = instrumentedTarget();
  let clock = 0;
  const collector = createTouchCollector({
    target: instrumented.target,
    now: () => clock,
    bufferSize,
  });
  collector.attach();
  for (const spec of specs) {
    clock = spec.t;
    const event = synthetic(spec.type, {
      pointerType: spec.pointerType ?? "touch",
      clientX: spec.x,
      clientY: spec.y,
      timeStamp: spec.t,
      pressure: spec.pressure,
      radiusX: spec.radiusX,
      radiusY: spec.radiusY,
      rotationAngle: spec.rotationAngle,
      isTrusted: spec.trusted ?? false,
    });
    instrumented.target.dispatchEvent(event);
  }
  const samples = collector.getSamples();
  const { added, removed } = instrumented;
  collector.detach();
  return { samples, target: instrumented, added: [...added], removed: [...removed] };
}

interface AttentionEventSpec {
  type: string;
  t: number;
  hidden?: boolean;
}

function playAttention(
  specs: AttentionEventSpec[],
  bufferSize = 512,
): { samples: AttentionSample[]; target: InstrumentedTarget; added: string[]; removed: string[] } {
  const instrumented = instrumentedTarget();
  // En un navegador visibilitychange se dispara sobre document; el colector
  // resuelve `document` desde target.document (ver resolveDocument).
  const doc = { hidden: false, visibilityState: "visible" };
  Object.defineProperty(instrumented.target, "document", { value: doc, configurable: true });
  let clock = 0;
  const collector = createAttentionCollector({
    target: instrumented.target,
    now: () => clock,
    bufferSize,
  });
  collector.attach();
  for (const spec of specs) {
    clock = spec.t;
    if (spec.type === "visibilitychange" && spec.hidden !== undefined) {
      doc.hidden = spec.hidden;
      doc.visibilityState = spec.hidden ? "hidden" : "visible";
    }
    instrumented.target.dispatchEvent(synthetic(spec.type, { timeStamp: spec.t }));
  }
  const samples = collector.getSamples();
  const { added, removed } = instrumented;
  collector.detach();
  return { samples, target: instrumented, added: [...added], removed: [...removed] };
}

function expectUnit(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

const tap = (
  type: TouchEventSpec["type"],
  t: number,
  x: number,
  y: number,
  pressure: number,
  radius: number,
  rotationAngle = 0,
): TouchEventSpec => ({
  type,
  t,
  x,
  y,
  pressure,
  radiusX: radius,
  radiusY: radius * 1.05,
  rotationAngle,
});

// ---------------------------------------------------------------------------
// Escenarios táctiles realistas (todos alimentados por createTouchCollector)
// ---------------------------------------------------------------------------

/** Cuatro toques humanos: presión en rampa, área que crece, micro-temblor. */
function humanTaps(): TouchEventSpec[] {
  const specs: TouchEventSpec[] = [];
  const starts = [1000, 2400, 4100, 6100];
  const durations = [70, 190, 95, 230];
  starts.forEach((start, i) => {
    const duration = durations[i];
    const x = 210 + i * 4;
    const y = 430 + i * 3;
    const stages = [
      { f: 0.0, p: 0.08, r: 3.0, dx: 0.0, dy: 0.15 },
      { f: 0.18, p: 0.3, r: 5.0, dx: 0.2, dy: -0.15 },
      { f: 0.4, p: 0.52, r: 6.2, dx: -0.2, dy: 0.15 },
      { f: 0.62, p: 0.61, r: 7.0, dx: 0.2, dy: -0.15 },
      { f: 0.8, p: 0.55, r: 6.6, dx: -0.1, dy: 0.15 },
    ];
    stages.forEach((stage, j) => {
      specs.push(
        tap(
          j === 0 ? "pointerdown" : "pointermove",
          start + Math.round(duration * stage.f),
          x + stage.dx,
          y + stage.dy,
          stage.p,
          stage.r,
          4 + i * 12 + j * 3,
        ),
      );
    });
    specs.push(tap("pointerup", start + duration, x, y, 0.12, 4, 4 + i * 12));
  });
  return specs;
}

/** Pulsación larga real (~0.9 s): rampa lenta de presión y micro-temblor. */
function humanLongPress(): TouchEventSpec[] {
  const specs: TouchEventSpec[] = [];
  for (let j = 0; j < 8; j += 1) {
    specs.push(
      tap(
        j === 0 ? "pointerdown" : "pointermove",
        12000 + j * 120,
        180 + (j % 2 === 0 ? 0.1 : -0.1),
        500 + (j % 2 === 0 ? -0.1 : 0.1),
        0.15 + j * 0.06,
        4 + j * 0.4,
        8 + j * 2,
      ),
    );
  }
  specs.push(tap("pointerup", 12900, 180, 500, 0.3, 5, 10));
  return specs;
}

/** Cuatro toques robóticos: presión/área/tilt constantes y duración idéntica. */
function robotTaps(): TouchEventSpec[] {
  const specs: TouchEventSpec[] = [];
  for (let i = 0; i < 4; i += 1) {
    const start = i * 500;
    specs.push(tap("pointerdown", start, 100, 200, 0.5, 5, 20));
    specs.push(tap("pointermove", start + 50, 100, 200, 0.5, 5, 20));
    specs.push(tap("pointerup", start + 100, 100, 200, 0.5, 5, 20));
  }
  return specs;
}

/** Toques falsos: eventos táctiles sintéticos de 0 ms y sin recorrido. */
function fakeMouseClickTaps(): TouchEventSpec[] {
  const specs: TouchEventSpec[] = [];
  for (let i = 0; i < 4; i += 1) {
    specs.push(tap("pointerdown", i * 100, 300, 300, 0, 5, 0));
    specs.push(tap("pointerup", i * 100, 300, 300, 0, 5, 0));
  }
  return specs;
}

/** Dedo sostenido sin movimiento (dispositivo inmóvil, sin temblor). */
function staticHold(): TouchEventSpec[] {
  return [
    tap("pointerdown", 0, 100, 100, 0.5, 5, 10),
    tap("pointermove", 10, 100, 100, 0.5, 5, 10),
    tap("pointermove", 20, 100, 100, 0.5, 5, 10),
    tap("pointermove", 30, 100, 100, 0.5, 5, 10),
    tap("pointermove", 40, 100, 100, 0.5, 5, 10),
    tap("pointerup", 50, 100, 100, 0.5, 5, 10),
  ];
}

/** Dedo que se desliza en línea recta perfecta (sin temblor perpendicular). */
function robotStraightSlide(): TouchEventSpec[] {
  return [
    tap("pointerdown", 0, 0, 0, 0.5, 5, 0),
    tap("pointermove", 16, 10, 0, 0.5, 5, 0),
    tap("pointermove", 32, 20, 0, 0.5, 5, 0),
    tap("pointermove", 48, 30, 0, 0.5, 5, 0),
    tap("pointermove", 64, 40, 0, 0.5, 5, 0),
    tap("pointerup", 80, 40, 0, 0.5, 5, 0),
  ];
}

/** Toques reales de un dispositivo que NO informa rotationAngle (siempre 0). */
function tapsWithoutTiltSensor(): TouchEventSpec[] {
  const specs: TouchEventSpec[] = [];
  for (let i = 0; i < 3; i += 1) {
    const start = i * 400;
    specs.push(tap("pointerdown", start, 50, 50, 0.2, 4, 0));
    specs.push(tap("pointermove", start + 40, 51, 50, 0.5, 6, 0));
    specs.push(tap("pointerup", start + 90, 51, 50, 0.2, 4, 0));
  }
  return specs;
}

/** Swipe humano: arranque rápido y desaceleración natural antes de soltar. */
function humanSwipe(): TouchEventSpec[] {
  const xs = [40, 80, 115, 145, 170, 190, 205, 210];
  const ts = [8000, 8016, 8032, 8048, 8064, 8080, 8096, 8120];
  return xs.map((x, i) =>
    tap(
      i === 0 ? "pointerdown" : i === xs.length - 1 ? "pointerup" : "pointermove",
      ts[i],
      x,
      600,
      0.4,
      5,
      0,
    ),
  );
}

/** Swipe robótico: velocidad constante hasta el corte. */
function robotSwipe(): TouchEventSpec[] {
  const xs = [40, 72, 104, 136, 168, 200, 232, 264];
  const ts = [8000, 8016, 8032, 8048, 8064, 8080, 8096, 8112];
  return xs.map((x, i) =>
    tap(
      i === 0 ? "pointerdown" : i === xs.length - 1 ? "pointerup" : "pointermove",
      ts[i],
      x,
      600,
      0.5,
      5,
      0,
    ),
  );
}

/** Pellizco de dos dedos: eventos interleaved SIN pointerId (privacidad). */
function twoFingerPinch(): TouchEventSpec[] {
  const xy: Array<[number, number]> = [
    [140, 400],
    [260, 400],
    [120, 400],
    [280, 400],
    [100, 400],
    [300, 400],
    [80, 400],
    [320, 400],
    [60, 400],
    [340, 400],
  ];
  const ts = [3000, 3012, 3028, 3040, 3056, 3068, 3084, 3096, 3112, 3124];
  const specs = xy.map(([x, y], i) =>
    tap(i === 0 ? "pointerdown" : "pointermove", ts[i], x, y, 0.5, 6, 0),
  );
  specs.push(tap("pointerup", 3150, 60, 400, 0.3, 5, 0));
  specs.push(tap("pointerup", 3155, 340, 400, 0.3, 5, 0));
  return specs;
}

// ---------------------------------------------------------------------------
// Escenarios de atención realistas (todos alimentados por createAttentionCollector)
// ---------------------------------------------------------------------------

/** Sesión humana: cambia de pestaña, lee segundos, se fatiga, hace pausas. */
function humanBrowsing(): AttentionEventSpec[] {
  const specs: AttentionEventSpec[] = [];
  const readings = [900, 1100, 2000, 4000, 5000, 6000];
  const away = [0, 12000, 500, 20000, 2000, 15000];
  let cursor = 0;
  for (let i = 0; i < 6; i += 1) {
    const hiddenAt = cursor;
    const visibleAt = hiddenAt + 3000;
    const focusAt = visibleAt + 12;
    const actionAt = focusAt + readings[i];
    const idleAt = actionAt + 1500;
    const resumeAt = idleAt + 1500;
    const blurAt = resumeAt + 500;
    specs.push({ type: "visibilitychange", t: hiddenAt, hidden: true });
    specs.push({ type: "visibilitychange", t: visibleAt, hidden: false });
    specs.push({ type: "focus", t: focusAt });
    specs.push({ type: "active", t: actionAt });
    specs.push({ type: "idle", t: idleAt });
    specs.push({ type: "active", t: resumeAt });
    specs.push({ type: "blur", t: blurAt });
    if (i % 2 === 0) specs.push({ type: "resize", t: blurAt + 80 });
    cursor = blurAt + 6000 + away[i];
  }
  return specs.sort((a, b) => a.t - b.t);
}

/** Sesión robótica: ciclos perfectamente regulares, reacción de 8 ms, sin pausas. */
function robotBrowsing(): AttentionEventSpec[] {
  const specs: AttentionEventSpec[] = [];
  for (let i = 0; i < 6; i += 1) {
    const base = i * 200;
    specs.push({ type: "visibilitychange", t: base, hidden: true });
    specs.push({ type: "visibilitychange", t: base + 100, hidden: false });
    specs.push({ type: "active", t: base + 108 });
    specs.push({ type: "focus", t: base + 109 });
    specs.push({ type: "blur", t: base + 110 });
    specs.push({ type: "resize", t: base + 115 });
  }
  return specs;
}

function neverAway(): AttentionEventSpec[] {
  return [
    { type: "visibilitychange", t: 0, hidden: false },
    { type: "focus", t: 50 },
    { type: "active", t: 100 },
    { type: "active", t: 200 },
  ];
}

// ---------------------------------------------------------------------------
// L114-L123: medidas táctiles con escenarios reales
// ---------------------------------------------------------------------------

describe("checklist táctil L114-L123 (eventos reales vía createTouchCollector)", () => {
  it("L114 presión del dedo: rampa humana vs. presión constante de robot", () => {
    const human = touch.touchPressure(playTouch(humanTaps()).samples);
    const robot = touch.touchPressure(playTouch(robotTaps()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L115 área tocada: área que crece vs. radio constante de robot", () => {
    const human = touch.touchContactArea(playTouch(humanTaps()).samples);
    const robot = touch.touchContactArea(playTouch(robotTaps()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L116 inclinación: giro variable vs. fijo; sensor ausente => neutro", () => {
    const human = touch.touchTilt(playTouch(humanTaps()).samples);
    const robot = touch.touchTilt(playTouch(robotTaps()).samples);
    const noSensor = touch.touchTilt(playTouch(tapsWithoutTiltSensor()).samples);
    expectUnit(human);
    expectUnit(robot);
    expectUnit(noSensor);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
    expect(noSensor).toBe(0);
  });

  it("L117 duración del toque: toques + pulsación larga vs. duraciones fijas", () => {
    const human = touch.touchDuration(playTouch([...humanTaps(), ...humanLongPress()]).samples);
    const robot = touch.touchDuration(playTouch(robotTaps()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L118 deslizamiento con inercia: deceleración vs. velocidad constante", () => {
    const human = touch.touchInertialSlide(playTouch(humanSwipe()).samples);
    const robot = touch.touchInertialSlide(playTouch(robotSwipe()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L119 toques con varios dedos: pinza real vs. dedo único robótico", () => {
    const human = touch.touchMultiTouch(playTouch(twoFingerPinch()).samples);
    const robot = touch.touchMultiTouch(playTouch(robotSwipe()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L120 pellizcar/zoom: separación que crece vs. recorrido plano", () => {
    const human = touch.touchPinchZoom(playTouch(twoFingerPinch()).samples);
    const robot = touch.touchPinchZoom(playTouch(robotSwipe()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L121 toque vs. click falso: toque real vs. tap sintético de 0 ms", () => {
    const human = touch.touchVsClickFalse(playTouch(humanTaps()).samples);
    const fake = touch.touchVsClickFalse(playTouch(fakeMouseClickTaps()).samples);
    expectUnit(human);
    expectUnit(fake);
    expect(human).toBeLessThan(0.3);
    expect(fake).toBeGreaterThan(0.7);
  });

  it("L122 movimiento del dispositivo (proxy): micro-jitter vs. inmovilidad", () => {
    const human = touch.touchDeviceMotion(playTouch(humanTaps()).samples);
    const robot = touch.touchDeviceMotion(playTouch(staticHold()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L123 temblor natural al sostener el móvil: temblor vs. línea perfecta", () => {
    const human = touch.touchHandTremor(playTouch(humanTaps()).samples);
    const robot = touch.touchHandTremor(playTouch(robotStraightSlide()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// L125-L135: medidas de atención con sesión de navegación real
// ---------------------------------------------------------------------------

describe("checklist de atención L125-L135 (eventos reales vía createAttentionCollector)", () => {
  it("L125 cambios de pestaña: 6 ocultar->mostrar vs. ninguno", () => {
    const many = attention.attentionTabSwitches(playAttention(humanBrowsing()).samples);
    const none = attention.attentionTabSwitches(playAttention(neverAway()).samples);
    expectUnit(many);
    expectUnit(none);
    expect(many).toBe(1);
    expect(none).toBe(0);
  });

  it("L126 ventana en segundo plano: mitad del tiempo oculta vs. siempre visible", () => {
    const human = attention.attentionBackground(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionBackground(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(robot).toBeGreaterThan(human);
    expect(human).toBeLessThan(0.5);
  });

  it("L127 foco en la página: 6 pérdidas vs. ninguna", () => {
    const many = attention.attentionFocusLoss(playAttention(humanBrowsing()).samples);
    const none = attention.attentionFocusLoss(playAttention(neverAway()).samples);
    expectUnit(many);
    expectUnit(none);
    expect(many).toBe(1);
    expect(none).toBe(0);
  });

  it("L128 tiempo activo vs. inactivo: pausas idle humanas vs. robot siempre activo", () => {
    const human = attention.attentionActiveInactive(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionActiveInactive(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L129 retorno del cursor: blur->focus variables vs. regulares", () => {
    const human = attention.attentionCursorReturn(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionCursorReturn(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L130 cambio de tamaño de ventana: 3 resizes vs. ninguno", () => {
    const many = attention.attentionResize(playAttention(humanBrowsing()).samples);
    const none = attention.attentionResize(playAttention(neverAway()).samples);
    expectUnit(many);
    expectUnit(none);
    expect(many).toBe(1);
    expect(none).toBe(0);
  });

  it("L131 tiempo de lectura: lee segundos antes de actuar vs. actúa en 8 ms", () => {
    const human = attention.attentionReadingTime(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionReadingTime(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L132 tiempo de reacción: segundos leyendo vs. 8 ms tras hacerse visible", () => {
    const human = attention.attentionReactionTime(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionReactionTime(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L133 variación del tiempo de reacción: irregular vs. constante", () => {
    const human = attention.attentionReactionVariation(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionReactionVariation(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L134 curva de cansancio: reacciones cada vez más lentas vs. planas", () => {
    const human = attention.attentionFatigue(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionFatigue(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });

  it("L135 pausas largas naturales: pausas de segundos vs. ritmo continuo", () => {
    const human = attention.attentionLongPauses(playAttention(humanBrowsing()).samples);
    const robot = attention.attentionLongPauses(playAttention(robotBrowsing()).samples);
    expectUnit(human);
    expectUnit(robot);
    expect(human).toBeLessThan(0.3);
    expect(robot).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// Limpieza de listeners y ausencia de fugas en ciclos start/stop
// ---------------------------------------------------------------------------

describe("limpieza de listeners tras attach/detach repetidos", () => {
  it("el colector táctil no deja listeners ni sigue grabando tras detach", () => {
    const instrumented = instrumentedTarget();
    const collector = createTouchCollector({ target: instrumented.target });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      collector.attach();
      expect(instrumented.liveCount()).toBe(3);
      instrumented.target.dispatchEvent(
        synthetic("pointerdown", {
          pointerType: "touch",
          clientX: 10,
          clientY: 10,
          timeStamp: cycle * 100,
          pressure: 0.5,
          radiusX: 5,
          radiusY: 5,
          rotationAngle: 0,
          isTrusted: false,
        }),
      );
      collector.detach();
      expect(instrumented.liveCount()).toBe(0);
      const before = collector.getSamples().length;
      instrumented.target.dispatchEvent(
        synthetic("pointerdown", {
          pointerType: "touch",
          timeStamp: cycle * 100 + 50,
          clientX: 20,
          clientY: 20,
        }),
      );
      expect(collector.getSamples().length).toBe(before);
    }
    expect(instrumented.added.length).toBe(9);
    expect(instrumented.removed.length).toBe(9);
  });

  it("el colector de atención cancela idle y no deja listeners tras detach", () => {
    const instrumented = instrumentedTarget();
    Object.defineProperty(instrumented.target, "document", {
      value: { hidden: false, visibilityState: "visible" },
      configurable: true,
    });
    const collector = createAttentionCollector({ target: instrumented.target });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      collector.attach();
      expect(instrumented.liveCount()).toBe(9);
      instrumented.target.dispatchEvent(synthetic("focus", { timeStamp: cycle * 100 }));
      collector.detach();
      expect(instrumented.liveCount()).toBe(0);
      const before = collector.getSamples().length;
      instrumented.target.dispatchEvent(synthetic("blur", { timeStamp: cycle * 100 + 50 }));
      expect(collector.getSamples().length).toBe(before);
    }
    expect(instrumented.added.length).toBe(27);
    expect(instrumented.removed.length).toBe(27);
  });
});
