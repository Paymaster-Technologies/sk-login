import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_V1,
  CHALLENGE_V2,
  challengePlaintext,
  challengeVersion,
  clientIp,
  contextFromHeaders,
  defaultMessages,
  describeContext,
  type GeoLookup,
  langFromAcceptLanguage,
  parseUserAgent,
} from '../src/index.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const YANDEX_ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10 Mobile Safari/537.36';

describe('client IP behind the proxy', () => {
  it('takes the last X-Forwarded-For entry (added by the proxy), not the first', () => {
    expect(clientIp('1.1.1.1, 2.2.2.2', '127.0.0.1')).toBe('2.2.2.2');
    expect(clientIp('  9.9.9.9 ', '127.0.0.1')).toBe('9.9.9.9');
  });

  it('falls back to the connection address without a proxy, stripping ::ffff:', () => {
    expect(clientIp(null, '::ffff:10.0.0.5')).toBe('10.0.0.5');
    expect(clientIp('', undefined)).toBe('');
  });

  it('reads headers through a getter (string or array) and unquotes the platform hint', () => {
    const headers: Record<string, string | string[]> = {
      'x-forwarded-for': ['1.1.1.1', '2.2.2.2'],
      'user-agent': CHROME_MAC,
      'sec-ch-ua-platform': '"macOS"',
    };
    expect(contextFromHeaders((n) => headers[n], '127.0.0.1')).toEqual({
      ip: '2.2.2.2',
      ua: CHROME_MAC,
      platform: 'macOS',
    });
    // Without a proxy the client's header does not count.
    expect(contextFromHeaders((n) => headers[n], '127.0.0.1', false).ip).toBe('127.0.0.1');
  });
});

describe('user agent', () => {
  it('names common browsers and systems', () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual({ browser: 'Chrome', os: 'macOS' });
    expect(parseUserAgent(SAFARI_IOS)).toEqual({ browser: 'Safari', os: 'iOS' });
    expect(parseUserAgent(FIREFOX_WIN)).toEqual({ browser: 'Firefox', os: 'Windows' });
    expect(parseUserAgent(YANDEX_ANDROID)).toEqual({ browser: 'Yandex Browser', os: 'Android' });
  });

  it('prefers the Client Hints platform over the frozen UA string', () => {
    expect(parseUserAgent(CHROME_MAC, 'Windows')).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(parseUserAgent('curl/8.0')).toEqual({});
  });
});

describe('context items for the consent sheet', () => {
  const geo: GeoLookup = (ip) => (ip === '77.88.8.8' ? { city: 'Moscow', country: 'RU' } : undefined);

  it('lists location, IP and browser in the app language', () => {
    expect(describeContext({ ip: '77.88.8.8', ua: CHROME_MAC }, 'ru', defaultMessages, geo)).toEqual([
      { name: 'Откуда', value: 'Moscow, Russia' },
      { name: 'IP-адрес', value: '77.88.8.8' },
      { name: 'Браузер', value: 'Chrome, macOS' },
    ]);
    expect(describeContext({ ip: '77.88.8.8', ua: CHROME_MAC }, 'en', defaultMessages, geo)[0]).toEqual({
      name: 'Location',
      value: 'Moscow, Russia',
    });
  });

  it('skips the location line without geo, never invents it', () => {
    expect(describeContext({ ip: '10.0.0.5', ua: 'curl/8.0' }, 'ru', defaultMessages)).toEqual([
      { name: 'IP-адрес', value: '10.0.0.5' },
      { name: 'Браузер', value: 'неизвестный браузер' },
    ]);
  });

  it('challenge v1 stays a bare code, v2 wraps code and items in JSON', () => {
    const ctx = { ip: '77.88.8.8', ua: CHROME_MAC };
    const describe = () => [{ name: 'IP', value: '77.88.8.8' }];
    expect(challengePlaintext('123456', ctx, 'ru', 1, describe)).toEqual({ plaintext: '123456', challenge: CHALLENGE_V1 });
    const v2 = challengePlaintext('123456', ctx, 'ru', 2, describe);
    expect(v2.challenge).toBe(CHALLENGE_V2);
    expect(JSON.parse(v2.plaintext)).toEqual({ code: '123456', items: [{ name: 'IP', value: '77.88.8.8' }] });
  });

  it('reads the announced challenge version leniently', () => {
    expect(challengeVersion(undefined)).toBe(1);
    expect(challengeVersion('2')).toBe(2);
    expect(challengeVersion('abc')).toBe(1);
    expect(challengeVersion(0)).toBe(1);
  });

  it('picks the language from Accept-Language', () => {
    expect(langFromAcceptLanguage('ru-RU,ru;q=0.9')).toBe('ru');
    expect(langFromAcceptLanguage('de')).toBe('en');
    expect(langFromAcceptLanguage(undefined)).toBe('en');
  });
});
