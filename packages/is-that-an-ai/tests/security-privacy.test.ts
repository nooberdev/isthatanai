import { describe, expect, it } from "bun:test";
import {
  createClickCollector,
  createKeyboardCollector,
  createMouseCollector,
  createScrollCollector,
  createTextInputCollector,
  declaredVsBehavior,
  evaluateCoherence,
  humanizationRisk,
  injectionRisk,
  PRIVACY_NOTICE,
  privacyAudit,
} from "../src/index";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";
import { isSensitiveTarget } from "../src/utils/privacy";

// Red-team defensivo de colectores y guardarrails. Ningún test crea contenido
// real: todos los "secretos" son cadenas marcadoras inventadas para comprobar
// que NUNCA aparecen en una muestra ni en JSON.stringify.
//
// Hallazgos (input -> síntoma -> arreglo -> test):
// F1  target con getters que lanzan -> isSensitiveTarget lanzaba -> try/catch
//     fail-closed (devuelve true) -> "F1".
// F2  eventos con getters hostiles -> el listener lanzaba -> lecturas
//     defensivas en los cinco colectores -> "F2".
// F3  getCoalescedEvents que lanza / devuelve null -> crash -> try/catch +
//     validación de items + tope -> "F3".
// F4  beforeinput de contraseña -> silenciaba `input` reales -> solo activar
//     usesBeforeInput si la mutación se guardó -> "F4".
// F5  isTrusted = 1 (forged) -> contaba como confiable -> solo `=== true` ->
//     "F5" (además la cadencia se detecta numéricamente).
// F6  ciclos de periodo 7/8 y pausas periódicas -> humanizationRisk = 0 ->
//     PERIOD_MAX = 8 -> "F6".
// F7  marcas Infinity/NaN -> guardarrails devolvían NaN -> filtrado de no
//     finitas + safe01 -> "F7".
// F8  arrays grandes -> búsqueda O(n²) (20k ~1.9s) -> lower bound O(n log n)
//     -> "F8".
// F9  attach parcialmente fallido -> listener huérfano -> rollback en attach
//     -> "F9".

const SECRET = "TOP-SECRET-DO-NOT-STORE-4f7b";

function secretEvent(props: Record<string, unknown>): Event {
  const event = new Event("synthetic");
  for (const [name, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, name);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, name, { value, configurable: true });
  }
  return event;
}

/** Objeto plano: permite forjar `isTrusted` (Bun no lo permite en Event). */
function plain(props: Record<string, unknown>): Event {
  return props as Event;
}

/** Proxy que lanza en CUALQUIER lectura no declarada (target hostil). */
function hostile(props: Record<string, unknown> = {}): Event {
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`hostile getter: ${String(key)}`);
    },
  }) as unknown as Event;
}

interface Capture {
  emit(type: string, event: unknown): void;
  /** Llama al handler AUNQUE el colector ya se haya desmontado. */
  emitStale(type: string, event: unknown): void;
  readonly added: Array<{ type: string; options?: AddEventListenerOptions }>;
  readonly removed: number;
  restore(): void;
}

