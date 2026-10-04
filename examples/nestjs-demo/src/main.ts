// Minimal NestJS app with Secret Keeper sign-in: the module under /api/sk,
// a page with the widget at /, a cookie session, /me reads it. Signed in,
// the page also shows a card form with "Fill from Secret Keeper" (§ 4.6).
//
//   SK_SERVER_MNEMONIC="word1 … word12" npm run demo
//
// Without a mnemonic in the environment a random one is generated for the
// lifetime of the process (the server address changes on every start,
// which is fine for a demo).
// DEMO_FAKE_PHONE=1 enables /demo/phone: an app emulation to go through
// the sign-in without a phone (development only, see phone.ts).

import 'reflect-metadata';

import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateMnemonic, ownerKey, type AccessDecision } from '@paymastech/sk-login-core';
import { SkLoginModule } from '@paymastech/sk-login-nestjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakePhoneController } from './phone.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const widgetJs = readFileSync(require.resolve('@paymastech/sk-login-widget/iife'), 'utf8');
const indexHtml = readFileSync(join(here, 'index.html'), 'utf8');

interface User {
  address: string;
}

/** Demo sessions: token to user, in memory. */
const sessions = new Map<string, User>();
const sessionToken = (req: any) => /(?:^|;\s*)demo_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

@Controller()
class PagesController {
  @Get()
  index(@Res() res: any) {
    res.type('text/html').send(indexHtml);
  }

  @Get('sk-login-widget.js')
  widget(@Res() res: any) {
    res.type('application/javascript').send(widgetJs);
  }

  @Get('me')
  me(@Req() req: any, @Res() res: any) {
    const token = /(?:^|;\s*)demo_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = token ? sessions.get(token) : undefined;
    res.type('application/json').send(JSON.stringify(user ? { user } : { user: null }));
  }

  @Get('logout')
  logout(@Req() req: any, @Res() res: any) {
    const token = /(?:^|;\s*)demo_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (token) sessions.delete(token);
    res.header('set-cookie', 'demo_session=; Path=/; Max-Age=0').redirect('/');
  }
}

const mnemonic = process.env.SK_SERVER_MNEMONIC ?? generateMnemonic().join(' ');

@Module({
  imports: [
    SkLoginModule.forRoot<User>({
      mnemonic,
      // SK_HUB=auth_secretkeeper switches the QR to hub mode (see README, "Hub");
      // SK_OWNER_ADDRESS is your own sk1… address for the hub catalog.
      target: { id: process.env.SK_TARGET ?? 'demo', hub: process.env.SK_HUB, owner: process.env.SK_OWNER_ADDRESS },
      // The demo lets everyone in: a real service would look up the user by
      // the sk1… address here, check an allowlist or link to an account.
      access: async (address): Promise<AccessDecision<User>> => ({ kind: 'granted', user: { address } }),
      // The browser learned about admission: issue a cookie session. You may
      // also return fields for the JSON reply (the widget passes them to onSuccess).
      onAuthenticated: (user, { res }) => {
        const token = randomBytes(24).toString('base64url');
        sessions.set(token, user);
        res.header('set-cookie', `demo_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
        return { address: user.address };
      },
      // Data requests (§ 4.6): the owner of a request is the page session;
      // only it receives the record. Here anyone with a session cookie.
      dataRequest: {
        owner: ({ req }) => {
          const token = sessionToken(req);
          return token && sessions.has(token) ? ownerKey(token) : undefined;
        },
      },
    }),
  ],
  controllers: [PagesController, ...(process.env.DEMO_FAKE_PHONE ? [FakePhoneController] : [])],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn'] });
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`demo: http://localhost:${port}/  target: http://localhost:${port}/api/sk/target`);
