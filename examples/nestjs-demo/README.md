# nestjs-demo

A minimal NestJS application with `SkLoginModule` and the widget: a page
with a "Sign in" button, an in-memory cookie session, `GET /me`, `GET /logout`.

```bash
npm i && npm run build          # from the repository root
npm run demo                    # http://localhost:3000, random mnemonic
SK_SERVER_MNEMONIC="…" SK_TARGET=my-service npm run demo
SK_TARGET=my-service SK_HUB=auth_secretkeeper npm run demo   # QR in hub mode, see README "Hub"
```

Phone emulation for development without the app:

```bash
DEMO_FAKE_PHONE=1 npm run demo
# open the popup, take the sid from the "Sign in with the app" link, then
curl -X POST 'http://localhost:3000/demo/phone?sid=…'           # request + code: signs in right away
curl -X POST 'http://localhost:3000/demo/phone?sid=…&show=1'    # request only, the code is in the reply (for manual entry)
curl -X POST 'http://localhost:3000/demo/phone?sid=…&cancel=1'  # request + cancel
```
