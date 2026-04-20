import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en.json";
import ru from "@/locales/ru.json";

const savedLng = typeof localStorage !== "undefined" ? localStorage.getItem("i18nextLng") : null;

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: savedLng === "en" || savedLng === "ru" ? savedLng : "ru",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
