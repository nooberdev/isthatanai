import { describe, expect, it } from "bun:test";
import {
  detectLocale,
  dictionaries,
  en,
  LOCALES,
  type Locale,
  type TranslationKey,
  t,
} from "../src/i18n/index.ts";

const keys = Object.keys(en) as TranslationKey[];

describe("i18n · diccionarios", () => {
  it("registra exactamente los 12 idiomas", () => {
    expect(LOCALES).toHaveLength(12);
    expect([...LOCALES].sort()).toEqual(
      ["en", "es", "fr", "de", "pt", "it", "nl", "sv", "pl", "ja", "ko", "zh"].sort(),
    );
    expect(Object.keys(dictionaries).sort()).toEqual([...LOCALES].sort());
  });

  it("cada diccionario tiene TODAS las claves y ninguna cadena vacía", () => {
    for (const locale of LOCALES) {
      const table = dictionaries[locale] as Readonly<Record<string, unknown>>;
      expect(Object.keys(table).sort(), `claves de ${locale}`).toEqual([...keys].sort());
      for (const key of keys) {
        const value = table[key];
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect((value as string).trim().length, `${locale}.${key} vacía`).toBeGreaterThan(0);
      }
    }
  });

  it("el diccionario chino usa caracteres simplificados", () => {
    expect(t("verdict.measuring", "zh")).toBe("测量中");
    expect(t("reason.mouse.teleport", "zh")).toBe("检测到瞬移");
    expect(t("privacy.notice", "zh")).toContain("不发送数据");

    const traditionalOnly = [
      "測",
      "滾",
      "鍵",
      "盤",
      "標",
      "規",
      "則",
      "異",
      "點",
      "擊",
      "貼",
      "儲",
      "資",
      "記",
      "錄",
      "刪",
      "選",
      "擇",
      "壓",
      "縮",
      "準",
      "養",
      "體",
    ];
    for (const key of keys) {
      for (const char of traditionalOnly) {
        expect(t(key, "zh"), `${key} contiene ${char}`).not.toContain(char);
      }
    }
  });
});

describe("i18n · reserva en inglés", () => {
  it("usa inglés por defecto", () => {
    expect(t("verdict.human")).toBe("Human");
    expect(t("verdict.human", "en")).toBe("Human");
    expect(t("verdict.human", "es")).toBe("Humano");
  });

  it("devuelve el inglés si falta la clave en el idioma pedido", () => {
    const mutable = dictionaries.es as unknown as Record<string, string>;
    const key: TranslationKey = "verdict.human";
    const original = mutable[key];
    try {
      delete mutable[key];
      expect(t(key, "es")).toBe(en[key]);
      expect(t("reason.click.noPauses", "es")).toBe("Sin pausas entre clics");
    } finally {
      mutable[key] = original;
    }
  });

  it("un locale desconocido en tiempo de ejecución también cae al inglés", () => {
    expect(t("verdict.ai", "xx" as unknown as Locale)).toBe("AI");
  });

  it("sustituye los marcadores de las razones dinámicas", () => {
    expect(t("reason.handover", "es", { from: "human", to: "ai" })).toBe(
      "Cambio de controlador: human → ai",
    );
    expect(t("reason.accessibility.profile", "en", { device: "tv" })).toBe(
      "Profile tv: score attenuated for accessibility",
    );
  });
});

