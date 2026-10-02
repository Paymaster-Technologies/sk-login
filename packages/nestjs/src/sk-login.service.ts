import { Inject, Injectable } from '@nestjs/common';
import {
  type EnvelopeReply,
  type InitResult,
  type Lang,
  type PollResult,
  type RequestContext,
  SK_LOGIN_VERSION,
  SkLogin,
  identityFromMnemonic,
  keyCheckDigits,
} from '@paymastech/sk-login-core';
import QRCode from 'qrcode';

import { SK_LOGIN_OPTIONS, type SkLoginModuleOptions } from './options.js';

export interface TargetInfo {
  id: string;
  v: number;
  url: string;
  serverAddress: string;
  /** Check digits of the address: visual comparison with the app. */
  checkDigits: string;
}

/**
 * Wrapper around SkLogin from core for Nest: one instance per application,
 * injectable into your own controllers and services (for example to show
 * the server address in an admin panel).
 */
@Injectable()
export class SkLoginService<User = unknown> {
  readonly login: SkLogin<User>;
  private readonly checkDigits: string;

  constructor(@Inject(SK_LOGIN_OPTIONS) readonly options: SkLoginModuleOptions<User>) {
    const identity = options.identity ?? (options.mnemonic ? identityFromMnemonic(options.mnemonic) : undefined);
    if (!identity) throw new Error('SkLoginModule: either `mnemonic` or `identity` is required');
    this.login = new SkLogin<User>({
      identity,
      target: options.target.id,
      access: options.access,
      store: options.store,
      ttlMs: options.ttlMs,
      describe: options.describe,
      geo: options.geo,
      messages: options.messages,
    });
    this.checkDigits = keyCheckDigits(identity.x25519Public);
  }

  get serverAddress(): string {
    return this.login.serverAddress;
  }

  /** Request plus the QR as SVG (level H: the widget may draw a logo in the center). */
  async init(ctx?: RequestContext): Promise<InitResult & { qrSvg?: string }> {
    const init = await this.login.init(ctx);
    if (this.options.qr === false) return init;
    const qrSvg = await QRCode.toString(init.payloadUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'H' });
    return { ...init, qrSvg };
  }

  handleEnvelope(body: string, lang: Lang): Promise<EnvelopeReply> {
    return this.login.handleEnvelope(body, lang);
  }

  submitCode(sid: string, code: string, lang: Lang): Promise<User> {
    return this.login.submitCode(sid, code, lang);
  }

  poll(sid: string): Promise<PollResult<User>> {
    return this.login.poll(sid);
  }

  /** Parameters for the target entry in the Secret Keeper app. */
  target(loginUrl: string): TargetInfo {
    return {
      id: this.options.target.id,
      v: SK_LOGIN_VERSION,
      url: loginUrl,
      serverAddress: this.serverAddress,
      checkDigits: this.checkDigits,
    };
  }
}
