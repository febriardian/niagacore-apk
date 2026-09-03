import { resources, type SupportedLanguage } from '@niagacore/i18n';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

const deviceLanguage = getLocales()[0]?.languageCode;
const initialLanguage: SupportedLanguage = deviceLanguage === 'en' ? 'en' : 'id';
const LANGUAGE_KEY = 'niagacore.language';

const i18n = createInstance();

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: initialLanguage,
    fallbackLng: 'id',
    interpolation: { escapeValue: false },
  });
}

export async function initializeAppLanguage(): Promise<void> {
  const saved = await SecureStore.getItemAsync(LANGUAGE_KEY);
  if (saved === 'id' || saved === 'en') await i18n.changeLanguage(saved);
}

export async function setAppLanguage(language: SupportedLanguage): Promise<void> {
  await SecureStore.setItemAsync(LANGUAGE_KEY, language);
  await i18n.changeLanguage(language);
}

export { i18n };
