# @paymastech/sk-login-widget

Secret Keeper sign-in popup for the browser: a QR code, a "with the app"
button on the same device, waiting for confirmation, manual code entry,
refusal and timeout screens, a bottom sheet on narrow screens. No
framework, about 30 KB, injects its own styles.

Works against the `init`, `status` and `code` routes mounted by
[`@paymastech/sk-login-nestjs`](https://www.npmjs.com/package/@paymastech/sk-login-nestjs)
or any adapter on top of `@paymastech/sk-login-core`.

## Setup

As a single file with the `SkLoginWidget` global:

```html
<!-- dist/sk-login-widget.global.js from the package, served by your static files
     (after the npm release: https://cdn.jsdelivr.net/npm/@paymastech/sk-login-widget/dist/sk-login-widget.global.js) -->
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

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiBase` | `/api/sk` | module route prefix (may be an absolute URL of another origin, then see `credentials`) |
| `lang` | `en` | `ru` or `en` |
| `texts` | | override any strings (`Partial<Texts>`) |
| `onSuccess(extra)` | required | sign-in succeeded; `extra` is what `onAuthenticated` returned on the server |
| `onDenied(reason, message)` | | the server did not let this address in |
| `onCancelled()` | | the user declined the request in the app |
| `onClose()` | | the popup was closed by the user |
| `theme` | by `prefers-color-scheme` | force `light` or `dark` |
| `logoUrl` | built-in | logo in the center of the QR |
| `skSiteUrl` | `https://secretkeeper.net` | where the "install Secret Keeper" link points |
| `headers`, `credentials` | `same-origin` | for fetch calls to the API (CSRF header, cookies for another origin) |
| `pollMs` | 2000 | `status` polling period |

`mountSkLogin` returns `{ open(), close(), destroy(), element }`.

## Appearance

Classes are prefixed with `skl-`, colors come from variables on `dialog.skl`:
`--skl-bg`, `--skl-item`, `--skl-text`, `--skl-secondary`, `--skl-primary`,
`--skl-primary-soft`, `--skl-separator`, `--skl-surface-high`,
`--skl-danger`, `--skl-font`. Override them on `:root` or on `.skl`.
