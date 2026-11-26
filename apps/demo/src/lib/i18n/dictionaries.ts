// Los 12 diccionarios de la demo. Inglés por defecto y como reserva.
import type { Locale } from "is-that-an-ai";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { pt } from "./locales/pt";
import { sv } from "./locales/sv";
import { zh } from "./locales/zh";
import type { Dictionary } from "./types";

export const dictionaries: Readonly<Record<Locale, Dictionary>> = Object.freeze({
  en,
  es,
  fr,
  de,
  pt,
  it,
  nl,
  sv,
  pl,
  ja,
  ko,
  zh,
});
