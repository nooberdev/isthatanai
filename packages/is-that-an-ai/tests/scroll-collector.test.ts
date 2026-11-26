import { describe, expect, it } from "bun:test";
import { createScrollCollector, LINES_TO_PX, PAGES_TO_PX } from "../src/index";

function wheel(deltaX: number, deltaY: number, t: number, deltaMode = 0): Event {
  const event = new Event("wheel");
  for (const [key, value] of Object.entries({
    deltaX,
    deltaY,
    deltaMode,
    timeStamp: t,
  })) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

function documentScroll(t: number): Event {
  const event = new Event("scroll");
  Object.defineProperty(event, "timeStamp", { value: t, configurable: true });
  return event;
}

describe("createScrollCollector", () => {
  it("normaliza deltaMode a píxeles sin leer layout", () => {
    const target = new EventTarget();
    const collector = createScrollCollector({ target });
    collector.attach();
    target.dispatchEvent(wheel(0, 100, 100, 0));
    target.dispatchEvent(wheel(3, 4, 200, 1));
    target.dispatchEvent(wheel(-1, -2, 300, 2));

    const samples = collector.getSamples();
    expect(samples.map((sample) => sample.seq)).toEqual([1, 2, 3]);
    expect(samples[0].dy).toBe(100);
    expect(samples[1].dx).toBe(3 * LINES_TO_PX);
    expect(samples[1].dy).toBe(4 * LINES_TO_PX);
    expect(samples[2].dx).toBe(-PAGES_TO_PX);
    expect(samples[2].dy).toBe(-2 * PAGES_TO_PX);
    expect(samples.map((sample) => sample.t)).toEqual([100, 200, 300]);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
    expect(samples.every((sample) => sample.source === 0)).toBe(true);
    expect(collector.lastEventAt).toBe(300);
  });

  it("registra scroll real del documento (source=1) sin wheel", () => {
    const target = new EventTarget() as EventTarget & { scrollX: number; scrollY: number };
    target.scrollX = 0;
    target.scrollY = 0;
    const collector = createScrollCollector({ target });
    collector.attach();

    target.dispatchEvent(documentScroll(100)); // primera muestra: sin estado previo
    target.scrollY = 240; // p. ej. window.scrollTo() o autoscroll del botón medio
    target.dispatchEvent(documentScroll(160));
    target.scrollX = 12.5;
    target.scrollY = 200;
    target.dispatchEvent(documentScroll(220));

    const samples = collector.getSamples();
    expect(samples.map((sample) => sample.source)).toEqual([1, 1, 1]);
    expect(samples.map((sample) => sample.dx)).toEqual([0, 0, 12.5]);
    expect(samples.map((sample) => sample.dy)).toEqual([0, 240, -40]);
    expect(samples.map((sample) => sample.t)).toEqual([100, 160, 220]);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
  });

  it("listener pasivo, attach/detach idempotentes", () => {
    const target = new EventTarget();
    const recorded: Array<{ type: string; options?: AddEventListenerOptions }> = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      recorded.push({ type, options });
      return add(type, listener, options);
    }) as typeof target.addEventListener;
    let removed = 0;
    target.removeEventListener = ((...args: Parameters<EventTarget["removeEventListener"]>) => {
      removed += 1;
      return remove(...args);
    }) as typeof target.removeEventListener;

    const collector = createScrollCollector({ target });
    collector.attach();
    collector.attach();
    expect(recorded).toEqual([
      { type: "wheel", options: { passive: true } },
      { type: "scroll", options: { capture: true, passive: true } },
    ]);
    collector.detach();
    collector.detach();
    expect(removed).toBe(2);
    target.dispatchEvent(wheel(0, 100, 10));
    expect(collector.getSamples()).toEqual([]);
  });

  it("buffer circular por defecto de 1024 y clear", () => {
    const target = new EventTarget();
    const collector = createScrollCollector({ target });
    expect(collector.buffer.capacity).toBe(1024);
    collector.attach();
    for (let i = 1; i <= 1030; i += 1) target.dispatchEvent(wheel(0, i, i * 10));
    expect(collector.buffer.size).toBe(1024);
    expect(collector.buffer.droppedCount).toBe(6);
    expect(collector.getSamples()[0].seq).toBe(7);
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
  });
});