describe("i18n · detección del idioma", () => {
  it("reduce más de 15 etiquetas al locale soportado", () => {
    const cases: ReadonlyArray<readonly [string, Locale]> = [
      ["en-US", "en"],
      ["en-GB", "en"],
      ["en_US", "en"],
      ["es-ES", "es"],
      ["es-419", "es"],
      ["ES-es", "es"],
      ["fr-FR", "fr"],
      ["fr-CA", "fr"],
      ["de-DE", "de"],
      ["de-AT", "de"],
      ["pt-BR", "pt"],
      ["pt-PT", "pt"],
      ["it-IT", "it"],
      ["nl-NL", "nl"],
      ["nl-BE", "nl"],
      ["sv-SE", "sv"],
      ["pl-PL", "pl"],
      ["ja-JP", "ja"],
      ["ko-KR", "ko"],
      ["zh-CN", "zh"],
      ["zh-Hans", "zh"],
      ["ru-RU", "en"],
      ["xx-XX", "en"],
      ["", "en"],
      ["   ", "en"],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(15);
    for (const [tag, expected] of cases) {
      expect(detectLocale(tag), tag).toBe(expected);
    }
  });

  it("incluye una etiqueta de muestra para cada uno de los 12 idiomas", () => {
    const samples: ReadonlyArray<readonly [Locale, string]> = [
      ["en", "en-US"],
      ["es", "es-ES"],
      ["fr", "fr-FR"],
      ["de", "de-DE"],
      ["pt", "pt-BR"],
      ["it", "it-IT"],
      ["nl", "nl-NL"],
      ["sv", "sv-SE"],
      ["pl", "pl-PL"],
      ["ja", "ja-JP"],
      ["ko", "ko-KR"],
      ["zh", "zh-CN"],
    ];
    expect(samples).toHaveLength(LOCALES.length);
    for (const [locale, tag] of samples) {
      expect(detectLocale(tag), tag).toBe(locale);
      expect(t("verdict.human", detectLocale(tag)).length).toBeGreaterThan(0);
    }
  });

  it("mapea TODAS las variantes chinas a zh", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-SG", "zh-TW", "zh-Hant", "zh-Hant-TW"]) {
      expect(detectLocale(tag), tag).toBe("zh");
    }
  });

  it("sin idioma conocido devuelve en y tolera valores no string", () => {
    expect(detectLocale()).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
    expect(detectLocale(null as unknown as string)).toBe("en");
    expect(detectLocale(42 as unknown as string)).toBe("en");
  });
});

