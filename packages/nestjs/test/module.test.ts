import 'reflect-metadata';

import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AccessDecision,
  decryptEnvelope,
  deriveIdentityKeys,
  encryptEnvelope,
  extractArmor,
  generateMnemonic,
  type IdentityKeys,
  loginMeta,
  ownerKey,
  requestMeta,
} from '@paymastech/sk-login-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SkLoginModule, SkLoginService } from '../src/index.js';

/** The site host: in the QR with the server address, in meta.data.target of every envelope. */
const TARGET = 'demo.example';
const MNEMONIC = generateMnemonic();

interface User {
  address: string;
}

let app: INestApplication;
let server: IdentityKeys;
const phone = deriveIdentityKeys(generateMnemonic());
let blocked = false;
const authenticated: User[] = [];

const envelope = (type: string, sid: string, plaintext = '', challenge?: number) =>
  encryptEnvelope({
    sender: phone,
    recipientAddress: server.address,
    plaintext,
    meta: loginMeta(TARGET, type, sid, challenge),
  });

const openChallenge = (body: string) => {
  const armored = extractArmor(body);
  const content = decryptEnvelope({ recipient: phone, armored });
  return { text: content.text.trim(), meta: JSON.parse(content.meta!) };
};

beforeAll(async () => {
  @Module({
    imports: [
      SkLoginModule.forRootAsync<User>({
        routePrefix: 'auth/sk',
        useFactory: () => ({
          mnemonic: MNEMONIC,
          target: { site: TARGET, legacyTargets: ['demo'], publicUrl: 'https://api.example.com/' },
          access: async (address): Promise<AccessDecision<User>> =>
            blocked ? { kind: 'denied', reason: 'blocked', message: { en: 'Nope' } } : { kind: 'granted', user: { address } },
          onAuthenticated: (user, { res }) => {
            authenticated.push(user);
            res.header('set-cookie', `session=${user.address}; Path=/; HttpOnly`);
            return { token: `t-${user.address.slice(0, 8)}` };
          },
        }),
      }),
    ],
  })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = deriveIdentityKeys(MNEMONIC);
  expect(app.get(SkLoginService).serverAddress).toBe(server.address);
});

afterAll(async () => {
  await app.close();
});

