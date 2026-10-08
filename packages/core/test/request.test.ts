import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHALLENGE_V2,
  DEFAULT_SID_TTL_MS,
  KINDS,
  KIND_IDS,
  type Kind,
  LoginError,
  MAX_CODE_ATTEMPTS,
  SK_LOGIN_VERSION,
  SkDataRequest,
  decryptEnvelope,
  defaultMessages,
  deriveIdentityKeys,
  encryptEnvelope,
  extractArmor,
  generateMnemonic,
  type IdentityKeys,
  ownerKey,
  requestMeta,
  senderAddressFromArmor,
} from '../src/index.js';

const TARGET = 'demo.example';

// Fake app: sk-data-request, challenge parsing, sk-data with the code in
// meta and the values as JSON in text (protocol § 4.6).
class FakeApp {
  constructor(
    readonly keys: IdentityKeys,
    readonly serverAddress: string,
  ) {}

  request(sid: string, kind: string, challenge?: number): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: '',
      meta: requestMeta(TARGET, 'sk-data-request', sid, kind, undefined, challenge),
    });
  }

  codeFrom(challengeBody: string, sid: string, kind: string): string {
    const armored = extractArmor(challengeBody);
    const content = decryptEnvelope({ recipient: this.keys, armored });
    expect(senderAddressFromArmor(armored)).toBe(this.serverAddress);
    const meta = JSON.parse(content.meta!);
    expect(meta.type).toBe('sk-data-challenge');
    expect(meta.data).toEqual({ target: TARGET, v: SK_LOGIN_VERSION, sid, kind });
    expect(content.text.trim()).not.toBe('');
    return content.text.trim();
  }

  data(sid: string, kind: string, code: string, values: unknown, meta?: string): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: typeof values === 'string' ? values : JSON.stringify(values),
      meta: meta ?? requestMeta(TARGET, 'sk-data', sid, kind, code),
    });
  }

  /** "Cancel" on the confirmation sheet: meta without kind, as the app sends it. */
  cancel(sid: string): string {
    return encryptEnvelope({
      sender: this.keys,
      recipientAddress: this.serverAddress,
      plaintext: '',
      meta: JSON.stringify({ type: 'sk-data-cancel', data: { target: TARGET, v: SK_LOGIN_VERSION, sid } }),
    });
  }
}

/** A sample record of each kind, as the vault stores it. */
const samples: Record<Kind, Record<string, string>> = {
  'login-password': { site: 'example.com', login: 'ivan', password: 'p@ss' },
  'card-details': { holder: 'IVAN IVANOV', pan: '4111 1111 1111 1111', exp: '12/29', cvv: '123' },
  'personal-data': { name: 'Ivan Ivanov', birthdate: '1990-01-31', phone: '+7 900 000-00-00', email: 'ivan@example.com' },
};

let now = 1_800_000_000_000;
const clock = () => now;
let server: IdentityKeys;
let sk: SkDataRequest;
let app: FakeApp;
const owner = ownerKey('session-token-a');
const stranger = ownerKey('session-token-b');