describe("i18n · importación SSR", () => {
  it("importa y funciona sin window/document/navigator", () => {
    const entry = new URL("../src/i18n/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const m = await import(${JSON.stringify(entry)});`,
      'if (m.detectLocale() !== "en") throw new Error("detectLocale no es SSR-safe");',
      'if (m.t("verdict.human") !== "Human") throw new Error("t no es SSR-safe");',
    ].join("\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("i18n · cadenas originales en español", () => {
  const spanish: ReadonlyArray<readonly [TranslationKey, string]> = [
    ["reason.mouse.straightnessHigh", "Trayectoria demasiado recta"],
    ["reason.mouse.straightnessLow", "Trayectoria meandrosa"],
    ["reason.mouse.teleport", "Teletransporte detectado"],
    ["reason.mouse.speedUniformityHigh", "Velocidad casi constante"],
    ["reason.mouse.speedUniformityLow", "Velocidad irregular"],
    ["reason.mouse.jerkHigh", "Cambios suaves de velocidad"],
    ["reason.mouse.jerkLow", "Cambios bruscos de velocidad"],
    ["reason.mouse.tremorHigh", "Poco temblor de mano"],
    ["reason.mouse.tremorLow", "Temblor evidente"],
    ["reason.mouse.intervalRegularityHigh", "Eventos con intervalos regulares"],
    ["reason.mouse.intervalRegularityLow", "Intervalos irregulares entre eventos"],
    ["reason.mouse.overshootHigh", "Correcciones visibles"],
    ["reason.mouse.overshootLow", "Sin correcciones al llegar"],
    ["reason.mouse.turnSmoothnessHigh", "Giros suaves"],
    ["reason.mouse.turnSmoothnessLow", "Giros bruscos"],
    ["reason.mouse.microPausesHigh", "Micro-pausas raras"],
    ["reason.mouse.microPausesLow", "Pausas frecuentes"],
    ["reason.mouse.roundStepsHigh", "Pasos numéricos redondos"],
    ["reason.mouse.roundStepsLow", "Pasos variables"],
    ["reason.click.durationRegularity", "Duraciones de clic casi idénticas"],
    ["reason.click.intervalRegularity", "Ritmo de clics demasiado regular"],
    ["reason.click.burstiness", "Ráfagas de clics seguidos"],
    ["reason.click.downUpDrift", "Clic sin desplazamiento al soltar"],
    ["reason.click.singleButton", "Un solo botón usado siempre"],
    ["reason.click.noPauses", "Sin pausas entre clics"],
    ["reason.click.aimConsistency", "Puntería repetida en el mismo punto"],
    ["reason.scroll.deltaUniformity", "Desplazamientos de scroll uniformes"],
    ["reason.scroll.intervalRegularity", "Ritmo de scroll demasiado regular"],
    ["reason.scroll.directionChanges", "Scroll siempre en la misma dirección"],
    ["reason.scroll.decelerationProfile", "Sin desaceleración al terminar el scroll"],
    ["reason.scroll.noPauses", "Sin pausas entre gestos de scroll"],
    ["reason.scroll.roundDeltas", "Deltas de scroll numéricamente redondos"],
    ["reason.scroll.axisLock", "Scroll bloqueado en un solo eje"],
    ["reason.scroll.largeJumps", "Saltos grandes repetidos de desplazamiento"],
    ["reason.keyboard.intervalRegularity", "Ritmo de tecleo demasiado regular"],
    ["reason.keyboard.holdRegularity", "Pulsaciones de igual duración"],
    ["reason.keyboard.correctionBursts", "Ráfagas de borrado repetidas"],
    ["reason.keyboard.pasteRatio", "Texto insertado mediante pegado"],
    ["reason.keyboard.textWithoutKeydown", "Aparece texto sin teclas previas"],
    ["reason.keyboard.modifierShortcuts", "Atajos de teclado repetidos"],
    ["reason.keyboard.noPauses", "Sin pausas al teclear"],
    ["reason.keyboard.exactRhythm", "Intervalos de tecleo idénticos"],
    ["reason.keyboard.intervalDistribution", "Intervalos de tecleo demasiado concentrados"],
    ["reason.keyboard.typingSpeed", "Velocidad de tecleo imposible a mano"],
    ["reason.keyboard.pauseAfterError", "Correcciones encadenadas sin pausa"],
    ["reason.keyboard.wordPauses", "Sin pausas entre palabras"],
    ["reason.keyboard.sentenceEndPauses", "Sin pausas al final de frase"],
    ["reason.keyboard.selectionDeletion", "Borrados sin selección previa"],
    ["reason.keyboard.arrowUsage", "Edición sin uso de flechas"],
    [
      "reason.keyboard.autocompleteFalsePositive",
      "Inserciones agrupadas (probable autocompletado)",
    ],
    ["reason.keyboard.enterSubmit", "Envíos automáticos con Enter"],
    ["reason.keyboard.capitalization", "Mayúsculas generadas con eventos instantáneos"],
    ["reason.keyboard.programmaticKeys", "Teclas programáticas (no confiables)"],
    [
      "privacy.notice",
      "Este detector solo mide tiempos y magnitudes en tu dispositivo: no envía datos, no usa cookies ni almacenamiento, y nunca guarda qué teclas pulsas ni qué texto escribes.",
    ],
  ];

  it("reproduce exactamente las razones del código fuente (mouse, click, scroll, keyboard)", () => {
    for (const [key, expected] of spanish) {
      expect(t(key, "es"), key).toBe(expected);
    }
  });

  it("reproduce las razones dinámicas del código fuente", () => {
    expect(t("reason.accessibility.profile", "es", { device: "tv" })).toBe(
      "Perfil tv: puntaje atenuado por accesibilidad",
    );
    expect(t("reason.accessibility.profile", "es", { device: "touch" })).toBe(
      "Perfil touch: puntaje atenuado por accesibilidad",
    );
    expect(t("reason.handover", "es", { from: "human", to: "ai" })).toBe(
      "Cambio de controlador: human → ai",
    );
  });

  it("cubre todas las razones del código fuente", () => {
    const reasonKeys = keys.filter((key) => key.startsWith("reason."));
    expect(reasonKeys).toHaveLength(57);
  });
});
