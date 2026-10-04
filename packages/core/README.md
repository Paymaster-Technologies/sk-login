# @paymastech/sk-login-core

Server side of sign-in through Secret Keeper, independent of any HTTP
framework: envelope cryptography, requests keyed by sid, a challenge with a
6-digit code and browser context, code verification, the admission
decision, the request store.

Ready-made adapter for NestJS: [`@paymastech/sk-login-nestjs`](https://www.npmjs.com/package/@paymastech/sk-login-nestjs).
For other frameworks an adapter is written on top of this package:

```ts
import { SkLogin, identityFromMnemonic, contextFromHeaders, langFromAcceptLanguage, LoginError } from '@paymastech/sk-login-core';

const sk = new SkLogin<User>({
  identity: identityFromMnemonic(process.env.SK_SERVER_MNEMONIC!),
  target: 'my-service',
  hub: 'auth_secretkeeper', // omit for the direct mode (entry in the app's skLoginTargets)
  access: async (address) => (await users.has(address) ? { kind: 'granted', user: await users.get(address) } : { kind: 'denied', reason: 'unknown' }),
});

// POST init (browser): QR and sid
const init = await sk.init(contextFromHeaders((h) => req.headers[h], req.socket.remoteAddress));

// POST login (phone, text/plain)
try {
  const r = await sk.handleEnvelope(bodyText, langFromAcceptLanguage(req.headers['accept-language']));
  // 'challenge' -> reply with r.armored as text/plain; 'code-accepted' -> { sent: true }; 'cancelled' -> 204
} catch (e) {
  if (e instanceof LoginError) res.status(e.status).json({ error: e.code, message: e.message });
}

// GET status (browser)
const { state, user, reason } = await sk.poll(sid);   // authenticated -> set a session for user

// POST code (browser, manual entry)
const user = await sk.submitCode(sid, code);          // LoginError on a wrong code or a refusal
```

Exports: `SkLogin`, `LoginError`, `MemoryPendingStore`, `PendingStore`
(for Redis), `contextFromHeaders`, `describeContext`, `parseUserAgent`,
`langFromAcceptLanguage`, `identityFromMnemonic`, `generateMnemonic`,
`deriveIdentityKeys`, `keyCheckDigits`, `encryptEnvelope`, `decryptEnvelope`,
`loginMeta`.

Protocol, API and onboarding description: [repository README](https://github.com/paymastech/sk-login#readme).
