import { describe, expect, it } from "bun:test";
import { type ClickSample, createClickCollector } from "../src/index";

function synthetic(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    // Los eventos sintéticos de Bun ya tienen isTrusted === false.
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

function down(x: number, y: number, t: number, button = 0): Event {
  return synthetic("pointerdown", {
    clientX: x,
    clientY: y,
    timeStamp: t,
    button,
    isTrusted: false,
  });
}

function up(x: number, y: number, t: number, button = 0): Event {
  return synthetic("pointerup", { clientX: x, clientY: y, timeStamp: t, button, isTrusted: false });
}

describe("createClickCollector", () => {
  it("registra down/up sintéticos con decimales, button y trusted=0", () => {
    const target = new EventTarget();
    const collector = createClickCollector({ target });
    collector.attach();
    target.dispatchEvent(down(10.5, 20.25, 100));
    target.dispatchEvent(up(10.5, 20.25, 160));
    target.dispatchEvent(down(30.75, 40.5, 300, 2));
    target.dispatchEvent(up(31.25, 40.5, 365, 2));

    const samples = collector.getSamples();
    expect(samples.map((sample) => sample.kind)).toEqual([0, 1, 0, 1]);
    expect(samples.map((sample) => sample.seq)).toEqual([1, 2, 3, 4]);
    expect(samples.map((sample) => sample.button)).toEqual([0, 0, 2, 2]);
    expect(samples.map((sample) => sample.t)).toEqual([100, 160, 300, 365]);
    expect(samples[0].x).toBe(10.5);
    expect(samples[0].y).toBe(20.25);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
    expect(collector.lastEventAt).toBe(365);
    expect(collector.eventsSince(0)).toBe(4);
  });

  it("attach y detach son idempotentes y los listeners son pasivos", () => {
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

    const collector = createClickCollector({ target });
    collector.attach();
    collector.attach();
    expect(recorded).toEqual([
      { type: "pointerdown", options: { passive: true } },
      { type: "pointerup", options: { passive: true } },
    ]);

    collector.detach();
    collector.detach();
    expect(removed).toBe(2);
    target.dispatchEvent(down(1, 2, 10));
    expect(collector.getSamples()).toEqual([]);
  });

  it("buffer circular: capacity, descartes, orden y clear", () => {
    const target = new EventTarget();
    const collector = createClickCollector({ target, bufferSize: 3 });
    collector.attach();
    for (let i = 1; i <= 5; i += 1) {
      target.dispatchEvent(down(i, i, i * 10));
    }
    const samples: ClickSample[] = collector.getSamples();
    expect(samples.map((sample) => sample.seq)).toEqual([3, 4, 5]);
    expect(collector.buffer.droppedCount).toBe(2);
    expect(collector.discardOldestBefore(45)).toBe(2);
    expect(collector.getSamples().map((sample) => sample.seq)).toEqual([5]);
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
    expect(collector.lastEventAt).toBe(0);
  });
});
