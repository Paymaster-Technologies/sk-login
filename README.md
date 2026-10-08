# Sign in with Secret Keeper (SK login)

Passwordless sign-in for a website: the user scans a QR code with the
Secret Keeper app (or opens it with a button on the phone), confirms in
the app, the site receives their `sk1…` address and decides who to let
in. The site's server and the app exchange encrypted envelopes; the site
sees only the user's address.

The same channel also fills forms from the user's vault (a data request):
the site asks for a login and password, card details or personal data, the
user picks a record in the app, and the values land in the form fields of
the page that asked. See ["Data request"](#data-request).

The reference consumer is [lashin.su](https://lashin.su): it runs on these
packages (core on the server, the widget from the hub in the browser), so
the popups there are what any site gets out of the box.

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
R=https://github.com/paymastech/sk-login/releases/download/v0.4.1
npm i $R/paymastech-sk-login-core-0.3.0.tgz $R/paymastech-sk-login-nestjs-0.3.0.tgz $R/paymastech-sk-login-widget-0.4.1.tgz
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
the phone route `POST data` (`text/plain` envelopes `sk-data-request`,
`sk-data`, `sk-data-cancel`); `GET target` gains `requestUrl`. Kinds and
their fields:

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
reload by default). In the hub mode the data request QR goes through the
hub exactly like the sign-in one (`/request?...&target=<hub>&destination=<id>`).

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
2. Start the module with `target: { id: '<destination>', hub: 'auth_secretkeeper', owner, publicUrl }`.
   `id` is the short Latin name you want in the registry (`[a-z0-9_-]{1,32}`),
   `hub` is the hub's target id in the app (`auth_secretkeeper` in
   production; the Secret Keeper team may give you a staging one), `owner`
   is the `sk1…` address of your own Secret Keeper app (Settings → address).
3. Open `GET <publicUrl>/api/sk/target`: it contains `id`, `hub`, `url`
   (your `login` endpoint), `serverAddress` (`sk1…`), `checkDigits` for
   verification by voice and `ownerHash` (the hash of `owner`; the address
   itself is not published).
4. Open the hub (`https://auth.secretkeeper.net/`), sign in with the phone
   whose address you put into `owner`, and submit the URL of your service. The catalog fetches `GET target`, checks that `ownerHash`
   matches the signed-in address and that `hub` names this hub, and creates
   the registry entry. From that moment the sign-in works with the released
   app; the app shows your host name until the hub owner approves the
   display name you propose in the catalog.
5. The `login` endpoint must be reachable from the internet over HTTPS: it
   is called by the hub, not by the browser.
6. If `serverAddress` changes (a new mnemonic), press "Re-check" on your
   entry in the catalog: envelopes are encrypted to this address.

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

The hub also serves the browser widget (both popups), so you do not have
to bundle it:

```html
<script src="https://auth.secretkeeper.net/widget.js"></script>
```

`@paymastech/sk-login-widget` remains available for self-hosting.

The hub keeps a catalog of registered services. Service owners sign in to
the catalog with Secret Keeper and register their service by URL (see the
checklist above); the hub owner moderates display names and can block an
entry. The entry is public at `GET <hub>/targets/<destination>`.

## Secrets and environment

- `SK_SERVER_MNEMONIC`: 12 words. The server's signing key and encryption
  key are derived from it. A leak means the ability to impersonate the
  service to the app. Keep it in a secret manager / `.env` outside the
  repository, do not log it. Instead of the mnemonic you can pass a
  ready-made `identity` (`identityFromMnemonic`) if the keys come from a vault.
- `SK_OWNER_ADDRESS` (suggested name): the `sk1…` address of your own Secret
  Keeper app, passed as `target.owner`. Not a secret, but only its hash is
  published; it is what lets you manage the service entry in the hub catalog.
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
| `GET target` | humans, hub catalog | | `{ id, hub?, v, url, requestUrl?, serverAddress, checkDigits, ownerHash? }` |

With `dataRequest` configured (see "Data request"):

| Method and path | Caller | Request | Response |
| --- | --- | --- | --- |
| `POST request/init` | browser | `{ kind }` | `{ sid, kind, payloadUrl, schemeUrl, expiresAt, ttlMs, qrSvg? }`, `401 { error: 'unauthorized' }`, `400 { error: 'bad-kind' }` |
| `POST data` | app | `text/plain`, envelope | challenge envelope `text/plain` (for `sk-data-request`), `204` (for `sk-data` and `sk-data-cancel`) or `4xx { error, message }` |
| `GET request/status?sid=` | browser | | `{ state }` or `{ state: 'filled', values, sender, filledAt }` |

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
| `target.owner` | | `sk1…` address of the service owner; `GET target` publishes its hash as `ownerHash` and the hub catalog lets this address register the service |
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
Secret Keeper browser extension with `npm run sync-sk-crypto`; the source
revision is recorded in `SYNCED_FROM`.

## License

MIT.
