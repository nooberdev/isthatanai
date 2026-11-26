// Etapa 10 · cierre de la brecha de i18n para las dos razones nuevas que emite
// el detector. SIN DOM, SIN reloj, SIN aleatoriedad: todo es determinista.

import { describe, expect, it } from "bun:test";
import { dictionaries, en, LOCALES, type TranslationKey, t } from "../src/i18n/index.ts";
import { translateReasons } from "../src/i18n/reason-translator.ts";

const REPLAY_KEY: TranslationKey = "reason.security.replay";
const INTEGRITY_KEY: TranslationKey = "reason.security.integrity";
const SECURITY_KEYS: readonly TranslationKey[] = [REPLAY_KEY, INTEGRITY_KEY];

// Copiadas literalmente de `src/core/detector.ts:82-83` (constantes privadas).
// El diccionario `es` debe contenerlas byte a byte para que el mapa invertido
// de `translateReasons()` las resuelva sin tocar el detector.
const REPLAY_REASON = "Trayectoria idéntica repetida en la sesión";
const INTEGRITY_REASON = "Integridad verificada: manipulación detectada";

describe("i18n · Etapa 10 (razones de seguridad)", () => {
  it("las 12 configuraciones regionales incluyen ambas claves con texto no vacío", () => {
    expect(LOCALES).toHaveLength(12);
    for (const locale of LOCALES) {
      const table = dictionaries[locale] as Readonly<Record<string, unknown>>;
      for (const key of SECURITY_KEYS) {
        expect(Object.hasOwn(table, key), `${locale}.${key} ausente`).toBe(true);
        expect(typeof table[key], `${locale}.${key}`).toBe("string");
        expect((table[key] as string).trim().length, `${locale}.${key} vacía`).toBeGreaterThan(0);
      }
    }
  });

  it("el español coincide byte a byte con las constantes del detector", async () => {
    expect(dictionaries.es[REPLAY_KEY]).toBe(REPLAY_REASON);
    expect(dictionaries.es[INTEGRITY_KEY]).toBe(INTEGRITY_REASON);

    // Verifica además que las constantes siguen siendo estas cadenas exactas
    // en la fuente, para detectar cualquier deriva futura del detector.
    const source = await Bun.file(new URL("../src/core/detector.ts", import.meta.url)).text();
    expect(source).toContain(`const REPLAY_REASON = ${JSON.stringify(REPLAY_REASON)};`);
    expect(source).toContain(`const INTEGRITY_REASON = ${JSON.stringify(INTEGRITY_REASON)};`);
  });

  it("t(key, locale) funciona para los 12 idiomas y ambas claves", () => {
    for (const locale of LOCALES) {
      for (const key of SECURITY_KEYS) {
        const value = t(key, locale);
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value.length, `${locale}.${key} vacía`).toBeGreaterThan(0);
      }
    }
  });

  it("en es la fuente y el reserva de ambas claves", () => {
    expect(t(REPLAY_KEY)).toBe(en[REPLAY_KEY]);
    expect(t(INTEGRITY_KEY)).toBe(en[INTEGRITY_KEY]);
    expect(t(REPLAY_KEY, "en")).toBe("Identical trajectory repeated in the session");
    expect(t(INTEGRITY_KEY, "en")).toBe("Integrity verified: tampering detected");
  });

  it("translateReasons traduce las razones nuevas a en, fr y zh", () => {
    const input: string[] = [REPLAY_REASON, INTEGRITY_REASON];
    for (const locale of ["en", "fr", "zh"] as const) {
      const output = translateReasons(input, locale);
      expect(output, locale).toHaveLength(2);
      expect(output, locale).not.toEqual(input);
      expect(output[0], locale).toBe(t(REPLAY_KEY, locale));
      expect(output[1], locale).toBe(t(INTEGRITY_KEY, locale));
      for (const reason of output) {
        expect(reason, locale).not.toBe(REPLAY_REASON);
        expect(reason, locale).not.toBe(INTEGRITY_REASON);
      }
    }
  });

  it("translateReasons en es devuelve las originales sin mutar la entrada", () => {
    const input: string[] = [REPLAY_REASON, INTEGRITY_REASON];
    const snapshot = [...input];
    expect(translateReasons(input, "es")).toEqual(input);
    expect(input).toEqual(snapshot);
  });
});
