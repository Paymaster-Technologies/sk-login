# @paymastech/sk-login-core

Server side of sign-in through Secret Keeper, independent of any HTTP
framework: envelope cryptography, requests keyed by sid, a challenge with a
6-digit code and browser context, code verification, the admission
decision, the request store. Also the data request (protocol § 4.6): a
vault record for a form, `SkDataRequest`.

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

Data request, the same shape:

```ts
import { SkDataRequest, ownerKey } from '@paymastech/sk-login-core';

const data = new SkDataRequest({ identity, target: 'my-service', hub: 'auth_secretkeeper' });

// POST request/init (browser, signed in): the owner is the page session, only it gets the values
const init = await data.init('card-details', ownerKey(sessionToken), ctx);   // { sid, kind, payloadUrl, schemeUrl, expiresAt, ttlMs }

// POST data (phone, text/plain): sk-data-request -> challenge envelope, sk-data / sk-data-cancel -> 204
const r = await data.handleEnvelope(bodyText, lang);   // r.kind: 'challenge' | 'filled' | 'cancelled'

// GET request/status (browser)
const poll = await data.poll(sid, ownerKey(sessionToken));   // { state } | { state: 'filled', values, sender, filledAt }
```

`poll` returns the values once and wipes them; a sid asked by another owner
answers `expired`.

Exports: `SkLogin`, `SkDataRequest`, `LoginError`, `MemoryPendingStore`,
`MemorySidStore`, `PendingStore`, `DataRequestStore`, `SidStore` (for Redis),
`KINDS`, `isKind`, `ownerKey`, `contextFromHeaders`, `describeContext`,
`parseUserAgent`, `langFromAcceptLanguage`, `identityFromMnemonic`,
`generateMnemonic`, `deriveIdentityKeys`, `keyCheckDigits`, `encryptEnvelope`,
`decryptEnvelope`, `loginMeta`, `requestMeta`, `payloadQuery`.

Protocol, API and onboarding description: [repository README](https://github.com/paymastech/sk-login#readme).
