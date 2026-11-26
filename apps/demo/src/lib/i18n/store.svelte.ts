// Estado reactivo del idioma de la demo. Un único store compartido: cada
// componente lee `i18n.locale` y llama a `tr()`. Sin storage, cookies ni red.
// La detección del sistema solo ocurre en init(), invocado desde onMount.

import { detectLocale, type Locale } from "is-that-an-ai";
import { live } from "#lib/detector/live.svelte";
import { translate } from "./translate";
import type { DemoTranslationKey, TranslationParams } from "./types";

/** Superficie mínima del detector vivo; la librería la cumple exactamente. */
interface ConfigurableDetector {
  configure(config: { locale: Locale | "auto" }): void;
  getLocale(): Locale;
}

class LocaleStore {
  locale = $state<Locale>("en");
  mode = $state<"auto" | Locale>("auto");

  private detector: ConfigurableDetector | null = null;

  /** Llamar SOLO desde onMount: `detectLocale()` lee navigator en ese momento. */
  init(): void {
    this.select("auto");
  }

  /** Enlaza el detector real para que las razones sigan al idioma elegido. */
  attach(detector: ConfigurableDetector): void {
    this.detector = detector;
    detector.configure({ locale: this.locale });
    this.locale = detector.getLocale();
  }

  detach(): void {
    this.detector = null;
  }

  /** Cambio inmediato: UI y razones del detector, sin persistencia. */
  select(choice: "auto" | Locale): void {
    const next: Locale = choice === "auto" ? detectLocale() : choice;
    this.mode = choice;
    this.locale = next;
    this.detector?.configure({ locale: next });
    live.pump();
  }
}

export const i18n = new LocaleStore();

/** Look reactivo: leer `i18n.locale` aquí crea la dependencia en el componente. */
export function tr(key: DemoTranslationKey, params?: TranslationParams): string {
  return translate(key, i18n.locale, params);
}

/** Nombre nativo de un idioma, para las opciones del selector. */
export function languageName(locale: Locale): string {
  return tr(`language.name.${locale}` as DemoTranslationKey);
}
