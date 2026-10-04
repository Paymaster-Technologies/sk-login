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
} from '@paymastech/sk-login-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SkLoginModule, SkLoginService } from '../src/index.js';

const TARGET = 'demo';
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
          target: { id: TARGET, publicUrl: 'https://api.example.com/' },
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
  it('target describes the server for the app registry', async () => {
    const r = await request(app.getHttpServer()).get('/auth/sk/target').expect(200);
    expect(r.body).toEqual({
      id: TARGET,
      v: 1,
      url: 'https://api.example.com/auth/sk/login',
      serverAddress: server.address,
      checkDigits: expect.stringMatching(/^\d{5}( \d{5}){4}$/),
    });
  });

  it('hub mode: target reports the hub and init points the QR at it', async () => {
    @Module({
      imports: [
        SkLoginModule.forRoot<User>({
          mnemonic: MNEMONIC,
          target: { id: TARGET, hub: 'auth_secretkeeper', publicUrl: 'https://api.example.com/' },
          access: async (address): Promise<AccessDecision<User>> => ({ kind: 'granted', user: { address } }),
        }),
      ],
    })
    class HubModule {}
    const ref = await Test.createTestingModule({ imports: [HubModule] }).compile();
    const hubApp = ref.createNestApplication();
    await hubApp.init();
    try {
      const http = request(hubApp.getHttpServer());
      const target = await http.get('/api/sk/target').expect(200);
      expect(target.body.hub).toBe('auth_secretkeeper');
      expect(target.body.id).toBe(TARGET);
      const init = await http.post('/api/sk/init').expect(200);
      const url = new URL(init.body.payloadUrl);
      expect(url.searchParams.get('target')).toBe('auth_secretkeeper');
      expect(url.searchParams.get('destination')).toBe(TARGET);
    } finally {
      await hubApp.close();
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
    expect(payloadUrl).toContain(`target=${TARGET}`);
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
