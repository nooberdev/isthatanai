import { describe, expect, it } from "bun:test";
import { createMouseCollector } from "../src/collectors/mouse";

/** Event sintético con propiedades definidas incluso si son getters de solo lectura. */
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

describe("createMouseCollector", () => {
  it("registra move + coalesced + enter/leave y marca los sintéticos como no confiables", () => {
    const target = new EventTarget();
    const collector = createMouseCollector({ target });
    collector.attach();

    target.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 10.5,
        clientY: 20.25,
        timeStamp: 100,
        pointerType: "mouse",
        isTrusted: false,
        getCoalescedEvents: () => [
          { clientX: 1.5, clientY: 2.5, timeStamp: 80 },
          { clientX: 5.5, clientY: 7.5, timeStamp: 90 },
        ],
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointerenter", {
        clientX: 0,
        clientY: 0,
        timeStamp: 110,
        pointerType: "pen",
        isTrusted: false,
      }),
    );
    target.dispatchEvent(
      pointerEvent("pointerleave", {
        clientX: 0,
        clientY: 0,
        timeStamp: 120,
        pointerType: "touch",
        isTrusted: false,
      }),
    );

    const samples = collector.getSamples();
    expect(samples.map((sample) => sample.kind)).toEqual([0, 0, 0, 1, 2]);
    expect(samples.map((sample) => sample.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(samples.map((sample) => sample.x)).toEqual([1.5, 5.5, 10.5, 0, 0]);
    expect(samples.map((sample) => sample.t)).toEqual([80, 90, 100, 110, 120]);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
    expect(samples[3].pointerType).toBe(1);
    expect(samples[4].pointerType).toBe(2);
    expect(collector.lastEventAt).toBe(120);
    // Tres eventos de puntero, cinco muestras.
    expect(collector.eventsSince(0)).toBe(3);

    collector.detach();
    target.dispatchEvent(pointerEvent("pointermove", { clientX: 99, timeStamp: 200 }));
    expect(collector.getSamples()).toHaveLength(5);
  });

  it("usa document como frontera cuando el target lo expone", () => {
    const target = new EventTarget();
    const boundary = new EventTarget();
    Object.defineProperty(target, "document", { value: boundary });
    const collector = createMouseCollector({ target });
    collector.attach();

    boundary.dispatchEvent(pointerEvent("pointerenter", { timeStamp: 10 }));
    target.dispatchEvent(pointerEvent("pointermove", { timeStamp: 11 }));

    const samples = collector.getSamples();
    expect(samples.map((sample) => sample.kind)).toEqual([1, 0]);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
    expect(samples[0].pointerType).toBe(3);
  });

  it("attach y detach son idempotentes", () => {
    const target = new EventTarget();
    let added = 0;
    let removed = 0;
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
      added += 1;
      return add(...args);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((...args: Parameters<EventTarget["removeEventListener"]>) => {
      removed += 1;
      return remove(...args);
    }) as typeof target.removeEventListener;

    const collector = createMouseCollector({ target });
    collector.attach();
    collector.attach();
    expect(added).toBe(3);

    collector.detach();
    collector.detach();
    expect(removed).toBe(3);
  });

  it("enter/leave sin capture: un evento en un hijo no genera kind 1 en el boundary", () => {
    interface RecordedListener {
      type: string;
      listener: EventListener;
      options?: AddEventListenerOptions;
    }

    // Árbol falso minimalista: simula la fase de captura (ancestros root ->
    // padre) y la fase de objetivo. pointerenter no burbujea, así que un
    // listener con capture: true en el document sí vería los hijos.
    class FakeNode {
      parent: FakeNode | null = null;
      document?: FakeNode;
      readonly listeners: RecordedListener[] = [];

      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ): void {
        this.listeners.push({ type, listener: listener as EventListener, options });
      }

      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ): void {
        const index = this.listeners.findIndex(
          (entry) =>
            entry.type === type && entry.listener === listener && entry.options === options,
        );
        if (index !== -1) this.listeners.splice(index, 1);
      }

      dispatchEvent(event: Event): boolean {
        const chain: FakeNode[] = [];
        for (let node: FakeNode | null = this; node; node = node.parent) chain.unshift(node);
        for (const node of chain.slice(0, -1)) {
          for (const entry of node.listeners) {
            if (entry.type === event.type && entry.options?.capture === true) {
              entry.listener.call(node, event);
            }
          }
        }
        for (const entry of this.listeners) {
          if (entry.type === event.type) entry.listener.call(this, event);
        }
        return true;
      }
    }

    const boundary = new FakeNode();
    const target = new FakeNode();
    const child = new FakeNode();
    target.parent = boundary;
    target.document = boundary;
    child.parent = target;

    const collector = createMouseCollector({ target: target as unknown as EventTarget });
    collector.attach();

    const move = target.listeners.find((entry) => entry.type === "pointermove");
    const enter = boundary.listeners.find((entry) => entry.type === "pointerenter");
    const leave = boundary.listeners.find((entry) => entry.type === "pointerleave");
    expect(move?.options).toEqual({ capture: true, passive: true });
    expect(enter?.options).toEqual({ passive: true });
    expect(leave?.options).toEqual({ passive: true });
    expect(enter?.options?.capture).not.toBe(true);
    expect(leave?.options?.capture).not.toBe(true);

    child.dispatchEvent(pointerEvent("pointerenter", { timeStamp: 5 }));
    child.dispatchEvent(pointerEvent("pointerleave", { timeStamp: 6 }));
    expect(collector.getSamples()).toEqual([]);

    boundary.dispatchEvent(pointerEvent("pointerenter", { timeStamp: 7 }));
    expect(collector.getSamples().map((sample) => sample.kind)).toEqual([1]);

    collector.detach();
    expect(boundary.listeners).toHaveLength(0);
    expect(target.listeners).toHaveLength(0);
  });
});
