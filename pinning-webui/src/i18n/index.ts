import { Language, languages, Translations } from './types';
import { en } from './en';
import { zh } from './zh';
import { fa } from './fa';
import { ar } from './ar';
import { de } from './de';
import { es } from './es';
import { hi } from './hi';
import { fr } from './fr';

export type { Language, Translations } from './types';
export { languages } from './types';

export const translations: Record<Language, Translations> = {
  en,
  zh,
  fa,
  ar,
  de,
  es,
  hi,
  fr,
};

export function getTranslation(lang: Language): Translations {
  return translations[lang] || translations.en;
}

export function getLanguageInfo(code: Language) {
  return languages.find(l => l.code === code) || languages[0];
}