/** Intercepta add/removeEventListener para inyectar eventos planos hostiles. */
function capture(target: EventTarget): Capture {
  const live = new Map<string, (event: Event) => void>();
  const ever = new Map<string, (event: Event) => void>();
  const added: Array<{ type: string; options?: AddEventListenerOptions }> = [];
  let removed = 0;
  const originalAdd = target.addEventListener;
  const originalRemove = target.removeEventListener;
  target.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ) => {
    added.push({ type, options });
    const handler = listener as (event: Event) => void;
    live.set(type, handler);
    ever.set(type, handler);
    return originalAdd.call(target, type, listener, options);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ) => {
    removed += 1;
    live.delete(type);
    return originalRemove.call(target, type, listener, options);
  }) as typeof target.removeEventListener;
  return {
    emit(type, event) {
      live.get(type)?.(event as Event);
    },
    emitStale(type, event) {
      ever.get(type)?.(event as Event);
    },
    added,
    get removed() {
      return removed;
    },
    restore() {
      target.addEventListener = originalAdd;
      target.removeEventListener = originalRemove;
    },
  };
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function allFiniteNumbers(sample: object): boolean {
  return Object.values(sample).every(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
}

function key(t: number, seq = 1, trusted: 0 | 1 = 1): KeySample {
  return { seq, t, kind: 0, category: 0, trusted };
}

function pointer(t: number, seq = 1): PointerSample {
  return { seq, x: t, y: 0, t, kind: 0, pointerType: 0, trusted: 1 };
}

function click(t: number, seq = 1): ClickSample {
  return { seq, x: 0, y: 0, t, kind: 0, button: 0, trusted: 1 };
}

function input(t: number, seq = 1): InputSample {
  return { seq, t, kind: 0, inputType: 0, trusted: 1 };
}

function scroll(t: number, seq = 1): ScrollSample {
  return { seq, dx: 0, dy: 10, t, trusted: 1, source: 0 };
}

function timesFrom(dts: number[], start = 1000): number[] {
  let t = start;
  return dts.map((dt) => {
    t += dt;
    return t;
  });
}

describe("F1: isSensitiveTarget con targets nulos/hostiles", () => {
  it("no lanza con target ausente, getters que lanzan o Proxy hostil; falla cerrado", () => {
    expect(isSensitiveTarget({} as Event)).toBe(false);
    expect(isSensitiveTarget({ target: null } as unknown as Event)).toBe(false);
    expect(
      isSensitiveTarget({
        target: { tagName: "INPUT", type: "text", value: SECRET },
      } as unknown as Event),
    ).toBe(false);
    expect(
      isSensitiveTarget({
        target: { tagName: "INPUT", type: "PASSWORD" },
      } as unknown as Event),
    ).toBe(true);
    expect(
      isSensitiveTarget({
        target: { tagName: "TEXTAREA", getAttribute: () => "password" },
      } as unknown as Event),
    ).toBe(true);

    const throwingTag = hostile({ tagName: undefined });
    Object.defineProperty(throwingTag, "tagName", {
      get() {
        throw new Error("boom tagName");
      },
    });
    const throwingType = {
      tagName: "INPUT",
      get type(): string {
        throw new Error("boom type");
      },
    };
    const throwingAttr = {
      tagName: "input",
      getAttribute(): string {
        throw new Error("boom getAttribute");
      },
    };
    const throwingTarget = {
      get target(): unknown {
        throw new Error("boom target");
      },
    };
    for (const event of [
      { target: throwingTag },
      { target: throwingType },
      { target: throwingAttr },
      throwingTarget,
    ]) {
      expect(() => isSensitiveTarget(event as unknown as Event)).not.toThrow();
      expect(isSensitiveTarget(event as unknown as Event)).toBe(true);
    }
  });
});

describe("F2/F3/F5: eventos malformados en TODOS los colectores", () => {
  it("mouse: timeStamp/clientX/clientY/pointerType bogus y getters hostiles no crashean", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createMouseCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit(
        "pointermove",
        secretEvent({ timeStamp: undefined, clientX: undefined, clientY: "x" }),
      );
      cap.emit("pointermove", secretEvent({ timeStamp: "100", clientX: NaN, clientY: Infinity }));
      cap.emit("pointermove", secretEvent({ timeStamp: -25, pointerType: "banana", button: 99 }));
      cap.emit("pointermove", hostile({ timeStamp: 7 }));
      cap.emit("pointerenter", hostile()); // target ausente
      cap.emit("pointerleave", plain({ timeStamp: 8, isTrusted: 1 }));
    }).not.toThrow();

    const samples = collector.getSamples();
    expect(samples.length).toBe(6);
    for (const sample of samples) {
      expect(allFiniteNumbers(sample)).toBe(true);
      expect(sample.pointerType === 0 || sample.pointerType === 3).toBe(true);
    }
    // Solo `true` es confiable: el isTrusted = 1 forjado cuenta como 0.
    expect(samples[5].trusted).toBe(0);
    expect(Number.isFinite(collector.lastEventAt)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain(SECRET);
    collector.detach();
    cap.restore();
  });

  it("click: botón/tiempo hostiles, sin target y trusted forjado", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createClickCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit("pointerdown", secretEvent({ timeStamp: NaN, button: "left", clientX: "3" }));
      cap.emit("pointerup", secretEvent({ timeStamp: Infinity, button: -7, clientY: undefined }));
      cap.emit("pointerdown", hostile());
      cap.emit("pointerdown", plain({ timeStamp: 12, isTrusted: "true" }));
      cap.emit("pointerdown", plain({ timeStamp: 13, isTrusted: true }));
    }).not.toThrow();
    const samples = collector.getSamples();
    expect(samples).toHaveLength(5);
    for (const sample of samples) expect(allFiniteNumbers(sample)).toBe(true);
    expect(samples[0].button).toBe(0);
    expect(samples[3].trusted).toBe(0);
    expect(samples[4].trusted).toBe(1);
    collector.detach();
    cap.restore();
  });

  it("keyboard: timeStamp/code/key/hostile target y trusted forjado", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createKeyboardCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit("keydown", secretEvent({ code: SECRET, key: SECRET, timeStamp: "x" }));
      cap.emit("keydown", secretEvent({ code: "KeyA", timeStamp: NaN }));
      cap.emit("keyup", hostile({ timeStamp: 20 }));
      cap.emit("keydown", hostile());
      cap.emit("keydown", plain({ code: "KeyZ", timeStamp: 30, isTrusted: 1 }));
      cap.emit("keydown", plain({ code: "KeyZ", timeStamp: 31, isTrusted: true }));
    }).not.toThrow();
    const samples = collector.getSamples();
    // Los dos eventos con target hostil Proxy se descartan (fail-closed).
    expect(samples).toHaveLength(4);
    for (const sample of samples) expect(allFiniteNumbers(sample)).toBe(true);
    expect(samples[2].trusted).toBe(0);
    expect(samples[3].trusted).toBe(1);
    collector.detach();
    cap.restore();
  });

  it("text input: inputType/clipboardData hostiles y trusted forjado", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createTextInputCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit(
        "beforeinput",
        secretEvent({ inputType: 42, data: SECRET, clipboardData: { getData: () => SECRET } }),
      );
      cap.emit("beforeinput", secretEvent({ inputType: SECRET, timeStamp: NaN }));
      cap.emit("input", hostile({ timeStamp: 20 }));
      cap.emit("beforeinput", plain({ inputType: "insertText", timeStamp: 30, isTrusted: 1 }));
      cap.emit("beforeinput", plain({ inputType: "insertText", timeStamp: 31, isTrusted: true }));
    }).not.toThrow();
    const samples = collector.getSamples();
    expect(samples).toHaveLength(4);
    for (const sample of samples) expect(allFiniteNumbers(sample)).toBe(true);
    expect(samples[2].trusted).toBe(0);
    expect(samples[3].trusted).toBe(1);
    expect(JSON.stringify(samples)).not.toContain(SECRET);
    collector.detach();
    cap.restore();
  });

  it("scroll: deltaMode/deltaX hostiles, scrollX que lanza y desbordamiento", () => {
    const target = new EventTarget() as EventTarget & { scrollX: number; scrollY: number };
    const cap = capture(target);
    const collector = createScrollCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit("wheel", secretEvent({ deltaX: "3", deltaY: NaN, deltaMode: Infinity }));
      cap.emit("wheel", secretEvent({ deltaX: 1e308, deltaY: -1e308, deltaMode: 2 }));
      cap.emit("wheel", hostile({ timeStamp: 15 }));
      Object.defineProperty(target, "scrollX", {
        configurable: true,
        get(): number {
          throw new Error("boom scrollX");
        },
      });
      cap.emit("scroll", secretEvent({ timeStamp: 25 }));
      delete (target as { scrollX?: number }).scrollX;
      cap.emit("scroll", hostile({ timeStamp: 35 }));
    }).not.toThrow();
    const samples = collector.getSamples();
    expect(samples).toHaveLength(5);
    for (const sample of samples) expect(allFiniteNumbers(sample)).toBe(true);
    collector.detach();
    cap.restore();
  });

  it("F3: getCoalescedEvents que lanza o devuelve entries nulas no pierde la muestra principal", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createMouseCollector({ target, now: () => 0 });
    collector.attach();
    expect(() => {
      cap.emit(
        "pointermove",
        hostile({
          clientX: 1,
          clientY: 2,
          timeStamp: 10,
          getCoalescedEvents(): unknown[] {
            throw new Error("boom coalesced");
          },
        }),
      );
      cap.emit(
        "pointermove",
        secretEvent({
          clientX: 3,
          clientY: 4,
          timeStamp: 20,
          getCoalescedEvents: () => [null, undefined, hostile({ clientX: 9, timeStamp: 21 })],
        }),
      );
      const huge = new Proxy([hostile({ timeStamp: 30 })], {
        get(target, key) {
          if (key === "length") throw new Error("boom length");
          return Reflect.get(target, key);
        },
      });
      cap.emit(
        "pointermove",
        secretEvent({ clientX: 5, timeStamp: 30, getCoalescedEvents: () => huge }),
      );
    }).not.toThrow();
    const samples = collector.getSamples();
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.every(allFiniteNumbers)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain(SECRET);
    collector.detach();
    cap.restore();
  });

  it("F4: un beforeinput de contraseña no silencia un input real posterior", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createTextInputCollector({ target, now: () => 0 });
    collector.attach();
    cap.emit(
      "beforeinput",
      secretEvent({
        inputType: "insertText",
        data: SECRET,
        timeStamp: 10,
        target: { tagName: "INPUT", type: "password", value: SECRET },
      }),
    );
    expect(collector.usesBeforeInput).toBe(false);
    cap.emit("input", secretEvent({ inputType: "insertText", data: SECRET, timeStamp: 20 }));
    expect(collector.getSamples()).toHaveLength(1);
    expect(JSON.stringify(collector.getSamples())).not.toContain(SECRET);
    collector.detach();
    cap.restore();
  });

  it("F9: attach/detach idempotentes, eventos stale ignorados y rollback si falla el registro", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createClickCollector({ target, now: () => 0 });
    collector.attach();
    collector.attach();
    expect(cap.added.map((entry) => entry.type)).toEqual(["pointerdown", "pointerup"]);
    expect(cap.added.every((entry) => entry.options?.passive === true)).toBe(true);
    cap.emit("pointerdown", secretEvent({ timeStamp: 10 }));
    collector.detach();
    collector.detach();
    expect(cap.removed).toBe(2);
    cap.emitStale("pointerdown", secretEvent({ timeStamp: 20 }));
    expect(collector.getSamples()).toHaveLength(1);
    cap.restore();

    // Registro parcial: el segundo addEventListener lanza; no debe quedar nada.
    const broken = new EventTarget();
    const registered = new Set<string>();
    const originalAdd = broken.addEventListener;
    const originalRemove = broken.removeEventListener;
    broken.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      if (registered.size > 0) throw new Error("boom add");
      registered.add(type);
      return originalAdd.call(broken, type, listener, options);
    }) as typeof broken.addEventListener;
    broken.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      registered.delete(type);
      return originalRemove.call(broken, type, listener, options);
    }) as typeof broken.removeEventListener;
    const partial = createClickCollector({ target: broken });
    expect(() => partial.attach()).not.toThrow();
    expect(registered.size).toBe(0);
    partial.detach();
    broken.addEventListener = originalAdd;
    broken.removeEventListener = originalRemove;
  });
});

