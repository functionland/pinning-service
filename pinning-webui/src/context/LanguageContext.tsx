import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Language, Translations, languages, getTranslation, getLanguageInfo } from '../i18n';

const STORAGE_KEY = 'fula-pinning-language';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
  dir: 'ltr' | 'rtl';
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

function getInitialLanguage(): Language {
  // Check localStorage first
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && languages.some(l => l.code === stored)) {
    return stored as Language;
  }
  
  // Check browser language
  const browserLang = navigator.language.split('-')[0];
  const match = languages.find(l => l.code === browserLang);
  if (match) {
    return match.code;
  }
  
  return 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);
  const [t, setT] = useState<Translations>(getTranslation(getInitialLanguage()));
  const [dir, setDir] = useState<'ltr' | 'rtl'>(getLanguageInfo(getInitialLanguage()).dir);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem(STORAGE_KEY, lang);
    setT(getTranslation(lang));
    setDir(getLanguageInfo(lang).dir);
  };

  useEffect(() => {
    // Set document direction for RTL languages
    document.documentElement.dir = dir;
    document.documentElement.lang = language;
  }, [dir, language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, dir }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
