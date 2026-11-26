// Cableado de i18n en la API pública del detector: detección en start(),
// razones localizadas y scores intactos. Sin depender de DOM real.

import { describe, expect, it } from "bun:test";
import { detectLocale, en, LOCALES, type Locale, t } from "../src/i18n";
import { translateReasons } from "../src/i18n/reason-translator";
import { IsThatAnAI } from "../src/index";

function pointerMove(x: number, y: number, timeStamp: number): Event {
  const event = new Event("pointermove");
  const props: Record<string, number | string> = {
    clientX: x,
    clientY: y,
    timeStamp,
    pointerType: "mouse",
  };
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

/**
 * Sesión determinista: reloj inyectado que sigue el timeStamp del último evento,
 * la misma secuencia "bot obvio" en todos los idiomas y un target aislado.
 */
function runSession(
  locale?: Locale | "auto",
  onVerdict?: (reasons: string[]) => void,
): {
  detector: IsThatAnAI;
  finish: () => void;
} {
  const target = new EventTarget();
  let clock = 0;
  const detector = new IsThatAnAI({
    locale,
    now: () => clock,
    onVerdict: onVerdict
      ? (verdict) => {
          onVerdict([...verdict.reasons]);
        }
      : undefined,
  });
  detector.attachTo(target);
  detector.start();
  for (let i = 0; i < 30; i += 1) {
    const ts = i * 60;
    clock = ts;
    const x = i * 10 + (i % 8 === 0 ? 300 : 0);
    target.dispatchEvent(pointerMove(x, x * 2, ts));
    if ((i + 1) % 5 === 0) detector.evaluate();
  }
  detector.evaluate();
  return { detector, finish: () => detector.stop() };
}

function useSession<T>(
  locale: Locale | "auto" | undefined,
  fn: (detector: IsThatAnAI) => T,
  onVerdict?: (reasons: string[]) => void,
): T {
  const { detector, finish } = runSession(locale, onVerdict);
  try {
    return fn(detector);
  } finally {
    finish();
  }
}

describe("i18n · cableado con la API pública", () => {
  it("auto detecta el idioma en start(), no antes", () => {
    const globals = globalThis as { navigator?: { language?: unknown } };
    const hadOwn = Object.hasOwn(globals, "navigator");
    const previous = globals.navigator;
    Object.defineProperty(globals, "navigator", {
      value: { language: "es-ES" },
      configurable: true,
      writable: true,
    });
    try {
      const target = new EventTarget();
      let clock = 0;
      const detector = new IsThatAnAI({ locale: "auto", now: () => clock });
      // El constructor NO consulta navigator: sigue en inglés hasta start().
      expect(detector.getLocale()).toBe("en");
      detector.attachTo(target);
      detector.start();
      expect(detectLocale()).toBe("es");
      expect(detector.getLocale()).toBe("es");
      for (let i = 0; i < 30; i += 1) {
        clock = i * 60;
        target.dispatchEvent(pointerMove(i * 10 + (i % 8 === 0 ? 300 : 0), i * 20, clock));
        if ((i + 1) % 5 === 0) detector.evaluate();
      }
      detector.evaluate();
      const reasons = detector.getReasons();
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons).toEqual(detector.getVerdict().reasons);
      detector.stop();
    } finally {
      if (hadOwn) globals.navigator = previous;
      else Reflect.deleteProperty(globals, "navigator");
    }
  });

  it("sin navigator, auto cae a inglés (default de Bun)", () => {
    expect(detectLocale()).toBe("en");
    useSession(undefined, (detector) => {
      expect(detector.getLocale()).toBe("en");
      expect(detector.getReasons().length).toBeGreaterThan(0);
    });
  });

  it("idioma forzado: los 12 locales producen razones finitas y distintas del español", () => {
    const spanish = useSession("es", (detector) => detector.getReasons());
    expect(spanish.length).toBeGreaterThan(0);
    // Español forzado devuelve exactamente las cadenas originales.
    useSession("es", (detector) => {
      expect(detector.getReasons()).toEqual(spanish);
      expect(detector.getLocale()).toBe("es");
    });

    for (const locale of LOCALES) {
      const reasons = useSession(locale, (detector) => {
        expect(detector.getLocale()).toBe(locale);
        return detector.getReasons();
      });
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(typeof reason).toBe("string");
        expect(Number.isFinite(reason.length)).toBe(true);
      }
      expect(reasons).toEqual(translateReasons(spanish, locale));
      if (locale !== "es") expect(reasons).not.toEqual(spanish);
    }
  });

  it("en inglés las razones son las del diccionario en", () => {
    const spanish = useSession("es", (detector) => detector.getReasons());
    useSession("en", (detector) => {
      expect(detector.getReasons()).toEqual(translateReasons(spanish, "en"));
      for (const reason of detector.getReasons()) expect(reason.length).toBeGreaterThan(0);
    });
  });

  it("onVerdict recibe la copia traducida", () => {
    const emitted: string[][] = [];
    const frenchReasons = new Set(
      Object.entries(en)
        .filter(([key]) => key.startsWith("reason."))
        .map(([key]) => t(key as Parameters<typeof t>[0], "fr")),
    );
    useSession(
      "fr",
      (detector) => {
        expect(emitted.length).toBeGreaterThan(0);
        for (const reasons of emitted) {
          expect(reasons.length).toBeGreaterThan(0);
          for (const reason of reasons) expect(frenchReasons.has(reason)).toBe(true);
        }
        expect(detector.getLocale()).toBe("fr");
      },
      (reasons) => emitted.push(reasons),
    );
  });

  it("el idioma no altera ningún número del veredicto", () => {
    const baseline = useSession("en", (detector) => ({
      verdict: detector.getVerdict(),
      signals: detector.getSignalScores(),
      breakdown: detector.getScoreBreakdown().scores,
    }));
    for (const locale of LOCALES) {
      useSession(locale, (detector) => {
        const current = detector.getVerdict();
        expect(current.state).toBe(baseline.verdict.state);
        expect(current.score).toBe(baseline.verdict.score);
        expect(current.confidence).toBe(baseline.verdict.confidence);
        expect(current.doubt).toBe(baseline.verdict.doubt);
        expect(detector.getSignalScores()).toEqual(baseline.signals);
        expect(detector.getScoreBreakdown().scores).toEqual(baseline.breakdown);
      });
    }
  });

  it("el constructor es SSR-safe (sin window/document/navigator)", () => {
    const entry = new URL("../src/core/detector.ts", import.meta.url).href;
    const code = [
      'Object.defineProperty(globalThis, "navigator", { value: { language: "es-ES" }, configurable: true });',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      'const d = new IsThatAnAI({ locale: "auto" });',
      'if (d.getLocale() !== "en") throw new Error("el constructor detectó el idioma");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      "d.start();",
      'if (d.getLocale() !== "en") throw new Error("start() sin navigator no cae a en");',
      "d.stop();",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error(new TextDecoder().decode(result.stderr));
    }
    expect(result.exitCode).toBe(0);
  });
});
