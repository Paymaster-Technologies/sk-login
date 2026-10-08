import { beforeEach, describe, expect, it } from 'vitest';

import {
  type AccessDecision,
  CHALLENGE_V2,
  type ContextItem,
  DEFAULT_SID_TTL_MS,
  type EnvelopeReply,
  LoginError,
  MAX_CODE_ATTEMPTS,
  MemoryPendingStore,
  type RequestContext,
  SK_LOGIN_VERSION,
  SkLogin,
  decryptEnvelope,
  defaultMessages,
  deriveIdentityKeys,
  encryptEnvelope,
  extractArmor,
  generateMnemonic,
  type IdentityKeys,
  keyCheckDigits,
  loginMeta,
  senderAddressFromArmor,
} from '../src/index.js';

/** The site's host: the QR carries it with the server address, meta.data.target repeats it. */
const TARGET = 'demo.example';

// Fake client: does exactly what `sendSkLogin` in the app's
// lib/services/sk_login.dart does: request, challenge parsing, code.
class FakeApp {
  constructor(
    readonly keys: IdentityKeys,
    readonly serverAddress: string,
  ) {}

  request(sid: string, challenge?: number): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: '',
      meta: loginMeta(TARGET, 'sk-login', sid, challenge),
    });
  }

  codeFrom(challengeBody: string, sid: string): string {
    const { text, meta } = this.openChallenge(challengeBody);
    expect(meta.data).toEqual({ target: TARGET, v: SK_LOGIN_VERSION, sid });
    expect(text).not.toBe('');
    return text;
  }

  challengeV2From(challengeBody: string, sid: string): { code: string; items: ContextItem[] } {
    const { text, meta } = this.openChallenge(challengeBody);
    expect(meta.data).toEqual({ target: TARGET, v: SK_LOGIN_VERSION, sid, challenge: CHALLENGE_V2 });
    return JSON.parse(text);
  }

  private openChallenge(challengeBody: string): { text: string; meta: { type: string; data: unknown } } {
    const armored = extractArmor(challengeBody);
    const content = decryptEnvelope({ recipient: this.keys, armored });
    expect(senderAddressFromArmor(armored)).toBe(this.serverAddress);
    const meta = JSON.parse(content.meta!);
    expect(meta.type).toBe('sk-login-challenge');
    return { text: content.text.trim(), meta };
  }

  codeEnvelope(sid: string, code: string): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: code,
      meta: loginMeta(TARGET, 'sk-login-code', sid),
    });
  }

  cancel(sid: string): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: '',
      meta: loginMeta(TARGET, 'sk-login-cancel', sid),
    });
  }
}

interface User {
  address: string;
  status: 'active' | 'blocked';
}

let now = 1_800_000_000_000;
const clock = () => now;
let server: IdentityKeys;
let login: SkLogin<User>;
let app: FakeApp;
let allowed: Map<string, User>;
let decisions: string[];

const userOf = (address: string): User => ({ address, status: 'active' });

const access = async (address: string): Promise<AccessDecision<User>> => {
  decisions.push(address);
  const user = allowed.get(address);
  if (!user) return { kind: 'denied', reason: 'unknown' };
  if (user.status === 'blocked') return { kind: 'denied', reason: 'blocked', message: { ru: 'Blocked (ru)' } };
  return { kind: 'granted', user };
};

const make = (extra: Partial<ConstructorParameters<typeof SkLogin<User>>[0]> = {}) =>
  new SkLogin<User>({ identity: server, site: TARGET, access, now: clock, ...extra });

beforeEach(() => {
  now = 1_800_000_000_000;
  server = deriveIdentityKeys(generateMnemonic());
  login = make();
  app = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
  allowed = new Map([[app.keys.address, userOf(app.keys.address)]]);
  decisions = [];
});

const failsWith = async (fn: () => Promise<unknown>, status: number, code?: string): Promise<LoginError> => {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LoginError);
    expect((e as LoginError).status).toBe(status);
    if (code) expect((e as LoginError).code).toBe(code);
    return e as LoginError;
  }
  throw new Error(`expected LoginError ${status}`);
};

const armoredOf = (r: EnvelopeReply) => (r as { kind: 'challenge'; armored: string }).armored;
const state = async (sid: string) => (await login.poll(sid)).state;

