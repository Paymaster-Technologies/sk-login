// Request context for challenge v2: who received the sid. The server
// collects it on init (IP behind the proxy, User-Agent, Client Hints) and
// puts it into the encrypted challenge as a name-value list in the app's
// language, so that the person on the consent sheet sees whose environment
// this is before confirming the sign-in (QRLjacking protection: an attacker
// with a phishing page cannot tamper with the contents of an envelope
// addressed to the victim).
//
// Challenge format (secret_keeper/docs/protocol.md § 4.5, "Request context
// in the challenge (v2)"). Negotiated via the `challenge` field in
// meta.data; the `v` field stays the protocol version (1):
//   v1 - the app did not send `challenge` (older builds):
//        plaintext = the code, as always;
//   v2 - the app sent `challenge: 2` in the step 1 request: the server
//        replies with `challenge: 2` in meta.data and plaintext = JSON
//        {"code", "items": [{"name", "value"}]}.

import type { Lang, Messages } from './i18n.js';

/** What the server knows about the browser that received the sid. */
export interface RequestContext {
  /** Public IP of the browser. */
  ip: string;
  ua: string;
  /** Sec-CH-UA-Platform without quotes, if the browser sent it. */
  platform?: string;
}

export interface ContextItem {
  name: string;
  value: string;
}

/** Lines for the sheet derived from the context; localized on the server side. */
export type Describe = (ctx: RequestContext, lang: Lang) => ContextItem[];

export const CHALLENGE_V1 = 1;
export const CHALLENGE_V2 = 2;

/** Challenge version from the request's meta.data: no field or garbage means v1. */
export function challengeVersion(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= CHALLENGE_V1 ? n : CHALLENGE_V1;
}

/** Geo by IP: city (in Latin script, as in the databases) and ISO 3166-1 country code. */
export type GeoLookup = (ip: string) => { city?: string; country?: string } | undefined;

/** Framework-agnostic access to request headers. */
export type HeaderGetter = (name: string) => string | string[] | null | undefined;

/**
 * Context from the incoming init request. `remoteAddress` is the connection
 * address, needed only without a proxy (dev). `trustForwarded`: our proxy
 * appends the client address to the end of X-Forwarded-For; everything
 * before it was sent by the client itself and deserves no trust; without a
 * proxy the header is ignored.
 */
export function contextFromHeaders(
  header: HeaderGetter,
  remoteAddress?: string,
  trustForwarded = true,
): RequestContext {
  const one = (name: string) => {
    const v = header(name);
    return Array.isArray(v) ? v.join(', ') : (v ?? null);
  };
  const ctx: RequestContext = {
    ip: clientIp(trustForwarded ? one('x-forwarded-for') : null, remoteAddress),
    ua: one('user-agent') ?? '',
  };
  const platform = one('sec-ch-ua-platform');
  if (platform) ctx.platform = platform.replace(/^"|"$/g, '');
  return ctx;
}

/** Last X-Forwarded-For entry (appended by our proxy), otherwise the connection address. */
export function clientIp(forwardedFor: string | null, remoteAddress?: string): string {
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = chain.at(-1);
  return last ?? stripIpv6Prefix(remoteAddress ?? '');
}

/** Node reports IPv4 connections as ::ffff:1.2.3.4. */
function stripIpv6Prefix(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Plaintext and challenge version matching what the app understands
 *  (`wants` is its `challenge` from the request). We do not go above v2:
 *  we answer with v2. Without a context (a request without init, a test)
 *  v2 goes out with an empty list: the app then does not ask for
 *  confirmation. */
export function challengePlaintext(
  code: string,
  ctx: RequestContext | undefined,
  lang: Lang,
  wants: number,
  describe: Describe,
): { plaintext: string; challenge: number } {
  if (wants < CHALLENGE_V2) return { plaintext: code, challenge: CHALLENGE_V1 };
  const items = ctx ? describe(ctx, lang) : [];
  return { plaintext: JSON.stringify({ code, items }), challenge: CHALLENGE_V2 };
}

/**
 * Context description for the sheet: location (city, country), IP, browser
 * and OS. No lines without data: no geo means no "Location" line. `geo` is
 * any IP database (e.g. the DB-IP mmdb); without it the "Location" line
 * never appears.
 */
export function describeContext(
  ctx: RequestContext,
  lang: Lang,
  messages: Record<Lang, Messages>,
  geo?: GeoLookup,
): ContextItem[] {
  const t = messages[lang];
  const items: ContextItem[] = [];
  const place = geo?.(ctx.ip);
  if (place) {
    const country = place.country ? regionName(place.country) : undefined;
    const where = [place.city, country].filter(Boolean).join(', ');
    if (where) items.push({ name: t.from, value: where });
  }
  if (ctx.ip) items.push({ name: t.ip, value: ctx.ip });
  const { browser, os } = parseUserAgent(ctx.ua, ctx.platform);
  items.push({ name: t.browser, value: [browser ?? t.unknownBrowser, os].filter(Boolean).join(', ') });
  return items;
}

/** Country name by code. Always in English: the city from geo databases is
 *  in Latin script, and a Latin city next to a Cyrillic country name reads
 *  worse than "Moscow, Russia". */
function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Browser and OS from the User-Agent; the Client Hints platform is more
 *  reliable than the UA string (Chromium freezes it), so it takes priority.
 *  The table is small and our own: we need recognizable words, not a full
 *  classification. */
export function parseUserAgent(ua: string, platform?: string): { browser?: string; os?: string } {
  let browser: string | undefined;
  if (/\bEdg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/\bYaBrowser\//.test(ua)) browser = 'Yandex Browser';
  else if (/\bOPR\//.test(ua) || /\bOpera\b/.test(ua)) browser = 'Opera';
  else if (/\bSamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/\bFirefox\//.test(ua) || /\bFxiOS\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\//.test(ua) || /\bCriOS\//.test(ua)) browser = 'Chrome';
  else if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) browser = 'Safari';

  let os: string | undefined;
  if (platform) os = normalizePlatform(platform);
  else if (/\bWindows NT\b/.test(ua)) os = 'Windows';
  else if (/\bAndroid\b/.test(ua)) os = 'Android';
  else if (/\b(iPhone|iPad|iPod)\b/.test(ua)) os = 'iOS';
  else if (/\bMac OS X\b/.test(ua)) os = 'macOS';
  else if (/\bCrOS\b/.test(ua)) os = 'ChromeOS';
  else if (/\bLinux\b/.test(ua)) os = 'Linux';
  return { browser, os };
}

function normalizePlatform(platform: string): string {
  const map: Record<string, string> = { 'Chrome OS': 'ChromeOS', Chromium: 'Linux' };
  return map[platform] ?? platform;
}
