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
R=https://github.com/paymastech/sk-login/releases/download/v0.1.1
npm i $R/paymastech-sk-login-core-0.1.1.tgz $R/paymastech-sk-login-nestjs-0.1.1.tgz $R/paymastech-sk-login-widget-0.1.1.tgz
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
<!-- from the hub (see "Hub"), or serve
     node_modules/@paymastech/sk-login-widget/dist/sk-login-widget.global.js as a static file -->
<script src="https://auth.secretkeeper.net/widget.js"></script>
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

The Secret Keeper app only sends envelopes to targets it knows. There are
two ways to become one:

- **Through the hub** (recommended): the app has a single built-in entry
  for the hub (`auth.secretkeeper.net`), and your service is registered in
  the hub's registry under a short `destination` id. No app release is
  needed. The hub relays the app's envelopes to your `login` endpoint and
  does not read them: they are encrypted to your server address.
- **Direct**: your id, `login` URL and server address are hardcoded in the
  app's `skLoginTargets`, which requires an app release per service.

Steps for the hub mode:

1. Generate the server mnemonic (once, keep it as a secret):
   ```bash
   node -e "import('@paymastech/sk-login-core').then(m => console.log(m.generateMnemonic().join(' ')))"
   ```
2. Start the module with `target: { id: '<destination>', hub: 'auth_secretkeeper', publicUrl }`.
   `id` is the short Latin name you want in the registry (`[a-z0-9_-]{1,32}`),
   `hub` is the hub's target id in the app (`auth_secretkeeper` in
   production; the Secret Keeper team may give you a staging one).
3. Open `GET <publicUrl>/api/sk/target`: it contains `id`, `hub`, `url`
   (your `login` endpoint), `serverAddress` (`sk1…`) and `checkDigits` for
   verification by voice.
4. Hand this JSON plus the display name of your service to the Secret
   Keeper team; they add the entry to the hub registry. From that moment
   the sign-in works with the released app.
5. The `login` endpoint must be reachable from the internet over HTTPS: it
   is called by the hub, not by the browser.
6. If `serverAddress` changes (a new mnemonic), tell the team to update the
   registry entry: envelopes are encrypted to this address.

In the direct mode steps 2-4 differ: start the module without `hub`, and
the team adds the target to `skLoginTargets` and ships an app release;
until that release is out, the sign-in can only be tested with the phone
emulation (see demo, `DEMO_FAKE_PHONE=1`).

## Hub

The hub is a relay operated by the Secret Keeper team. With `hub` set the
QR becomes `https://secretkeeper.net/auth?v=1&sid=…&target=<hub>&destination=<id>`.
The app asks the hub for the display name and server address of
`destination`, encrypts the usual envelope to your server, wraps it into an
outer envelope addressed to the hub, and posts it there. The hub decrypts
only the outer envelope (which authenticates the sender), forwards the
inner one to your `login` URL and returns your reply unchanged. Your server
sees exactly the same envelopes as in the direct mode, so the module does
not change behavior; only the QR does.

The hub also serves the browser widget, so you do not have to bundle it:

```html
<script src="https://auth.secretkeeper.net/widget.js"></script>
```

`@paymastech/sk-login-widget` remains available for self-hosting.

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
| `GET target` | humans | | `{ id, hub?, v, url, serverAddress, checkDigits }` |

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
| `target.id` | required | service id: the hub `destination` (hub mode) or the entry in the app's `skLoginTargets` (direct mode) |
| `target.hub` | | hub target id (e.g. `auth_secretkeeper`); switches the QR to `target=<hub>&destination=<id>` |
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
