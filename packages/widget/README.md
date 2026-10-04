# @paymastech/sk-login-widget

Secret Keeper popups for the browser. `mountSkLogin` is the sign-in: a QR
code, a "with the app" button on the same device, waiting for
confirmation, manual code entry, refusal and timeout screens.
`mountSkRequest` is "fill from Secret Keeper": the same sheet asking the
app for a vault record (login and password, card details, personal data)
and handing the values to the page. A bottom sheet on narrow screens, a
centered card on wide ones. No framework, about 40 KB, injects its own
styles. The look is that of the popups on [lashin.su](https://lashin.su),
the reference consumer.

Works against the routes mounted by
[`@paymastech/sk-login-nestjs`](https://www.npmjs.com/package/@paymastech/sk-login-nestjs)
or any adapter on top of `@paymastech/sk-login-core` (`init`, `status`,
`code` for the sign-in; `request/init`, `request/status` for data requests).

## Setup

As a single file with the `SkLoginWidget` global, from the hub or from
your own static files:

```html
<script src="https://auth.secretkeeper.net/widget.js"></script>
<!-- or dist/sk-login-widget.global.js from the package:
<script src="/static/sk-login-widget.global.js"></script> -->
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
| `onClose()` | | the popup was closed by the user |
| `theme` | by `prefers-color-scheme` | force `light` or `dark` |
| `logoUrl` | built-in | logo in the center of the QR |
| `skSiteUrl` | `https://secretkeeper.net` | where the "install Secret Keeper" link points |
| `headers`, `credentials` | `same-origin` | for fetch calls to the API (CSRF header, cookies for another origin) |
| `pollMs` | 2000 | `status` polling period |

`mountSkLogin`:

| Option | Default | Meaning |
| --- | --- | --- |
| `texts` | | override any strings (`Partial<Texts>`) |
| `onSuccess(extra)` | required | sign-in succeeded; `extra` is what `onAuthenticated` returned on the server |
| `onDenied(reason, message)` | | the server did not let this address in |

Returns `{ open(), close(), destroy(), element }`.

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