beforeEach(() => {
  now = 1_800_000_000_000;
  server = deriveIdentityKeys(generateMnemonic());
  sk = new SkDataRequest({ identity: server, site: TARGET, now: clock });
  app = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
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

/** Steps 1-2 on behalf of the app: the code from the challenge. */
const challenge = async (sid: string, kind: Kind): Promise<string> => {
  const first = await sk.handleEnvelope(app.request(sid, kind));
  expect(first.kind).toBe('challenge');
  return app.codeFrom((first as { armored: string }).armored, sid, kind);
};

describe('data request flow', () => {
  it('issues a payload with kind the app can parse', async () => {
    const init = await sk.init('card-details', owner);
    const url = new URL(init.payloadUrl);
    expect(url.origin + url.pathname).toBe('https://secretkeeper.net/request');
    expect(url.searchParams.get('v')).toBe('1');
    expect(url.searchParams.get('site')).toBe(TARGET);
    expect(url.searchParams.get('address')).toBe(server.address);
    expect(url.searchParams.has('target')).toBe(false);
    expect(url.searchParams.get('sid')).toBe(init.sid);
    expect(url.searchParams.get('kind')).toBe('card-details');
    expect(init.schemeUrl).toBe(`sk://request?${url.search.slice(1)}`);
    expect(init.expiresAt - now).toBe(DEFAULT_SID_TTL_MS);
    expect(init.ttlMs).toBe(DEFAULT_SID_TTL_MS);
  });

  it('legacyTargets: the old embedded id in meta is accepted during the transition', async () => {
    const moved = new SkDataRequest({ identity: server, site: TARGET, legacyTargets: ['demo'], now: clock });
    const init = await moved.init('login-password', owner);
    const first = await moved.handleEnvelope(
      encryptEnvelope({
        sender: app.keys,
        recipientAddress: server.address,
        plaintext: '',
        meta: requestMeta('demo', 'sk-data-request', init.sid, 'login-password'),
      }),
    );
    expect(first.kind).toBe('challenge');
    expect((await moved.poll(init.sid, owner)).state).toBe('challenged');
  });

  for (const kind of KIND_IDS) {
    it(`fills ${kind} and hands the values to the owner once`, async () => {
      const { sid } = await sk.init(kind, owner);
      expect((await sk.poll(sid, owner)).state).toBe('new');
      const code = await challenge(sid, kind);
      expect((await sk.poll(sid, owner)).state).toBe('challenged');

      const reply = await sk.handleEnvelope(app.data(sid, kind, code, samples[kind]));
      expect(reply).toEqual({ kind: 'filled', address: app.keys.address });

      expect(await sk.poll(sid, owner)).toEqual({
        state: 'filled',
        values: samples[kind],
        sender: app.keys.address,
        filledAt: now,
      });
      // The second time the values are gone.
      expect((await sk.poll(sid, owner)).state).toBe('expired');
    });
  }

  it('accepts a partial record (empty fields are not sent)', async () => {
    const { sid } = await sk.init('personal-data', owner);
    const code = await challenge(sid, 'personal-data');
    await sk.handleEnvelope(app.data(sid, 'personal-data', code, { name: 'Ivan' }));
    expect(await sk.poll(sid, owner)).toMatchObject({ state: 'filled', values: { name: 'Ivan' } });
  });

  it('rejects data without a preceding request', async () => {
    const { sid } = await sk.init('login-password', owner);
    await failsWith(
      () => sk.handleEnvelope(app.data(sid, 'login-password', '000000', samples['login-password'])),
      409,
      'in-progress',
    );
  });

  it('rejects data from a different sender than the request', async () => {
    const { sid } = await sk.init('login-password', owner);
    const code = await challenge(sid, 'login-password');
    const other = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
    await failsWith(
      () => sk.handleEnvelope(other.data(sid, 'login-password', code, samples['login-password'])),
      409,
      'in-progress',
    );
  });

  it('limits wrong codes and then kills the request', async () => {
    const { sid } = await sk.init('login-password', owner);
    await challenge(sid, 'login-password');
    const wrong = () => sk.handleEnvelope(app.data(sid, 'login-password', '000000', samples['login-password']));
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) await failsWith(wrong, 400, 'code-invalid');
    await failsWith(wrong, 410, 'code-invalid');
    await failsWith(wrong, 404, 'sid-expired');
  });

  it('rejects a second request for the same sid', async () => {
    const { sid } = await sk.init('login-password', owner);
    await challenge(sid, 'login-password');
    await failsWith(() => sk.handleEnvelope(app.request(sid, 'login-password')), 409, 'in-progress');
  });

  it('rejects a kind other than the one issued, with a localized message', async () => {
    const { sid } = await sk.init('card-details', owner);
    const err = await failsWith(() => sk.handleEnvelope(app.request(sid, 'login-password'), 'ru'), 400, 'kind-mismatch');
    expect(err.message).toBe(defaultMessages.ru.kindMismatch);
    // The request is untouched: the right kind goes through.
    expect((await sk.poll(sid, owner)).state).toBe('new');
    const code = await challenge(sid, 'card-details');
    await failsWith(
      () => sk.handleEnvelope(app.data(sid, 'login-password', code, samples['login-password'])),
      400,
      'kind-mismatch',
    );
  });

  it('rejects values outside the kind dictionary, non-strings and non-JSON', async () => {
    const { sid } = await sk.init('card-details', owner);
    const code = await challenge(sid, 'card-details');
    const bad = (values: unknown) => () => sk.handleEnvelope(app.data(sid, 'card-details', code, values));
    await failsWith(bad({ ...samples['card-details'], pin: '1234' }), 400, 'kind-mismatch');
    await failsWith(bad({ cvv: 123 }), 400, 'kind-mismatch');
    await failsWith(bad('not json'), 400, 'kind-mismatch');
    await failsWith(bad(['a']), 400, 'kind-mismatch');
    // Malformed data does not burn the code: the request waits, the right envelope goes through.
    expect((await sk.poll(sid, owner)).state).toBe('challenged');
    await sk.handleEnvelope(app.data(sid, 'card-details', code, samples['card-details']));
    expect((await sk.poll(sid, owner)).state).toBe('filled');
  });

  it('answers challenge v2 with the browser context when the app asks for it', async () => {
    sk = new SkDataRequest({
      identity: server,
      target: TARGET,
      now: clock,
      describe: (ctx) => [{ name: 'Browser', value: ctx.ua }],
    });
    const { sid } = await sk.init('login-password', owner, { ip: '8.8.8.8', ua: 'Firefox' });
    const first = await sk.handleEnvelope(app.request(sid, 'login-password', 2));
    const armored = extractArmor((first as { armored: string }).armored);
    const content = decryptEnvelope({ recipient: app.keys, armored });
    expect(JSON.parse(content.meta!).data).toEqual({
      target: TARGET,
      v: SK_LOGIN_VERSION,
      sid,
      kind: 'login-password',
      challenge: CHALLENGE_V2,
    });
    const { code, items } = JSON.parse(content.text);
    expect(items).toEqual([{ name: 'Browser', value: 'Firefox' }]);
    await sk.handleEnvelope(app.data(sid, 'login-password', code, samples['login-password']));
    expect((await sk.poll(sid, owner)).state).toBe('filled');
  });

  it('restarts the TTL when the app scans (challenged)', async () => {
    const { sid } = await sk.init('login-password', owner);
    now += DEFAULT_SID_TTL_MS - 1;
    const code = await challenge(sid, 'login-password');
    now += DEFAULT_SID_TTL_MS - 1;
    expect((await sk.poll(sid, owner)).state).toBe('challenged');
    await sk.handleEnvelope(app.data(sid, 'login-password', code, samples['login-password']));
    expect((await sk.poll(sid, owner)).state).toBe('filled');
  });

  it('expires the sid after its TTL', async () => {
    const { sid } = await sk.init('login-password', owner);
    now += DEFAULT_SID_TTL_MS + 1;
    await failsWith(() => sk.handleEnvelope(app.request(sid, 'login-password')), 404, 'sid-expired');
    expect((await sk.poll(sid, owner)).state).toBe('expired');
  });

  it('cancels a challenged request on sk-data-cancel from the same sender', async () => {
    const { sid } = await sk.init('login-password', owner);
    const code = await challenge(sid, 'login-password');
    expect(await sk.handleEnvelope(app.cancel(sid))).toEqual({ kind: 'cancelled' });
    expect(await sk.poll(sid, owner)).toEqual({ state: 'cancelled' });
    await failsWith(
      () => sk.handleEnvelope(app.data(sid, 'login-password', code, samples['login-password'])),
      409,
      'in-progress',
    );
    await failsWith(() => sk.handleEnvelope(app.cancel(sid)), 409, 'in-progress');
    expect(await sk.poll(sid, owner)).toEqual({ state: 'cancelled' });
  });

  it('ignores a cancel from another sender or before the request', async () => {
    const { sid } = await sk.init('login-password', owner);
    await failsWith(() => sk.handleEnvelope(app.cancel(sid)), 409, 'in-progress');
    const code = await challenge(sid, 'login-password');
    const other = new FakeApp(deriveIdentityKeys(generateMnemonic()), server.address);
    await failsWith(() => sk.handleEnvelope(other.cancel(sid)), 409, 'in-progress');
    expect(await sk.poll(sid, owner)).toEqual({ state: 'challenged' });
    expect(await sk.handleEnvelope(app.data(sid, 'login-password', code, samples['login-password']))).toEqual({
      kind: 'filled',
      address: app.keys.address,
    });
  });

  it('rejects garbage, envelopes for another server, another target and meta without kind', async () => {
    const { sid } = await sk.init('login-password', owner);
    await failsWith(() => sk.handleEnvelope('hello'), 400, 'bad-envelope');

    const other = deriveIdentityKeys(generateMnemonic());
    const notForUs = encryptEnvelope({
      sender: app.keys,
      recipientAddress: other.address,
      plaintext: '',
      meta: requestMeta(TARGET, 'sk-data-request', sid, 'login-password'),
    });
    await failsWith(() => sk.handleEnvelope(notForUs), 400, 'bad-envelope');

    const otherTarget = encryptEnvelope({
      sender: app.keys,
      recipientAddress: server.address,
      plaintext: '',
      meta: requestMeta('someone-else', 'sk-data-request', sid, 'login-password'),
    });
    await failsWith(() => sk.handleEnvelope(otherTarget), 400, 'bad-meta');

    const noKind = encryptEnvelope({
      sender: app.keys,
      recipientAddress: server.address,
      plaintext: '',
      meta: JSON.stringify({ type: 'sk-data-request', data: { target: TARGET, v: 1, sid } }),
    });
    await failsWith(() => sk.handleEnvelope(noKind), 400, 'bad-meta');

    const loginEnvelope = encryptEnvelope({
      sender: app.keys,
      recipientAddress: server.address,
      plaintext: '',
      meta: JSON.stringify({ type: 'sk-login', data: { target: TARGET, v: 1, sid, kind: 'login-password' } }),
    });
    await failsWith(() => sk.handleEnvelope(loginEnvelope), 400, 'bad-meta');
    expect((await sk.poll(sid, owner)).state).toBe('new');
  });

  it('hides the request from a session other than its owner', async () => {
    const { sid } = await sk.init('card-details', owner);
    const code = await challenge(sid, 'card-details');
    await sk.handleEnvelope(app.data(sid, 'card-details', code, samples['card-details']));
    expect((await sk.poll(sid, stranger)).state).toBe('expired');
    // The owner still gets the values: a stranger's poll did not burn them.
    expect((await sk.poll(sid, owner)).state).toBe('filled');
  });

  it('keeps the kind dictionaries as agreed with the app', () => {
    expect(KINDS['login-password']).toEqual(['site', 'login', 'password']);
    expect(KINDS['card-details']).toEqual(['holder', 'pan', 'exp', 'cvv', 'billingAddress']);
    expect(KINDS['personal-data']).toEqual(['name', 'birthdate', 'phone', 'email', 'address']);
  });
});
