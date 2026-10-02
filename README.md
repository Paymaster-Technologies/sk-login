# Sign in with Secret Keeper (SK login)

Passwordless sign-in for a website: the user scans a QR code with the
Secret Keeper app (or opens it with a button on the phone), confirms in
the app, the site receives their `sk1…` address and decides who to let
in. The site's server and the app exchange encrypted envelopes; the site
sees only the user's address.

The repository is a monorepo of three packages and an example:

| Package | What it is |
| --- | --- |
| [`@paymastech/sk-login-core`](packages/core) | Framework-agnostic protocol: envelope cryptography, requests, challenge code, verification, request store. |
| [`@paymastech/sk-login-nestjs`](packages/nestjs) | NestJS module: `SkLoginModule.forRoot(...)` mounts 5 routes and provides `SkLoginService`. |
| [`@paymastech/sk-login-widget`](packages/widget) | Browser popup (QR, "with the app" button, waiting, manual code, refusal, timeout). No framework, ESM plus a single IIFE file. |
| [`examples/nestjs-demo`](examples/nestjs-demo) | Working application: module + widget + cookie session, plus a phone emulation for development. |

Adapters for other frameworks (Express, Fastify, Next.js, Koa) are built
on top of `core` in a few dozen lines, see ["Other frameworks"](#other-frameworks).
For .NET there is a separate implementation of the same protocol:
[paymastech/sk-login-dotnet](https://github.com/paymastech/sk-login-dotnet)
(`Paymastech.SkLogin` and `Paymastech.SkLogin.AspNetCore`); the widget from
this repository works with it unchanged.

## Quick start (NestJS)

```bash
npm i @paymastech/sk-login-nestjs @paymastech/sk-login-widget
```

Until the packages are published to npm, install them from the tarballs
of the [release](https://github.com/paymastech/sk-login/releases/latest)
(all three at once so that `core` resolves locally):

```bash
R=https://github.com/paymastech/sk-login/releases/download/v0.1.0
npm i $R/paymastech-sk-login-core-0.1.0.tgz $R/paymastech-sk-login-nestjs-0.1.0.tgz $R/paymastech-sk-login-widget-0.1.0.tgz
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { SkLoginModule } from '@paymastech/sk-login-nestjs';

interface User { id: string; address: string }

@Module({
  imports: [
    SkLoginModule.forRoot<User>({
      mnemonic: process.env.SK_SERVER_MNEMONIC!,   // 12 BIP-39 words, see "Secrets"
      target: { id: 'my-service', publicUrl: 'https://api.example.com' },
      // Who to let in: called once after confirmation, receives the sk1… address
      access: async (address) => {
        const user = await users.findByAddress(address);
        return user ? { kind: 'granted', user } : { kind: 'denied', reason: 'unknown-address' };
      },
      // The browser learned about admission: issue a session. The return value is merged into the JSON reply.
      onAuthenticated: async (user, { res }) => {
        res.header('set-cookie', await sessions.cookieFor(user));
        return { userId: user.id };
      },
    }),
  ],
})
export class AppModule {}
```

The module reads the `POST login` body itself (`text/plain`), so the
global body parser does not need to be touched. Works on both Express and
Fastify.

Sign-in page:

```html
<!-- serve node_modules/@paymastech/sk-login-widget/dist/sk-login-widget.global.js
     as a static file; after the npm release it is also available from jsDelivr -->
<script src="/static/sk-login-widget.global.js"></script>
<button id="login">Sign in</button>
<script>
  const login = SkLoginWidget.mountSkLogin({
    apiBase: '/api/sk',          // module route prefix
    lang: 'en',                  // 'ru' | 'en'
    onSuccess: (extra) => location.reload(),   // extra = what onAuthenticated returned
    onDenied: (reason, message) => {},
    onCancelled: () => {},
  });
  document.getElementById('login').onclick = () => login.open();
</script>
```

Or as a module: `import { mountSkLogin } from '@paymastech/sk-login-widget'`.
The widget injects its own styles (`skl-` prefix, `--skl-*` variables), has
light and dark themes, and becomes a bottom sheet on narrow screens.

## Onboarding a new service (checklist)

Targets (where the app is allowed to send a request) are hardcoded inside
the Secret Keeper app: id, URL of the `login` endpoint and the server
address. Without an entry in the app the sign-in will not work: the QR
scans, but the app does not know where to write. So for a new service you
need to:

1. Generate the server mnemonic (once, keep it as a secret):
   ```bash
   node -e "import('@paymastech/sk-login-core').then(m => console.log(m.generateMnemonic().join(' ')))"
   ```
2. Start the module with `target.id` (a short Latin service name) and
   `publicUrl`. Open `GET <publicUrl>/api/sk/target`: it contains `id`,
   `url` (where the app sends envelopes), `serverAddress` (`sk1…`) and
   `checkDigits` for verification by voice.
3. Hand this JSON to the Secret Keeper team. They will add the target to
   `skLoginTargets` and ship an app release; until that release is out,
   the sign-in can only be tested with the phone emulation (see demo,
   `DEMO_FAKE_PHONE=1`).
4. The `login` endpoint must be reachable from the internet over HTTPS: it
   is called by the phone, not by the browser.
5. If `serverAddress` changes (a new mnemonic), the target in the app must
   be updated: envelopes are encrypted to this address, and older apps will
   stop getting through.

## Secrets and environment

- `SK_SERVER_MNEMONIC`: 12 words. The server's signing key and encryption
  key are derived from it. A leak means the ability to impersonate the
  service to the app. Keep it in a secret manager / `.env` outside the
  repository, do not log it. Instead of the mnemonic you can pass a
  ready-made `identity` (`identityFromMnemonic`) if the keys come from a vault.
- No external services: the module makes no network calls, everything
  happens between your server, the browser and the user's phone.
  `secretkeeper.net` in the QR is needed only as a universal link
  intercepted by the app (on a phone without the app it opens the install page).

## Module HTTP API

Default prefix `api/sk` (`routePrefix` in `forRoot`/`forRootAsync`).
Browser routes: `init`, `status`, `code`. Phone route: `login`.
Service route: `target`.

| Method and path | Caller | Request | Response |
| --- | --- | --- | --- |
| `POST init` | browser | empty | `{ sid, payloadUrl, schemeUrl, expiresAt, ttlMs, qrSvg? }` |
| `POST login` | app | `text/plain`, envelope | challenge envelope `text/plain` (for `sk-login`), `{ sent: true }` (for `sk-login-code`), `204` (for `sk-login-cancel`) or `4xx { error, message }` |
| `GET status?sid=` | browser | | `{ state, reason?, ...extra }` where `state` is `new`, `challenged`, `authenticated`, `denied`, `cancelled`, `expired` |
| `POST code` | browser | `{ sid, code }` | `{ ok: true, ...extra }`, `403 { denied: true, reason, message }` or `4xx { error, message }` |
| `GET target` | humans | | `{ id, v, url, serverAddress, checkDigits }` |

`error` codes in replies to the app and the browser:

| Code | Status | When |
| --- | --- | --- |
| `bad-envelope` | 400 | the body is not an envelope, the envelope did not decrypt or is addressed to another server |
| `bad-meta` | 400 | meta has no `type`/`sid`, the target is foreign or the envelope type is unknown |
| `in-progress` | 409 | a request from another address is already in progress for this sid, or a code/cancel arrived without a request |
| `sid-expired` | 404 | the sid is not found or has expired (2 minutes by default) |
| `code-invalid` | 400 / 410 | the code did not match; after 5 attempts the request is closed (410) |
| `access-denied` | 403 | `access` returned `denied`; `reason` carries its reason |

Flow: the browser calls `init`, draws a QR with `payloadUrl`, polls
`status` every 2 s. The app scans the QR, sends an `sk-login` envelope to
`login`, receives an envelope with a 6-digit code and the browser context
(IP, browser, OS, geo if `geo` is set) and shows it to the user. The user
confirms in the app: the app sends `sk-login-code`, the server calls
`access`, the status becomes `authenticated` or `denied`. If the app
cannot reach the server (for example, the site is on a local network), it
shows the code and the user types it into the browser by hand (`POST code`).

`onAuthenticated` is called exactly once per request: on the first
`status` with `authenticated` or on a successful `code`. After that the
request is marked `used`, and further `status` calls for this sid answer
`expired`.

## Module options

| Option | Default | Meaning |
| --- | --- | --- |
| `mnemonic` or `identity` | one is required | server identity |
| `target.id` | required | id from the app's `skLoginTargets` |
| `target.publicUrl` | from `Host` and `X-Forwarded-Proto` | origin for `GET target` |
| `access(address)` | required | `{ kind: 'granted', user }` or `{ kind: 'denied', reason, message? }` |
| `onAuthenticated(user, { req, res })` | | session, cookie, token; the return value goes into the JSON for the browser |
| `store` | `MemoryPendingStore` | request store, see "Multiple replicas" |
| `ttlMs` | 120000 | sid lifetime |
| `trustProxy` | `true` | take the IP from the last `X-Forwarded-For` entry |
| `geo(ip)` | | asynchronous city and country lookup for the context shown in the app |
| `describe(ctx, lang)` | built-in | fully custom context lines |
| `messages` | ru/en | override texts (e.g. `accessDenied`) |
| `qr` | `true` | include `qrSvg` in `init` |
| `maxBodyBytes` | 16 KiB | envelope body limit |
| `routePrefix` | `api/sk` | route prefix |

`forRootAsync({ imports, inject, useFactory, routePrefix })` for
ConfigService and other dependencies. `SkLoginService` is exported: through
it you can call `init`/`poll`/`submitCode` from your own controllers if the
standard routes do not fit.

## Multiple replicas

A request lives for 2 minutes and spans three requests from two different
clients (the browser and the phone). With `MemoryPendingStore` they must
land on the same process. With several instances you need sticky sessions
by `sid` or your own `PendingStore` on top of Redis/a database:

```ts
interface PendingStore<User> {
  get(sid: string): Promise<Pending<User> | undefined>;
  set(entry: Pending<User>, ttlMs: number): Promise<void>;
  delete(sid: string): Promise<void>;
}
```

`Pending` is a flat JSON-serializable object (`sid`, `state`, `createdAt`,
`expiresAt`, `ctx`, `sender`, `code`, `codeAttempts`, `user`, `denied`);
`set` can be implemented as `SET sid json PX ttlMs`.

## Other frameworks

`@paymastech/sk-login-core` knows nothing about HTTP. An adapter does four things:

```ts
import { SkLogin, identityFromMnemonic, contextFromHeaders, langFromAcceptLanguage } from '@paymastech/sk-login-core';

const sk = new SkLogin({ identity: identityFromMnemonic(process.env.SK_SERVER_MNEMONIC!), target: 'my-service', access });

app.post('/api/sk/init', async (req, res) => res.json(await sk.init(contextFromHeaders((h) => req.headers[h], req.socket.remoteAddress))));
app.post('/api/sk/login', text(), async (req, res) => {
  try {
    const r = await sk.handleEnvelope(req.body, langFromAcceptLanguage(req.headers['accept-language']));
    // r.kind: 'challenge' (r.armored -> text/plain) | 'code-accepted' ({ sent: true }) | 'cancelled' (204)
  } catch (e) {
    // LoginError: e.status, e.code, e.message -> res.status(e.status).json({ error: e.code, message: e.message })
  }
});
app.get('/api/sk/status', async (req, res) => res.json(await sk.poll(req.query.sid)));
app.post('/api/sk/code', async (req, res) => { const user = await sk.submitCode(req.body.sid, req.body.code); /* session */ });
```

An Express/Fastify adapter is not packaged in this repository yet; if
needed, it can be built following `packages/nestjs/src/sk-login.controller.ts`.

## Development

```bash
npm i
npm run check      # tsc for all packages + vitest
npm run build      # dist for core, nestjs, widget
npm run demo       # http://localhost:3000, random mnemonic
DEMO_FAKE_PHONE=1 npm run demo   # plus POST /demo/phone?sid=… instead of a phone
```

The envelope cryptography (`packages/core/src/crypto`) is synced from the
`lashin.su` site implementation with `npm run sync-sk-crypto`; the source
revision is recorded in `SYNCED_FROM`.

## License

MIT.