describe('SkLoginModule over HTTP', () => {
  it('target describes the service: the endpoint the app derives from the host', async () => {
    const r = await request(app.getHttpServer()).get('/auth/sk/target').expect(200);
    expect(r.body).toEqual({
      id: TARGET,
      site: TARGET,
      v: 1,
      url: 'https://api.example.com/sk/login',
      serverAddress: server.address,
      checkDigits: expect.stringMatching(/^\d{5}( \d{5}){4}$/),
    });
  });

  it('the QR carries the site and the server address; the app posts to /sk/login at the root', async () => {
    const http = request(app.getHttpServer());
    const init = await http.post('/auth/sk/init').expect(200);
    const url = new URL(init.body.payloadUrl);
    expect(url.searchParams.get('site')).toBe(TARGET);
    expect(url.searchParams.get('address')).toBe(server.address);
    expect(url.searchParams.has('target')).toBe(false);
    const sid = init.body.sid;
    const ch = await http.post('/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', sid)).expect(200);
    expect(openChallenge(ch.text).meta.data.target).toBe(TARGET);
    expect((await http.get(`/auth/sk/status?sid=${sid}`)).body).toEqual({ state: 'challenged' });
    // An older app build with the embedded id posts the old target to the old alias.
    const { sid: sid2 } = (await http.post('/auth/sk/init')).body;
    const old = encryptEnvelope({ sender: phone, recipientAddress: server.address, plaintext: '', meta: loginMeta('demo', 'sk-login', sid2) });
    await http.post('/auth/sk/login').set('content-type', 'text/plain').send(old).expect(200);
    expect((await http.get(`/auth/sk/status?sid=${sid2}`)).body).toEqual({ state: 'challenged' });
  });

  it('an embedded target keeps the older payload form', async () => {
    @Module({
      imports: [
        SkLoginModule.forRoot<User>({
          mnemonic: MNEMONIC,
          target: { id: 'tetatet', publicUrl: 'https://api.example.com/' },
          access: async (address): Promise<AccessDecision<User>> => ({ kind: 'granted', user: { address } }),
        }),
      ],
    })
    class EmbeddedModule {}
    const ref = await Test.createTestingModule({ imports: [EmbeddedModule] }).compile();
    const embeddedApp = ref.createNestApplication();
    await embeddedApp.init();
    try {
      const http = request(embeddedApp.getHttpServer());
      const target = await http.get('/api/sk/target').expect(200);
      expect(target.body.id).toBe('tetatet');
      expect(target.body.site).toBeUndefined();
      const init = await http.post('/api/sk/init').expect(200);
      const url = new URL(init.body.payloadUrl);
      expect(url.searchParams.get('target')).toBe('tetatet');
      expect(url.searchParams.has('site')).toBe(false);
    } finally {
      await embeddedApp.close();
    }
  });

  it('full flow: init → envelope → challenge → code → status with session', async () => {
    const http = request(app.getHttpServer());
    const init = await http
      .post('/auth/sk/init')
      .set('user-agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36')
      .set('x-forwarded-for', '203.0.113.9')
      .expect(200);
    const { sid, payloadUrl, schemeUrl, ttlMs, qrSvg } = init.body;
    expect(payloadUrl).toContain(`site=${TARGET}`);
    expect(schemeUrl.startsWith('sk://auth?')).toBe(true);
    expect(ttlMs).toBe(120_000);
    expect(qrSvg).toContain('<svg');

    expect((await http.get(`/auth/sk/status?sid=${sid}`).expect(200)).body).toEqual({ state: 'new' });

    // The app: a request with challenge v2, text/plain, no body parser on the server.
    const ch = await http
      .post('/auth/sk/login')
      .set('content-type', 'text/plain')
      .set('accept-language', 'ru')
      .send(envelope('sk-login', sid, '', 2))
      .expect(200);
    expect(ch.headers['content-type']).toMatch(/text\/plain/);
    const { text, meta } = openChallenge(ch.text);
    expect(meta).toEqual({ type: 'sk-login-challenge', data: { target: TARGET, v: 1, sid, challenge: 2 } });
    const { code, items } = JSON.parse(text);
    expect(items).toEqual([
      { name: 'IP-адрес', value: '203.0.113.9' },
      { name: 'Браузер', value: 'Chrome, Windows' },
    ]);
    expect((await http.get(`/auth/sk/status?sid=${sid}`)).body).toEqual({ state: 'challenged' });

    const ok = await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login-code', sid, code)).expect(200);
    expect(ok.body).toEqual({ sent: true });

    const done = await http.get(`/auth/sk/status?sid=${sid}`).expect(200);
    expect(done.body).toEqual({ state: 'authenticated', token: `t-${phone.address.slice(0, 8)}` });
    expect(done.headers['set-cookie'][0]).toContain(`session=${phone.address}`);
    expect(authenticated).toEqual([{ address: phone.address }]);
    // A second poll does not hand out a session.
    expect((await http.get(`/auth/sk/status?sid=${sid}`)).body).toEqual({ state: 'expired' });
  });

  it('manual code and cancel paths, refusal JSON for the app', async () => {
    const http = request(app.getHttpServer());
    const { sid } = (await http.post('/auth/sk/init')).body;
    const ch = await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', sid)).expect(200);
    const code = openChallenge(ch.text).text;

    expect((await http.post('/auth/sk/code').send({ sid, code: '000000' }).expect(400)).body).toEqual({ error: 'code-invalid' });
    const ok = await http.post('/auth/sk/code').send({ sid, code }).expect(200);
    expect(ok.body).toEqual({ ok: true, token: `t-${phone.address.slice(0, 8)}` });

    // Cancel from the app.
    const { sid: sid2 } = (await http.post('/auth/sk/init')).body;
    await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', sid2)).expect(200);
    await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login-cancel', sid2)).expect(204);
    expect((await http.get(`/auth/sk/status?sid=${sid2}`)).body).toEqual({ state: 'cancelled' });

    // Garbage and an unknown sid.
    expect((await http.post('/auth/sk/login').set('content-type', 'text/plain').send('hello').expect(400)).body).toEqual({
      error: 'bad-envelope',
      message: expect.any(String),
    });
    expect((await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', 'nope')).expect(404)).body.error).toBe(
      'sid-expired',
    );
    expect((await http.post('/auth/sk/code').send({ sid: 1 }).expect(400)).body).toEqual({ error: 'bad-json' });
    expect((await http.get('/auth/sk/status')).body).toEqual({ state: 'expired' });
  });

  it('access denied: 403 for the app with the service message, denied state for the browser', async () => {
    blocked = true;
    try {
      const http = request(app.getHttpServer());
      const { sid } = (await http.post('/auth/sk/init')).body;
      const ch = await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', sid)).expect(200);
      const code = openChallenge(ch.text).text;
      const r = await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login-code', sid, code)).expect(403);
      expect(r.body).toEqual({ error: 'access-denied', message: 'Nope' });
      expect((await http.get(`/auth/sk/status?sid=${sid}`)).body).toEqual({ state: 'denied', reason: 'blocked' });

      const { sid: sid2 } = (await http.post('/auth/sk/init')).body;
      const ch2 = await http.post('/auth/sk/login').set('content-type', 'text/plain').send(envelope('sk-login', sid2)).expect(200);
      const r2 = await http.post('/auth/sk/code').send({ sid: sid2, code: openChallenge(ch2.text).text }).expect(403);
      expect(r2.body).toEqual({ denied: true, reason: 'blocked', message: 'Nope' });
    } finally {
      blocked = false;
    }
  });
});

