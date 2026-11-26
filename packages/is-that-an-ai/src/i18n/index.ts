// Base de i18n de la librería: 12 idiomas, detección del idioma del sistema,
// inglés por defecto y como reserva. SIN acceso al DOM al importar.

import { type Dictionary, dictionaries, en, type TranslationKey } from "./dictionaries";
import type { Locale } from "./locales";

export {
  type Dictionary,
  dictionaries,
  en,
  type TranslationKey,
} from "./dictionaries";
export { detectLocale, LOCALES, type Locale } from "./locales";

/** Valores admitidos para los marcadores `{...}` de las razones dinámicas. */
export type TranslationParams = Readonly<Record<string, string | number>>;

/**
 * Traduce una clave al idioma dado.
 *
 * - Sin `locale` se usa `en` (por defecto).
 * - Si la clave no existe en el idioma pedido, se devuelve la de inglés.
 * - Los marcadores `{nombre}` se sustituyen con `params` cuando se aportan.
 */
export function t(key: TranslationKey, locale: Locale = "en", params?: TranslationParams): string {
  const table: Dictionary | undefined = (dictionaries as Readonly<Record<string, Dictionary>>)[
    locale
  ];
  const raw: unknown = table?.[key];
  let text: string =
    typeof raw === "string" && raw.length > 0 ? raw : (en as Readonly<Record<string, string>>)[key];

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
