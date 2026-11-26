import type { Locale } from "is-that-an-ai";
import type { en } from "./locales/en";

/** Todas las cadenas visibles de la demo; `en` es la fuente de la verdad. */
export type DemoTranslationKey = keyof typeof en;

/** Cada idioma debe completar todas las claves (fallback en `translate`). */
export type Dictionary = Record<DemoTranslationKey, string>;

/** Valores para los marcadores `{...}` de las cadenas dinámicas. */
export type TranslationParams = Readonly<Record<string, string | number>>;

export type LanguageChoice = Locale | "auto";

export type { Locale };
