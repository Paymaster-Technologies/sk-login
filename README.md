# Sign in with Secret Keeper (SK login)

Passwordless sign-in and form filling from the Secret Keeper vault for
websites: Node core, NestJS module, browser widget, and a
[.NET package](https://github.com/paymastech/sk-login-dotnet).

Passwordless sign-in for a website: the user scans a QR code with the
Secret Keeper app (or opens it with a button on the phone), confirms in
the app, the site receives their `sk1…` address and decides who to let
in. The site's server and the app exchange encrypted envelopes; the site
sees only the user's address.

The same channel also fills forms from the user's vault (a data request):
the site asks for a login and password, card details or personal data, the
user picks a record in the app, and the values land in the form fields of
the page that asked. See ["Data request"](#data-request).

The reference consumer is [auth.secretkeeper.net](https://auth.secretkeeper.net):
a demo site on these packages (core on the server, the widget in the
browser) with both flows live, sign-in and filling a form from the vault.
The popups there are what any site gets out of the box.

No registration and no app release are needed to connect a site: the QR
carries the site's host and its server address, the app derives the
endpoints from the host (`https://<host>/sk/login`, `https://<host>/sk/request`)
and encrypts to the address, like to a contact who showed their QR. See
["How the app finds your server"](#how-the-app-finds-your-server).

The repository is a monorepo of three packages and an example:

| Package | What it is |
| --- | --- |
| [`@paymastech/sk-login-core`](packages/core) | Framework-agnostic protocol: envelope cryptography, sign-in requests (`SkLogin`), data requests (`SkDataRequest`), challenge code, verification, stores. |
| [`@paymastech/sk-login-nestjs`](packages/nestjs) | NestJS module: `SkLoginModule.forRoot(...)` mounts the sign-in routes (and the data request routes when configured) and provides `SkLoginService`. |
| [`@paymastech/sk-login-widget`](packages/widget) | Browser popups: sign-in (QR, "with the app" button, waiting, manual code, refusal, timeout) and "fill from Secret Keeper". Own transport, `complete` step and inline mode for second-factor pages. No framework, ESM plus a single IIFE file. |
| [`examples/nestjs-demo`](examples/nestjs-demo) | Working application: module + widget + cookie session + a card form filled from the vault, plus a phone emulation for development. |

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
R=https://github.com/paymastech/sk-login/releases/download/v0.5.0
npm i $R/paymastech-sk-login-core-0.5.0.tgz $R/paymastech-sk-login-nestjs-0.5.0.tgz $R/paymastech-sk-login-widget-0.5.0.tgz
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
      target: { site: 'example.com' },           // the public host: the app posts to https://example.com/sk/login
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

The module mounts the app's endpoints `POST /sk/login` and `POST /sk/request`
at the root of the application (Secret Keeper derives them from the host in
the QR, so they must be reachable at `https://<site>/sk/...`) and the page's
routes under `api/sk`. It reads the envelope bodies itself (`text/plain`),
so the global body parser does not need to be touched. Works on both
Express and Fastify.

Sign-in page:

```html
<!-- serve node_modules/@paymastech/sk-login-widget/dist/sk-login-widget.global.js as a static file -->
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
light and dark themes, and becomes a bottom sheet on narrow screens. A
service with its own routes (Secret Keeper as a second factor after a
password) can replace the server calls (`transport`), finish the sign-in
with its own request (`complete`), drop the manual code, add a recovery
link and render the sheet inline instead of a dialog: see the
[widget README](packages/widget/README.md#own-routes-second-factor).

## Data request

Besides signing in, a site can ask the app for a record from the user's
vault (protocol § 4.6): a login and password for a site, card details,
personal data. The flow mirrors the sign-in: the browser gets a QR, the app
scans it, shows the request to the user, the user picks a record and
confirms, the app sends the encrypted values to the site's server, and the
browser receives them once over `request/status`. The server never stores
the values beyond that single hand-over.

Server side, in the module options:

```ts
SkLoginModule.forRoot<User>({
  // ... sign-in options as above
  // Who may ask: a request belongs to the page session that created it,
  // and only that session gets the values back. Return undefined for 401.
  dataRequest: {
    owner: ({ req }) => {
      const token = sessions.tokenFrom(req);
      return token ? ownerKey(token) : undefined;   // ownerKey = sha256(token), base64url
    },
  },
});
```

This adds `POST request/init` (`{ kind }`), `GET request/status?sid=` and
the app's endpoint `POST /sk/request` (`text/plain` envelopes
`sk-data-request`, `sk-data`, `sk-data-cancel`); `GET target` gains
`requestUrl`. Kinds and their fields:

| Kind | Fields |
| --- | --- |
| `login-password` | `site`, `login`, `password` |
| `card-details` | `holder`, `pan`, `exp`, `cvv`, `billingAddress` |
| `personal-data` | `name`, `birthdate`, `phone`, `email`, `address` |

Browser side, the second popup of the widget:

```html
<script>
  const fill = SkLoginWidget.mountSkRequest({
    apiBase: '/api/sk',
    lang: 'en',
    onFilled: ({ kind, values, sender }) => { form.pan.value = values.pan ?? ''; /* ... */ },
    onCancelled: () => {},
  });
  document.getElementById('fill').onclick = () => fill.open('card-details');
</script>
```

`GET request/status` answers `{ state: 'new' | 'challenged' | 'cancelled' | 'expired' }`
or `{ state: 'filled', values, sender, filledAt }`; a second call after
`filled` answers `expired` (the values were handed over once). Without a
session (`owner` returned `undefined`) the browser routes answer `401
{ error: 'unauthorized' }`; the widget then calls `onUnauthorized` (a page
reload by default).

## How the app finds your server

The QR (and the "Sign in with the app" link) is
`https://secretkeeper.net/auth?v=1&sid=…&site=<host>&address=<sk1…>`
(`/request?…&kind=…` for a data request). The app reads only `v`, `sid`,
`site`, `address` (and `kind`):

- `site` is your public host, exactly what `target.site` is set to: bare
  ASCII, lower-case, no scheme, port or path (an IDN host in punycode). The
  app shows it on the consent screen as the name of the service and derives
  the endpoints from it by convention: `https://<host>/sk/login` and
  `https://<host>/sk/request`. There is no URL in the QR and the app will
  not take one: that is what makes a copied QR under a foreign host useless.
- `address` is your server's `sk1…` address (from the mnemonic). The app
  encrypts the request to it and accepts the challenge only from it, the
  same way it treats a contact who showed their own QR. The two-step
  exchange proves that the party behind the endpoint holds the key of that
  address; the binding of the address to the host comes from the channel
  the key arrived through, your page in the user's browser, not from the
  app's network path. Why this is safe and what it does not cover:
  `docs/protocol.md` § 4.5 "Security model" in the Secret Keeper repository
  (a copy is at [secretkeeper.net/protocol](https://secretkeeper.net/protocol)).
- `meta.data.target` of every envelope repeats the host; the module rejects
  envelopes meant for another service (`bad-meta`).

So onboarding is: generate the mnemonic once and keep it secret
(`node -e "import('@paymastech/sk-login-core').then(m => console.log(m.generateMnemonic().join(' ')))"`),
start the module with `target: { site: '<host>' }`, make sure
`https://<host>/sk/login` (and `/sk/request` with `dataRequest`) reaches
it over HTTPS from the internet, put the widget on the page. No
registration anywhere, no app release. `GET api/sk/target` publishes the
same facts (`site`, `url`, `requestUrl`, `serverAddress`, `checkDigits`)
for humans and agents; the app does not read it.

Apps that Secret Keeper knows by name (Tetatet) use `target: { id }` instead
of `site`: their URL and address are built into the app and the QR carries
`target=<id>`. A site that used to be such an entry can keep accepting
envelopes with the old id for a while with `target.legacyTargets: ['<id>']`.

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

The app's endpoints are at the root of the application, where Secret
Keeper derives them from the host in the QR:

| Method and path | Caller | Request | Response |
| --- | --- | --- | --- |
| `POST /sk/login` | app | `text/plain`, envelope | challenge envelope `text/plain` (for `sk-login`), `{ sent: true }` (for `sk-login-code`), `204` (for `sk-login-cancel`) or `4xx { error, message }` |
| `POST /sk/request` | app | `text/plain`, envelope | challenge envelope `text/plain` (for `sk-data-request`), `204` (for `sk-data` and `sk-data-cancel`) or `4xx { error, message }`; `404 not-configured` without `dataRequest` |

The page's routes live under the prefix `api/sk` (`routePrefix` in
`forRoot`/`forRootAsync`):

| Method and path | Caller | Request | Response |
| --- | --- | --- | --- |
| `POST init` | browser | empty | `{ sid, payloadUrl, schemeUrl, expiresAt, ttlMs, qrSvg? }` |
| `GET status?sid=` | browser | | `{ state, reason?, ...extra }` where `state` is `new`, `challenged`, `authenticated`, `denied`, `cancelled`, `expired` |
| `POST code` | browser | `{ sid, code }` | `{ ok: true, ...extra }`, `403 { denied: true, reason, message }` or `4xx { error, message }` |
| `GET target` | humans, agents | | `{ id, site?, v, url, requestUrl?, serverAddress, checkDigits }` |
| `POST request/init` | browser | `{ kind }` | `{ sid, kind, payloadUrl, schemeUrl, expiresAt, ttlMs, qrSvg? }`, `401 { error: 'unauthorized' }`, `400 { error: 'bad-kind' }`; with `dataRequest` only |
| `GET request/status?sid=` | browser | | `{ state }` or `{ state: 'filled', values, sender, filledAt }`; with `dataRequest` only |
| `POST login`, `POST data` | older app builds | as `/sk/login` and `/sk/request` | aliases from the time the endpoints were per-service entries in the app |

Without `dataRequest` these routes answer `404 { error: 'not-configured' }`.

`error` codes in replies to the app and the browser:

| Code | Status | When |
| --- | --- | --- |
| `bad-envelope` | 400 | the body is not an envelope, the envelope did not decrypt or is addressed to another server |
| `bad-meta` | 400 | meta has no `type`/`sid`, the target is foreign or the envelope type is unknown |
| `in-progress` | 409 | a request from another address is already in progress for this sid, or a code/cancel arrived without a request |
| `sid-expired` | 404 | the sid is not found or has expired (2 minutes by default) |
| `code-invalid` | 400 / 410 | the code did not match; after 5 attempts the request is closed (410) |
| `access-denied` | 403 | `access` returned `denied`; `reason` carries its reason |
| `kind-mismatch` | 400 | (data request) the app sent a record of another kind than the one requested |

Flow: the browser calls `init`, draws a QR with `payloadUrl`, polls
`status` every 2 s. The app scans the QR, sends an `sk-login` envelope to
`/sk/login`, receives an envelope with a 6-digit code and the browser context
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
| `target.site` | one of `site`/`id` | the public host of the service (`example.com`): in the QR with the server address and in `meta.data.target`; the app posts to `https://<host>/sk/login` |
| `target.id` | one of `site`/`id` | an embedded target id instead of a site (an app built into Secret Keeper, e.g. `tetatet`) |
| `target.legacyTargets` | | other `meta.data.target` values to accept for a while (the embedded id a site had before `site`) |
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
| `dataRequest` | off | data requests: `{ owner({ req, res }), store?, ttlMs?, maxBodyBytes? (64 KiB) }`, see "Data request" |
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
`set` can be implemented as `SET sid json PX ttlMs`. Data requests use the
same shape of store (`DataRequestStore = SidStore<DataPending>`), passed as
`dataRequest.store`.

## Other frameworks

`@paymastech/sk-login-core` knows nothing about HTTP. An adapter does four things:

```ts
import { SkLogin, identityFromMnemonic, contextFromHeaders, langFromAcceptLanguage } from '@paymastech/sk-login-core';

const sk = new SkLogin({ identity: identityFromMnemonic(process.env.SK_SERVER_MNEMONIC!), site: 'example.com', access });

app.post('/api/sk/init', async (req, res) => res.json(await sk.init(contextFromHeaders((h) => req.headers[h], req.socket.remoteAddress))));
app.post('/sk/login', text(), async (req, res) => {   // the app derives this path from the host in the QR
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
Secret Keeper browser extension with `npm run sync-sk-crypto`; the source
revision is recorded in `SYNCED_FROM`.

## License

MIT.
