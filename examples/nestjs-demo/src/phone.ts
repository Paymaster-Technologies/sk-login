// Secret Keeper app emulation for development without a phone: given a
// sid, it does what sendSkLogin does in the app: request, challenge
// parsing, code. Enabled with DEMO_FAKE_PHONE=1, not needed in production.
//
//   POST /demo/phone?sid=…           request + code: the sign-in completes right away
//   POST /demo/phone?sid=…&show=1    request only, the code is returned in the reply
//                                    (to test manual entry)
//   POST /demo/phone?sid=…&cancel=1  request + cancel

import { Controller, Inject, Post, Query, Res } from '@nestjs/common';
import {
  decryptEnvelope,
  deriveIdentityKeys,
  encryptEnvelope,
  extractArmor,
  generateMnemonic,
  loginMeta,
} from '@paymastech/sk-login-core';
import { SkLoginService } from '@paymastech/sk-login-nestjs';

const phone = deriveIdentityKeys(generateMnemonic());

@Controller('demo')
export class FakePhoneController {
  constructor(@Inject(SkLoginService) private readonly sk: SkLoginService) {}

  @Post('phone')
  async act(@Query('sid') sid: string, @Query('show') show: string | undefined, @Query('cancel') cancel: string | undefined, @Res() res: any) {
    const target = this.sk.options.target.id;
    const to = this.sk.serverAddress;
    const envelope = (type: string, plaintext = '', challenge?: number) =>
      encryptEnvelope({ sender: phone, recipientAddress: to, plaintext, meta: loginMeta(target, type, sid, challenge) });
    try {
      const reply = await this.sk.handleEnvelope(envelope('sk-login', '', 2), 'ru');
      if (reply.kind !== 'challenge') throw new Error(reply.kind);
      const content = decryptEnvelope({ recipient: phone, armored: extractArmor(reply.armored) });
      const { code, items } = JSON.parse(content.text) as { code: string; items: unknown[] };
      if (cancel) {
        await this.sk.handleEnvelope(envelope('sk-login-cancel'), 'ru');
        return res.type('application/json').send(JSON.stringify({ cancelled: true, items }));
      }
      if (show) return res.type('application/json').send(JSON.stringify({ code, items }));
      await this.sk.handleEnvelope(envelope('sk-login-code', code), 'ru');
      res.type('application/json').send(JSON.stringify({ sent: true, items, address: phone.address }));
    } catch (e) {
      res.status(400).type('application/json').send(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