describe('sign-in flow', () => {
  it('issues a payload the app can parse', async () => {
    const init = await login.init();
    const url = new URL(init.payloadUrl);
    expect(url.origin + url.pathname).toBe('https://secretkeeper.net/auth');
    expect(url.searchParams.get('v')).toBe(String(SK_LOGIN_VERSION));
    // The site and its server address: the app derives https://<site>/sk/login and encrypts to the address.
    expect(url.searchParams.get('site')).toBe(TARGET);
    expect(url.searchParams.get('address')).toBe(server.address);
    expect(url.searchParams.has('target')).toBe(false);
    expect(url.searchParams.get('sid')).toBe(init.sid);
    expect(init.schemeUrl).toBe(`sk://auth?${url.search.slice(1)}`);
    expect(init.ttlMs).toBe(DEFAULT_SID_TTL_MS);
    expect(init.expiresAt).toBe(now + DEFAULT_SID_TTL_MS);
  });

  it('the site host is normalised and must be in the form the app accepts', async () => {
    expect(make({ site: ' Demo.Example ' }).target).toBe(TARGET);
    for (const bad of ['https://demo.example', 'demo.example/sk', 'demo.example:8443', 'localhost', '10.0.0.1', 'demo', 'bücher.example']) {
      expect(() => make({ site: bad })).toThrow(/bare ASCII host/);
    }
    expect(() => make({ site: 'xn--e1afmkfd.xn--p1ai' })).not.toThrow();
    expect(() => new SkLogin<User>({ identity: server, access, now: clock })).toThrow(/exactly one/);
    expect(() => make({ target: 'tetatet' })).toThrow(/exactly one/);
  });

  it('an embedded target keeps the older payload form', async () => {
    const embedded = new SkLogin<User>({ identity: server, target: 'tetatet', access, now: clock });
    const init = await embedded.init();
    const url = new URL(init.payloadUrl);
    expect(url.searchParams.get('target')).toBe('tetatet');
    expect(url.searchParams.has('site')).toBe(false);
    expect(url.searchParams.has('address')).toBe(false);
    expect(embedded.target).toBe('tetatet');
    expect(embedded.site).toBeUndefined();
  });

  it('legacyTargets: envelopes from app builds that still send the old embedded id are accepted', async () => {
    const moved = make({ legacyTargets: ['demo'] });
    const old = new FakeApp(app.keys, server.address);
    const { sid } = await moved.init();
    const request = (target: string) =>
      encryptEnvelope({
        sender: old.keys,
        recipientAddress: server.address,
        plaintext: '',
        meta: loginMeta(target, 'sk-login', sid),
      });
    await failsWith(() => moved.handleEnvelope(request('other.example')), 400, 'bad-meta');
    expect((await moved.handleEnvelope(request('demo'))).kind).toBe('challenge');
    // Without the option the old id is just another service.
    const strict = make();
    const fresh = await strict.init();
    await failsWith(
      () =>
        strict.handleEnvelope(
          encryptEnvelope({ sender: old.keys, recipientAddress: server.address, plaintext: '', meta: loginMeta('demo', 'sk-login', fresh.sid) }),
        ),
      400,
      'bad-meta',
    );
  });

  it('targetInfo publishes the service information', () => {
    expect(login.targetInfo('https://demo.example/sk/login', 'https://demo.example/sk/request')).toEqual({
      id: TARGET,
      site: TARGET,
      v: SK_LOGIN_VERSION,
      url: 'https://demo.example/sk/login',
      requestUrl: 'https://demo.example/sk/request',
      serverAddress: server.address,
      checkDigits: keyCheckDigits(server.x25519Public),
    });
  });

  it('two-step: request → challenge → code → authenticated once', async () => {
    const { sid } = await login.init();
    expect(await state(sid)).toBe('new');

    const first = await login.handleEnvelope(app.request(sid));
    expect(first.kind).toBe('challenge');
    expect(await state(sid)).toBe('challenged');

    const code = app.codeFrom(armoredOf(first), sid);
    const second = await login.handleEnvelope(app.codeEnvelope(sid, code));
    expect(second).toEqual({ kind: 'code-accepted', address: app.keys.address });

    expect(await login.poll(sid)).toEqual({ state: 'authenticated', user: userOf(app.keys.address) });
    expect(await state(sid)).toBe('expired');
    expect(decisions).toEqual([app.keys.address]);
  });

  it('refuses an unknown address at the code step with a localized message', async () => {
    allowed.clear();
    const { sid } = await login.init();
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    const err = await failsWith(() => login.handleEnvelope(app.codeEnvelope(sid, code), 'ru'), 403, 'access-denied');
    expect(err.message).toBe(defaultMessages.ru.accessDenied);
    expect(err.reason).toBe('unknown');
    expect(await login.poll(sid)).toEqual({ state: 'denied', reason: 'unknown' });
    expect(decisions).toEqual([app.keys.address]);
  });

  it('uses the message from the access decision and falls back to en', async () => {
    allowed.set(app.keys.address, { address: app.keys.address, status: 'blocked' });
    const { sid } = await login.init();
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    const err = await failsWith(() => login.handleEnvelope(app.codeEnvelope(sid, code), 'ru'), 403, 'access-denied');
    expect(err.message).toBe('Blocked (ru)');
    expect(await login.poll(sid)).toEqual({ state: 'denied', reason: 'blocked' });

    const { sid: sid2 } = await login.init();
    const f2 = await login.handleEnvelope(app.request(sid2));
    const err2 = await failsWith(() => login.handleEnvelope(app.codeEnvelope(sid2, app.codeFrom(armoredOf(f2), sid2))), 403);
    // The decision has no text for en: the generic default text is used.
    expect(err2.message).toBe(defaultMessages.en.accessDenied);
  });

  it('service overrides the default refusal text', async () => {
    allowed.clear();
    login = make({ messages: { en: { accessDenied: 'Ask the admin' } } });
    const { sid } = await login.init();
    const first = await login.handleEnvelope(app.request(sid));
    const err = await failsWith(() => login.submitCode(sid, app.codeFrom(armoredOf(first), sid)), 403, 'access-denied');
    expect(err.message).toBe('Ask the admin');
    expect(await state(sid)).toBe('denied');
  });

  it('accepts the code typed into the browser', async () => {
    const { sid } = await login.init();
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    expect(await login.submitCode(sid, ` ${code} `)).toEqual(userOf(app.keys.address));
    expect(await state(sid)).toBe('expired');
    expect(decisions).toEqual([app.keys.address]);
  });

  it('limits wrong code attempts and then kills the request', async () => {
    const { sid } = await login.init();
    await login.handleEnvelope(app.request(sid));
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) await failsWith(() => login.submitCode(sid, '000000'), 400, 'code-invalid');
    await failsWith(() => login.submitCode(sid, '000000'), 410, 'code-invalid');
    await failsWith(() => login.submitCode(sid, '000000'), 404, 'sid-expired');
    expect(decisions).toEqual([]);
  });

  it('rejects the code from a different sender and a second request for the same sid', async () => {
    const { sid } = await login.init();
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    const other = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
    await failsWith(() => login.handleEnvelope(other.codeEnvelope(sid, code)), 409, 'in-progress');
    await failsWith(() => login.handleEnvelope(app.request(sid)), 409, 'in-progress');
  });

  it('answers challenge v2 with the browser context when the app asks for it', async () => {
    const seen: RequestContext[] = [];
    login = make({
      describe: (ctx, lang) => {
        seen.push(ctx);
        return [{ name: lang === 'ru' ? 'IP address (ru)' : 'IP address', value: ctx.ip }];
      },
    });
    const ctx: RequestContext = { ip: '77.88.8.8', ua: 'Mozilla/5.0 Chrome/140', platform: 'macOS' };
    const { sid } = await login.init(ctx);
    const first = await login.handleEnvelope(app.request(sid, 2), 'ru');
    const { code, items } = app.challengeV2From(armoredOf(first), sid);
    expect(seen).toEqual([ctx]);
    expect(items).toEqual([{ name: 'IP address (ru)', value: '77.88.8.8' }]);
    await login.handleEnvelope(app.codeEnvelope(sid, code));
    expect(await state(sid)).toBe('authenticated');
  });

  it('default describe lists IP and browser; v1 stays a bare code', async () => {
    const { sid } = await login.init({ ip: '77.88.8.8', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36' });
    const first = await login.handleEnvelope(app.request(sid, 2), 'en');
    const { items } = app.challengeV2From(armoredOf(first), sid);
    expect(items).toEqual([
      { name: 'IP address', value: '77.88.8.8' },
      { name: 'Browser', value: 'Chrome, Windows' },
    ]);

    const { sid: sid2 } = await login.init({ ip: '77.88.8.8', ua: 'Chrome' });
    const f2 = await login.handleEnvelope(app.request(sid2));
    expect(app.codeFrom(armoredOf(f2), sid2)).toMatch(/^\d{6}$/);
  });

  it('restarts the TTL when the app scans and expires otherwise', async () => {
    const { sid } = await login.init();
    now += DEFAULT_SID_TTL_MS - 1;
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    now += DEFAULT_SID_TTL_MS - 1;
    expect(await state(sid)).toBe('challenged');
    await login.handleEnvelope(app.codeEnvelope(sid, code));
    expect(await state(sid)).toBe('authenticated');

    const { sid: sid2 } = await login.init();
    now += DEFAULT_SID_TTL_MS + 1;
    await failsWith(() => login.handleEnvelope(app.request(sid2)), 404, 'sid-expired');
    expect(await state(sid2)).toBe('expired');
  });

  it('custom ttl is honoured', async () => {
    login = make({ ttlMs: 10_000 });
    const init = await login.init();
    expect(init.ttlMs).toBe(10_000);
    now += 10_001;
    expect(await state(init.sid)).toBe('expired');
  });

  it('cancels a challenged request from the same sender only, visible one more TTL', async () => {
    const { sid } = await login.init();
    await failsWith(() => login.handleEnvelope(app.cancel(sid)), 409, 'in-progress');
    const first = await login.handleEnvelope(app.request(sid));
    const code = app.codeFrom(armoredOf(first), sid);
    const other = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
    await failsWith(() => login.handleEnvelope(other.cancel(sid)), 409, 'in-progress');
    expect(await login.handleEnvelope(app.cancel(sid))).toEqual({ kind: 'cancelled' });
    expect(await state(sid)).toBe('cancelled');
    await failsWith(() => login.handleEnvelope(app.codeEnvelope(sid, code)), 409, 'in-progress');
    await failsWith(() => login.submitCode(sid, code), 409, 'in-progress');
    now += DEFAULT_SID_TTL_MS + 1;
    expect(await state(sid)).toBe('cancelled');
    now += DEFAULT_SID_TTL_MS;
    expect(await state(sid)).toBe('expired');
    expect(decisions).toEqual([]);
  });

  it('rejects envelopes for another server, target or version, and garbage', async () => {
    const { sid } = await login.init();
    await failsWith(() => login.handleEnvelope('hello'), 400, 'bad-envelope');
    const stranger = deriveIdentityKeys(generateMnemonic());
    const notForUs = encryptEnvelope({
      sender: app.keys,
      recipientAddress: stranger.address,
      plaintext: '',
      meta: loginMeta(TARGET, 'sk-login', sid),
    });
    await failsWith(() => login.handleEnvelope(notForUs), 400, 'bad-envelope');
    const otherTarget = encryptEnvelope({
      sender: app.keys,
      recipientAddress: server.address,
      plaintext: '',
      meta: JSON.stringify({ type: 'sk-login', data: { target: 'tetatet', v: 1, sid } }),
    });
    await failsWith(() => login.handleEnvelope(otherTarget), 400, 'bad-meta');
    const plainMessage = encryptEnvelope({ sender: app.keys, recipientAddress: server.address, plaintext: 'hi' });
    await failsWith(() => login.handleEnvelope(plainMessage), 400, 'bad-meta');
    expect(await state(sid)).toBe('new');
  });

  it('works through a JSON round-tripping store (as Redis would)', async () => {
    // A store that loses references: every record is serialized.
    const inner = new MemoryPendingStore<User>(clock);
    login = make({
      store: {
        get: async (sid) => {
          const e = await inner.get(sid);
          return e && JSON.parse(JSON.stringify(e));
        },
        set: (e, ttl) => inner.set(JSON.parse(JSON.stringify(e)), ttl),
        delete: (sid) => inner.delete(sid),
      },
    });
    const { sid } = await login.init({ ip: '1.2.3.4', ua: 'x' });
    const first = await login.handleEnvelope(app.request(sid));
    await login.handleEnvelope(app.codeEnvelope(sid, app.codeFrom(armoredOf(first), sid)));
    expect(await login.poll(sid)).toEqual({ state: 'authenticated', user: userOf(app.keys.address) });
    expect(inner.size).toBe(0);
  });
});
