import { describe, expect, it } from "bun:test";
import {
  createKeyboardCollector,
  createTextInputCollector,
  inputTypeCodeOf,
  keyCategoryOf,
} from "../src/index";

function fakeEvent(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, name);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, name, { value, configurable: true });
  }
  return event;
}

function passwordInput(): Record<string, unknown> {
  return { tagName: "INPUT", type: "password", value: "no-debe-guardarse" };
}

describe("createKeyboardCollector", () => {
  it("categoriza teclas SIN guardar key/code/texto", () => {
    expect(keyCategoryOf({ code: "KeyA", key: "a" })).toBe(0);
    expect(keyCategoryOf({ code: "Digit7", key: "7" })).toBe(1);
    expect(keyCategoryOf({ code: "Space", key: " " })).toBe(2);
    expect(keyCategoryOf({ code: "Backspace" })).toBe(3);
    expect(keyCategoryOf({ code: "Enter" })).toBe(4);
    expect(keyCategoryOf({ code: "ArrowLeft" })).toBe(5);
    expect(keyCategoryOf({ code: "ControlLeft" })).toBe(6);
    expect(keyCategoryOf({ code: "F5" })).toBe(7);

    const target = new EventTarget();
    const collector = createKeyboardCollector({ target, now: () => 0 });
    collector.attach();
    for (const [type, code, key, t] of [
      ["keydown", "KeyA", "a", 10],
      ["keyup", "KeyA", "a", 45],
      ["keydown", "Enter", "Enter", 100],
      ["keyup", "Enter", "Enter", 130],
    ] as const) {
      target.dispatchEvent(fakeEvent(type, { code, key, timeStamp: t, isTrusted: false }));
    }
    const samples = collector.getSamples();
    expect(samples).toHaveLength(4);
    expect(samples.map((sample) => sample.seq)).toEqual([1, 2, 3, 4]);
    expect(samples.map((sample) => sample.kind)).toEqual([0, 1, 0, 1]);
    expect(samples.map((sample) => sample.category)).toEqual([0, 0, 4, 4]);
    expect(samples.every((sample) => sample.trusted === 0)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("KeyA");
    expect(JSON.stringify(samples)).not.toContain("Enter");
    collector.detach();
  });

  it("attach/detach son idempotentes", () => {
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

    const collector = createKeyboardCollector({ target });
    collector.attach();
    collector.attach();
    expect(added).toBe(2);
    collector.detach();
    collector.detach();
    expect(removed).toBe(2);
    target.dispatchEvent(fakeEvent("keydown", { code: "KeyA", timeStamp: 10 }));
    expect(collector.getSamples()).toEqual([]);
  });

  it("ignora eventos de campos de contraseña sin leer su valor", () => {
    const target = new EventTarget();
    const collector = createKeyboardCollector({ target });
    collector.attach();
    target.dispatchEvent(
      fakeEvent("keydown", {
        code: "KeyA",
        key: "a",
        timeStamp: 10,
        target: passwordInput(),
      }),
    );
    target.dispatchEvent(fakeEvent("keydown", { code: "KeyB", key: "b", timeStamp: 20 }));
    expect(collector.getSamples()).toHaveLength(1);
    expect(JSON.stringify(collector.getSamples())).not.toContain("no-debe-guardarse");
    collector.detach();
  });

  it("descarta muestras antiguas y clear limpia el buffer", () => {
    const target = new EventTarget();
    const collector = createKeyboardCollector({ target });
    collector.attach();
    target.dispatchEvent(fakeEvent("keydown", { code: "KeyA", timeStamp: 100 }));
    target.dispatchEvent(fakeEvent("keydown", { code: "KeyB", timeStamp: 500 }));
    expect(collector.discardOldestBefore(200)).toBe(1);
    expect(collector.getSamples().map((sample) => sample.seq)).toEqual([2]);
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
    expect(collector.lastEventAt).toBe(0);
    collector.detach();
  });
});

describe("createTextInputCollector", () => {
  it("mapea inputType a códigos numéricos", () => {
    expect(inputTypeCodeOf({ inputType: "insertText" })).toBe(0);
    expect(inputTypeCodeOf({ inputType: "insertFromPaste" })).toBe(1);
    expect(inputTypeCodeOf({ inputType: "insertFromDrop" })).toBe(2);
    expect(inputTypeCodeOf({ inputType: "insertReplacementText" })).toBe(3);
    expect(inputTypeCodeOf({ inputType: "insertCompositionText" })).toBe(3);
    expect(inputTypeCodeOf({ isComposing: true })).toBe(3);
    expect(inputTypeCodeOf({ inputType: "deleteContentBackward" })).toBe(4);
    expect(inputTypeCodeOf({ inputType: "deleteContentForward" })).toBe(5);
  });

  it("usa beforeinput y no cuenta dos veces el input posterior", () => {
    const target = new EventTarget();
    const collector = createTextInputCollector({ target, now: () => 0 });
    collector.attach();
    target.dispatchEvent(
      fakeEvent("beforeinput", { inputType: "insertText", data: "hola", timeStamp: 10 }),
    );
    target.dispatchEvent(
      fakeEvent("input", { inputType: "insertText", data: "hola", timeStamp: 10 }),
    );
    const samples = collector.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual({ seq: 1, t: 10, kind: 0, inputType: 0, trusted: 0 });
    expect(collector.usesBeforeInput).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("hola");
    collector.detach();
  });

  it("cae a input cuando no hay beforeinput", () => {
    const target = new EventTarget();
    const collector = createTextInputCollector({ target });
    collector.attach();
    target.dispatchEvent(
      fakeEvent("input", { inputType: "insertFromPaste", timeStamp: 20, isTrusted: true }),
    );
    expect(collector.getSamples()).toHaveLength(1);
    expect(collector.getSamples()[0].inputType).toBe(1);
    // Bun no permite redefinir isTrusted en eventos sintéticos: queda en false.
    expect(collector.getSamples()[0].trusted).toBe(0);
    expect(collector.usesBeforeInput).toBe(false);
    collector.detach();
  });

  it("ignora campos de contraseña y no lee clipboardData", () => {
    const target = new EventTarget();
    const collector = createTextInputCollector({ target });
    collector.attach();
    const secret = { getData: () => "secreto" };
    target.dispatchEvent(
      fakeEvent("beforeinput", {
        inputType: "insertFromPaste",
        clipboardData: secret,
        data: "secreto",
        timeStamp: 10,
        target: passwordInput(),
      }),
    );
    target.dispatchEvent(
      fakeEvent("beforeinput", {
        inputType: "insertFromPaste",
        clipboardData: secret,
        timeStamp: 20,
      }),
    );
    expect(collector.getSamples()).toHaveLength(1);
    expect(JSON.stringify(collector.getSamples())).not.toContain("secreto");
    collector.detach();
  });

  it("attach/detach idempotentes y clear", () => {
    const target = new EventTarget();
    let added = 0;
    const originalAdd = target.addEventListener.bind(target);
    target.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
      added += 1;
      return originalAdd(...args);
    }) as typeof target.addEventListener;
    const collector = createTextInputCollector({ target });
    collector.attach();
    collector.attach();
    expect(added).toBe(2);
    target.dispatchEvent(fakeEvent("input", { inputType: "insertText", timeStamp: 5 }));
    collector.clear();
    expect(collector.getSamples()).toEqual([]);
    expect(collector.usesBeforeInput).toBe(false);
    collector.detach();
  });
});
