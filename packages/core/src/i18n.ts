// Texts the server shows to a person: the access refusal (shown by the
// Secret Keeper app on behalf of the service and by the browser popup) and
// the request context lines. Two languages, as in the app; the service can
// replace any text via `messages` in the SkLogin options.

export type Lang = 'ru' | 'en';

export interface Messages {
  /** The address is proven but there is no access. One text for all
   *  reasons: we do not tell the user who is on the list and who is blocked. */
  accessDenied: string;
  /** Request context (challenge v2). */
  from: string;
  ip: string;
  browser: string;
  unknownBrowser: string;
}

export const defaultMessages: Record<Lang, Messages> = {
  ru: {
    accessDenied: 'Вход подтверждён, доступ пока не открыт. Если вас здесь ждут, следующий вход пройдёт.',
    from: 'Откуда',
    ip: 'IP-адрес',
    browser: 'Браузер',
    unknownBrowser: 'неизвестный браузер',
  },
  en: {
    accessDenied: 'Sign-in confirmed, but access is not open yet. If you are expected here, your next sign-in will go through.',
    from: 'Location',
    ip: 'IP address',
    browser: 'Browser',
    unknownBrowser: 'unknown browser',
  },
};

/** Response language from Accept-Language: the first tag, ru* means ru, otherwise en. */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  const first = (header ?? '').split(',')[0].trim().toLowerCase();
  return first === 'ru' || first.startsWith('ru-') ? 'ru' : 'en';
}

/** Dictionary with the service's overrides on top of the default texts. */
export function mergeMessages(overrides?: Partial<Record<Lang, Partial<Messages>>>): Record<Lang, Messages> {
  return {
    ru: { ...defaultMessages.ru, ...overrides?.ru },
    en: { ...defaultMessages.en, ...overrides?.en },
  };
}
