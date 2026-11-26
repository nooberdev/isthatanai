// Traducción pura (sin DOM): inglés por defecto y reserva de claves ausentes.
import type { Locale } from "is-that-an-ai";
import { dictionaries } from "./dictionaries";
import { en } from "./locales/en";
import type { DemoTranslationKey, TranslationParams } from "./types";

export function translate(
  key: DemoTranslationKey,
  locale: Locale = "en",
  params?: TranslationParams,
): string {
  const table: Readonly<Record<string, string>> | undefined = dictionaries[locale];
  let text: string = table?.[key] ?? (en as Readonly<Record<string, string>>)[key] ?? key;

  if (params !== undefined && params !== null) {
    for (const name of Object.keys(params)) {
      const value = params[name];
      if (typeof value === "string" || typeof value === "number") {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
  }
  return text;
}