describe("Privacidad: ninguna cadena, valor ni clipboard sale del colector", () => {
  it("todas las muestras publicadas son exclusivamente números finitos", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const mouse = createMouseCollector({ target, now: () => 0 });
    const click = createClickCollector({ target, now: () => 0 });
    const keyboard = createKeyboardCollector({ target, now: () => 0 });
    const text = createTextInputCollector({ target, now: () => 0 });
    const scroll = createScrollCollector({ target, now: () => 0 });
    mouse.attach();
    click.attach();
    keyboard.attach();
    text.attach();
    scroll.attach();

    const secretProps = {
      key: SECRET,
      code: SECRET,
      data: SECRET,
      inputType: SECRET,
      clipboardData: { getData: () => SECRET },
      target: { tagName: "DIV", value: SECRET, textContent: SECRET },
      timeStamp: 100,
    };
    cap.emit("pointermove", secretEvent(secretProps));
    cap.emit("pointerdown", secretEvent(secretProps));
    cap.emit("keydown", secretEvent(secretProps));
    cap.emit("beforeinput", secretEvent(secretProps));
    cap.emit("wheel", secretEvent({ ...secretProps, deltaY: 100 }));

    const published = [
      ...mouse.getSamples(),
      ...click.getSamples(),
      ...keyboard.getSamples(),
      ...text.getSamples(),
      ...scroll.getSamples(),
    ];
    expect(published.length).toBe(5);
    expect(published.every(allFiniteNumbers)).toBe(true);
    for (const collector of [mouse, click, keyboard, text, scroll]) {
      expect(JSON.stringify(collector.getSamples())).not.toContain(SECRET);
    }
    expect(JSON.stringify(published)).not.toContain("textContent");
    expect(JSON.stringify(published)).not.toContain("clipboard");
    for (const collector of [mouse, click, keyboard, text, scroll]) collector.detach();
    cap.restore();
  });

  it("password-field values se ignoran sin leerse en teclado y texto", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const keyboard = createKeyboardCollector({ target, now: () => 0 });
    const text = createTextInputCollector({ target, now: () => 0 });
    keyboard.attach();
    text.attach();
    const secretTarget = {
      tagName: "INPUT",
      type: "password",
      get value(): string {
        throw new Error("value leído");
      },
    };
    expect(() => {
      cap.emit("keydown", secretEvent({ code: "KeyA", timeStamp: 10, target: secretTarget }));
      cap.emit(
        "beforeinput",
        secretEvent({
          inputType: "insertText",
          data: SECRET,
          timeStamp: 20,
          target: secretTarget,
        }),
      );
    }).not.toThrow();
    expect(keyboard.getSamples()).toEqual([]);
    expect(text.getSamples()).toEqual([]);
    keyboard.detach();
    text.detach();
    cap.restore();
  });

  it("privacyAudit y PRIVACY_NOTICE siguen siendo declaraciones literales", () => {
    expect(privacyAudit()).toEqual({
      networkCalls: 0,
      persistentStorage: 0,
      cookies: 0,
      keyIdentities: 0,
    });
    expect(PRIVACY_NOTICE).toContain("no envía datos");
    expect(PRIVACY_NOTICE).not.toMatch(/https?:\/\//);
  });

  it("scan estático: los módulos del alcance no tienen red, storage, cookies ni .value", async () => {
    const paths = [
      "../src/collectors/mouse.ts",
      "../src/collectors/click.ts",
      "../src/collectors/keyboard.ts",
      "../src/collectors/text-input.ts",
      "../src/collectors/scroll.ts",
      "../src/collectors/attention.ts",
      "../src/collectors/touch.ts",
      "../src/core/injection.ts",
      "../src/core/coherence.ts",
      "../src/utils/privacy.ts",
      "../src/utils/privacy-audit.ts",
    ];
    const sources = await Promise.all(
      paths.map(async (path) => {
        const raw = await Bun.file(new URL(path, import.meta.url)).text();
        return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      }),
    );
    const code = sources.join("\n");
    expect(code).not.toMatch(/fetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(code).not.toMatch(/document\s*\.\s*cookie/);
    expect(code).not.toMatch(/navigator\s*\./);
    expect(code).not.toMatch(/event\s*\.\s*key\b|\.keyCode\b|\.which\b/);
    // Los getters que lanzan en el test demuestran que NO se leen estas props.
    expect(code).not.toMatch(/\.value\b|\.textContent\b|clipboardData/);
  });
});

