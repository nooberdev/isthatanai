// Configuración regional de la librería. SIN DOM al importar: `navigator`
// solo se lee dentro de `detectLocale()`, en tiempo de ejecución (SSR-safe).

/** Idiomas soportados. `en` es el idioma por defecto y de reserva. */
export type Locale =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "it"
  | "nl"
  | "sv"
  | "pl"
  | "ja"
  | "ko"
  | "zh";

/** Lista estable de idiomas soportados (en el mismo orden que `Locale`). */
export const LOCALES: readonly Locale[] = Object.freeze([
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "nl",
  "sv",
  "pl",
  "ja",
  "ko",
  "zh",
] as const satisfies readonly Locale[]);

/** Etiquetas aceptadas: xx, xx-XX, xx_XX, xx-Hant, xx-419... */
const SUPPORTED: readonly Locale[] = LOCALES;

/**
 * Detecta el idioma del sistema y lo reduce a uno de los soportados.
 *
 * - Con argumento explícito se usa ése (para tests); si no, se lee
 *   `globalThis.navigator?.language` en el momento de la llamada.
 * - Se comparan solo prefijos: `es-ES` -> `es`, `pt-BR` -> `pt`,
 *   `zh-CN`/`zh-Hans`/`zh-SG`/`zh-TW`/`zh-Hant` -> `zh`, etc.
 * - Cualquier idioma desconocido, valor vacío o entorno sin DOM -> `en`.
 */
export function detectLocale(language?: string): Locale {
  let raw: string | undefined;
  if (typeof language === "string") {
    raw = language;
  } else {
    // Acceso tardío y opcional: nunca al importar ni en un constructor.
    const nav = (globalThis as { navigator?: { language?: unknown } }).navigator;
    const value = nav?.language;
    if (typeof value === "string") raw = value;
  }

  if (raw === undefined) return "en";
  const tag = raw.trim().toLowerCase().replaceAll("_", "-");
  if (tag.length === 0) return "en";

  // La subetiqueta inicial es el idioma (p. ej. "zh-Hant-TW" -> "zh").
  const base = tag.split("-", 1)[0];
  for (const locale of SUPPORTED) {
    if (base === locale) return locale;
  }
  return "en";
}