describe('data requests (§ 4.6) over HTTP', () => {
  it('answers not-configured without the dataRequest option, target has no requestUrl', async () => {
    const http = request(app.getHttpServer());
    const target = await http.get('/auth/sk/target').expect(200);
    expect(target.body.requestUrl).toBeUndefined();
    await http.post('/auth/sk/request/init').send({ kind: 'card-details' }).expect(404);
    await http.get('/auth/sk/request/status?sid=x').expect(404);
    await http.post('/auth/sk/data').set('content-type', 'text/plain').send('hello').expect(404);
  });

  it('full flow: request/init → sk-data-request → challenge → sk-data → status hands the values once', async () => {
    @Module({
      imports: [
        SkLoginModule.forRoot<User>({
          mnemonic: MNEMONIC,
          target: { site: TARGET, publicUrl: 'https://api.example.com/' },
          access: async (address): Promise<AccessDecision<User>> => ({ kind: 'granted', user: { address } }),
          // The owner is the page session: here a header, in a real service a cookie.
          dataRequest: { owner: ({ req }) => (req.headers['x-session'] ? ownerKey(req.headers['x-session']) : undefined) },
        }),
      ],
    })
    class DataModule {}
    const ref = await Test.createTestingModule({ imports: [DataModule] }).compile();
    const dataApp = ref.createNestApplication();
    await dataApp.init();
    try {
      const http = request(dataApp.getHttpServer());
      const target = await http.get('/api/sk/target').expect(200);
      expect(target.body.requestUrl).toBe('https://api.example.com/sk/request');

      await http.post('/api/sk/request/init').send({ kind: 'card-details' }).expect(401);
      await http.post('/api/sk/request/init').set('x-session', 'a').send({ kind: 'pin' }).expect(400);
      const init = await http.post('/api/sk/request/init').set('x-session', 'a').send({ kind: 'card-details' }).expect(200);
      const { sid } = init.body;
      expect(new URL(init.body.payloadUrl).searchParams.get('kind')).toBe('card-details');
      expect(init.body.qrSvg).toContain('<svg');

      const first = await http
        .post('/sk/request')
        .set('content-type', 'text/plain')
        .send(
          encryptEnvelope({
            sender: phone,
            recipientAddress: server.address,
            plaintext: '',
            meta: requestMeta(TARGET, 'sk-data-request', sid, 'card-details'),
          }),
        )
        .expect(200);
      const { text: code, meta } = openChallenge(first.text);
      expect(meta.type).toBe('sk-data-challenge');
      const status = await http.get(`/api/sk/request/status?sid=${sid}`).set('x-session', 'a').expect(200);
      expect(status.body.state).toBe('challenged');

      const values = { holder: 'IVAN IVANOV', pan: '4111 1111 1111 1111', exp: '12/29', cvv: '123' };
      await http
        .post('/sk/request')
        .set('content-type', 'text/plain')
        .send(
          encryptEnvelope({
            sender: phone,
            recipientAddress: server.address,
            plaintext: JSON.stringify(values),
            meta: requestMeta(TARGET, 'sk-data', sid, 'card-details', code),
          }),
        )
        .expect(204);

      // A stranger's session sees nothing, the owner gets the values once.
      const other = await http.get(`/api/sk/request/status?sid=${sid}`).set('x-session', 'b').expect(200);
      expect(other.body.state).toBe('expired');
      const filled = await http.get(`/api/sk/request/status?sid=${sid}`).set('x-session', 'a').expect(200);
      expect(filled.body).toMatchObject({ state: 'filled', values, sender: phone.address });
      const again = await http.get(`/api/sk/request/status?sid=${sid}`).set('x-session', 'a').expect(200);
      expect(again.body.state).toBe('expired');

      // A refusal is JSON for the app, in the request language.
      const wrongKind = await http
        .post('/api/sk/data')
        .set('content-type', 'text/plain')
        .set('accept-language', 'ru')
        .send(
          encryptEnvelope({
            sender: phone,
            recipientAddress: server.address,
            plaintext: '',
            meta: requestMeta(TARGET, 'sk-data-request', sid, 'login-password'),
          }),
        )
        .expect(404);
      expect(wrongKind.body.error).toBe('sid-expired');
    } finally {
      await dataApp.close();
    }
  });
});