describe("F5/F6/F7/F8: guardarrails bajo suplantación y entradas hostiles", () => {
  it("F5: isTrusted forjado se cuenta como 0 y la cadencia se detecta numéricamente", () => {
    const target = new EventTarget();
    const cap = capture(target);
    const collector = createKeyboardCollector({ target, now: () => 0 });
    collector.attach();
    for (let i = 0; i < 12; i += 1) {
      cap.emit("keydown", plain({ code: "KeyA", timeStamp: i * 40, isTrusted: 1 }));
    }
    expect(collector.getSamples().every((sample) => sample.trusted === 0)).toBe(true);
    collector.detach();
    cap.restore();

    // Incluso si el atacante consiguiera trusted=1 en todas las muestras,
    // la cadencia formulaica basta para disparar la señal numérica.
    const metronome = timesFrom(Array(24).fill(40), 1000).map((t, i) => key(t, i + 1, 1));
    const risk = injectionRisk(metronome, [], []);
    expect(inUnit(risk)).toBe(true);
    expect(risk).toBeGreaterThan(0.8);
  });

  it("F6: ciclos de periodo 7/8 y pausas periódicas ya no evaden humanizationRisk", () => {
    function cycleRisk(cycle: number[], reps: number): number {
      const dts = Array.from({ length: cycle.length * reps }, (_, i) => cycle[i % cycle.length]);
      const keys = timesFrom(dts, 1000).map((t, i) => key(t, i + 1, 1));
      return humanizationRisk(keys, []);
    }
    const sawtooth7 = cycleRisk([50, 60, 70, 80, 90, 100, 110], 4);
    const sawtooth8 = cycleRisk([50, 60, 70, 80, 90, 100, 110, 120], 4);
    const periodicPause = cycleRisk([50, 50, 50, 50, 50, 50, 500], 4);
    for (const value of [sawtooth7, sawtooth8, periodicPause]) {
      expect(inUnit(value)).toBe(true);
      expect(value).toBeGreaterThan(0.8);
    }
    // Sin trampa: metrónomo (inyección, no humanización) y ruido irregular.
    expect(
      humanizationRisk(
        timesFrom(Array(24).fill(60), 1000).map((t, i) => key(t, i + 1)),
        [],
      ),
    ).toBe(0);
    expect(
      humanizationRisk(
        timesFrom(
          [23, 61, 17, 88, 34, 52, 19, 74, 41, 29, 96, 38, 55, 22, 67, 45, 31, 83, 27, 58],
          1000,
        ).map((t, i) => key(t, i + 1)),
        [],
      ),
    ).toBe(0);
  });

  it("F7: NaN/Infinity no contaminan ninguna salida de los guardarrails", () => {
    const inf = Number.POSITIVE_INFINITY;
    const badKeys = timesFrom(Array(20).fill(50), 1000).map((t, i) =>
      key(i % 3 === 0 ? inf : t, i + 1),
    );
    const badInputs = timesFrom(Array(20).fill(70), 2000).map((_t, i) => input(Number.NaN, i + 1));
    const badPointers = timesFrom(Array(20).fill(60), 3000).map((t, i) =>
      pointer(i % 4 === 0 ? -inf : t, i + 1),
    );
    expect(inUnit(injectionRisk(badKeys, badInputs, badPointers))).toBe(true);
    expect(inUnit(humanizationRisk(badKeys, badInputs))).toBe(true);
    for (const signals of [
      evaluateCoherence(badPointers, [], [], badKeys, badInputs),
      evaluateCoherence(
        badPointers,
        badPointers.map((p) => click(p.t)),
        [],
        [],
        [],
      ),
      evaluateCoherence(
        [],
        [],
        badPointers.map((p) => scroll(p.t)),
        badKeys,
        [],
      ),
    ]) {
      for (const value of Object.values(signals)) expect(inUnit(value)).toBe(true);
    }
    expect(inUnit(declaredVsBehavior("touch", badPointers, [], []))).toBe(true);
  });

  it("fail-closed: sin evidencia no se inventa confianza de IA", () => {
    expect(injectionRisk([], [], [])).toBe(0);
    expect(humanizationRisk([], [])).toBe(0);
    expect(evaluateCoherence([], [], [], [], [])).toEqual({
      mixedSuspicious: 0,
      actionsWithoutPriorEvent: 0,
      phantomEvents: 0,
    });
    expect(injectionRisk([key(Number.NaN)], [input(infinity())], [pointer(Number.NaN)])).toBe(0);
    expect(
      evaluateCoherence(
        [pointer(Number.NaN)],
        [click(Number.NaN)],
        [scroll(Number.NaN)],
        [key(Number.NaN)],
        [input(Number.NaN)],
      ),
    ).toEqual({ mixedSuspicious: 0, actionsWithoutPriorEvent: 0, phantomEvents: 0 });
  });

  it("contradictory streams: señal humana + robótica puntúa sin mutar la entrada", () => {
    const humanTimes = timesFrom(
      [23, 61, 17, 88, 34, 52, 19, 74, 41, 29, 96, 38, 55, 22, 67, 45, 31, 83, 27, 58],
      1000,
    );
    const roboticTimes = timesFrom(Array(20).fill(40), 5000);
    const samples = humanTimes.map((t, i) => pointer(t, i + 1));
    const keys = roboticTimes.map((t, i) => key(t, i + 1));
    const before = JSON.stringify({ samples, keys });
    const signals = evaluateCoherence(samples, [], [], keys, []);
    expect(inUnit(signals.mixedSuspicious)).toBe(true);
    expect(signals.mixedSuspicious).toBeGreaterThan(0.8);
    expect(JSON.stringify({ samples, keys })).toBe(before);
  });

  it("F8:coherence con arrays grandes termina en tiempo lineal (no O(n²))", () => {
    const n = 25000;
    const samples = Array.from({ length: n }, (_, i) => pointer(i * 10, i + 1));
    const clicks = Array.from({ length: n }, (_, i) => click(i * 10, i + 1));
    const started = performance.now();
    const signals = evaluateCoherence(samples, clicks, [], [], []);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    for (const value of Object.values(signals)) expect(inUnit(value)).toBe(true);
    // Las mismas marcas duplicadas no pueden colgar humanizationRisk.
    const keys = Array.from({ length: n }, (_, i) => key(i * 10, i + 1));
    expect(inUnit(humanizationRisk(keys, []))).toBe(true);
  });
});

function infinity(): number {
  return Number.POSITIVE_INFINITY;
}

describe("SSR: importar cada módulo del alcance sin DOM", () => {
  it("todos los módulos importan en un proceso hijo sin window/document/navigator", () => {
    const modules = [
      "../src/collectors/mouse.ts",
      "../src/collectors/click.ts",
      "../src/collectors/keyboard.ts",
      "../src/collectors/text-input.ts",
      "../src/collectors/scroll.ts",
      "../src/collectors/attention.ts",
      "../src/collectors/touch.ts",
      "../src/core/injection.ts",
      "../src/core/coherence.ts",
      "../src/utils/privacy.ts",
      "../src/utils/privacy-audit.ts",
      "../src/index.ts",
    ].map((path) => new URL(path, import.meta.url).href);
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `for (const url of ${JSON.stringify(modules)}) await import(url);`,
      "console.log('ssr-ok');",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("ssr-ok");
  });
});
