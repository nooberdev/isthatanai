// Fachada pública del i18n de la demo.
export { dictionaries } from "./dictionaries";
export { i18n, languageName, tr } from "./store.svelte";
export { translate } from "./translate";
export type {
  DemoTranslationKey,
  Dictionary,
  LanguageChoice,
  Locale,
  TranslationParams,
} from "./types";
