# @paymastech/sk-login-widget

Secret Keeper popups for the browser. `mountSkLogin` is the sign-in: a QR
code, a "with the app" button on the same device, waiting for
confirmation, manual code entry, refusal and timeout screens.
`mountSkRequest` is "fill from Secret Keeper": the same sheet asking the
app for a vault record (login and password, card details, personal data)
and handing the values to the page. A bottom sheet on narrow screens, a
centered card on wide ones. No framework, about 40 KB, injects its own
styles. The look is that of the popups on
[auth.secretkeeper.net](https://auth.secretkeeper.net), the reference consumer.

Works against the routes mounted by
[`@paymastech/sk-login-nestjs`](https://www.npmjs.com/package/@paymastech/sk-login-nestjs)
or any adapter on top of `@paymastech/sk-login-core` (`init`, `status`,
`code` for the sign-in; `request/init`, `request/status` for data requests).

## Setup

As a single file with the `SkLoginWidget` global, served by your site from
your own static files:

```html
<!-- dist/sk-login-widget.global.js from the package -->
<script src="/static/sk-login-widget.global.js"></script>
<script>
  const login = SkLoginWidget.mountSkLogin({
    apiBase: '/api/sk',
    lang: 'ru',
    onSuccess: (extra) => location.reload(),
  });
  document.getElementById('login').onclick = () => login.open();
</script>
```

As a module:

```ts
import { mountSkLogin } from '@paymastech/sk-login-widget';
const login = mountSkLogin({ apiBase: '/api/sk', lang: 'en', onSuccess: () => location.reload() });
```

Fill a form from the vault:

```ts
import { mountSkRequest } from '@paymastech/sk-login-widget';
const fill = mountSkRequest({
  apiBase: '/api/sk',
  lang: 'en',
  onFilled: ({ kind, values, sender, filledAt }) => { form.pan.value = values.pan ?? ''; },
});
button.onclick = () => fill.open('card-details');   // 'login-password' | 'card-details' | 'personal-data'
```

## Options

Common to both popups:

| Option | Default | Meaning |
| --- | --- | --- |
| `apiBase` | `/api/sk` | module route prefix (may be an absolute URL of another origin, then see `credentials`) |
| `lang` | `ru` | `ru` or `en` |
| `onCancelled()` | | the user declined the request in the app |
| `onClose(reason)` | | the popup closed: `'user'` (the close button, Esc, the scrim, "Close" on a final view, the page's `close()`) or `'result'` (it closed itself after a result; `onSuccess` / `onFilled` follows right away) |
| `theme` | by `prefers-color-scheme` | force `light` or `dark` |
| `logoUrl` | built-in | logo in the center of the QR |
| `skSiteUrl` | `https://secretkeeper.net` | where the "install Secret Keeper" link points |
| `headers`, `credentials` | `same-origin` | for fetch calls to the API (CSRF header, cookies for another origin) |
| `pollMs` | 2000 | `status` polling period |
| `container` | | render inline into this element instead of a modal dialog (see "Inline") |

`mountSkLogin`:

| Option | Default | Meaning |
| --- | --- | --- |
| `texts` | | override any strings (`Partial<Texts>`) |
| `onSuccess(extra)` | required | sign-in succeeded; `extra` is what `onAuthenticated` returned on the server, merged with what `complete` returned |
| `onDenied(reason, message)` | | the server did not let this address in |
| `transport` | the module's routes under `apiBase` | own server calls: `init()`, `status(sid)`, `submitCode?(sid, code)`, `cancel?(sid)` (see "Own routes") |
| `complete(sid, extra)` | | finish the sign-in on the server after `authenticated`; the widget waits, does not close and does not call it twice; `onSuccess` only after it resolves; a rejection is shown as an error view (`error.message`, or `texts.completeFailed`) and is not retried |
| `onCompleteError(error)` | | `complete` rejected (the error is already on the screen) |
| `onCancelError(error)` | | `transport.cancel` rejected; the error is already on the screen with "Try again" |
| `manualCode` | `true` | offer the code entry after the scan; forced off when the transport has no `submitCode` |
| `recoveryLink` | | `{ text, href?, onClick? }`: a link under every view (the QR, the waiting, the errors), e.g. "No access to Secret Keeper?"; hidden only while `complete` or `transport.cancel` runs |
| `autoStart` | `true` | inline mode: request the QR right away on mount |

Returns `{ open(), close(), destroy(), element }`. `close()` with a request
in flight ignores further answers to that sid and, when the transport has
`cancel`, calls `transport.cancel(sid)` first: the sheet shows a waiting
view and closes once it resolves (`onClose('user')`); a rejection keeps
the sheet open with the error message (`error.message`, or
`texts.cancelFailed`) and "Try again", which runs the cancel again, and
calls `onCancelError`. After `authenticated` nothing is cancelled.
`close()` is ignored while `complete` or the cancel runs. `destroy()`
removes the sheet; answers that arrive later (`init`, `complete`,
`cancel`) are dropped and no callbacks fire.

### Own routes (second factor)

A service that uses Secret Keeper as a second factor after a password
usually has its own routes and response formats, finishes the sign-in with
an extra server call (browser binding, session) and does not want the
manual code. Everything in the widget's flow is replaceable:

```ts
const login = mountSkLogin({
  container: document.getElementById('second-factor')!,   // inline, the QR appears at once
  lang: 'en',
  manualCode: false,
  recoveryLink: { text: 'No access to Secret Keeper?', href: '/account/recover' },
  transport: {
    init: () => post('/auth/2fa/sk/start'),                               // -> { sid, payloadUrl, schemeUrl, ttlMs, qrSvg }
    status: (sid) => get(`/auth/2fa/sk/state?sid=${sid}`),               // -> { state, ...extra }
    cancel: (sid) => post('/auth/2fa/sk/cancel', { sid }),               // the person gave up
  },
  complete: async (sid) => {
    const r = await fetch('/auth/2fa/sk/complete', { method: 'POST', body: JSON.stringify({ sid }) });
    if (!r.ok) throw new Error((await r.json()).message ?? 'Could not finish the sign-in');
    return r.json();                                                     // merged into onSuccess(extra)
  },
  onSuccess: () => location.assign('/'),
});
```

`init` must return what the module's `POST init` returns (`sid`,
`schemeUrl`, `ttlMs`, `qrSvg`, `payloadUrl`); `status` returns `{ state,
reason?, message?, ...extra }` with the module's states (`new`,
`challenged`, `authenticated`, `denied`, `cancelled`, `expired`);
`submitCode` returns `{ kind: 'ok', extra? } | { kind: 'wrong' } | { kind:
'denied', reason?, message? } | { kind: 'stale' }`. A rejected `init` or
`submitCode` shows "could not reach the site"; a rejected `status` is
ignored and the next poll retries. The default transport is exported as
`httpTransport(apiBase, fetchOpts)` if you only need to wrap it.

### Inline

With `container` the sheet is rendered into the given element: no
backdrop, no close button, no Esc, the width follows the container (up to
480 px). The QR is requested on mount (`autoStart: false` to wait for
`open()`). On the final views (declined, timed out, refused, failed) the
button is "Try again" and starts a new request; `close()` hides the sheet
and `open()` shows it again with a new request. `element` is the inline
root (`div.skl.skl-inline`), otherwise the `<dialog>`.

`mountSkRequest`:

| Option | Default | Meaning |
| --- | --- | --- |
| `texts` | | override any strings (`Partial<RequestTexts>`) |
| `onFilled({ kind, values, sender, filledAt })` | required | the record arrived; the popup is already closed |
| `onUnauthorized()` | `location.reload()` | the server answered 401: the page session is gone |

Returns `{ open(kind), close(), destroy(), element }`. The popup shows a
one-paragraph introduction to Secret Keeper until the first scan from this
browser (`localStorage` key `sk-intro-done`).

## Appearance

Classes are prefixed with `skl-`, colors come from variables on `dialog.skl`:
`--skl-bg`, `--skl-item`, `--skl-text`, `--skl-secondary`, `--skl-primary`,
`--skl-primary-soft`, `--skl-separator`, `--skl-surface-high`,
`--skl-danger`, `--skl-font`, `--skl-mono`. Override them on `:root` or on `.skl`.
Below 600 px the dialog becomes a bottom sheet with a handle and a
full-width action button.
