import { Inject, Injectable } from '@nestjs/common';
import {
  type DataReply,
  type DataRequestInit,
  type DataRequestPoll,
  type EnvelopeReply,
  type InitResult,
  type Kind,
  type Lang,
  type PollResult,
  type RequestContext,
  SK_LOGIN_VERSION,
  SkDataRequest,
  SkLogin,
  identityFromMnemonic,
  keyCheckDigits,
} from '@paymastech/sk-login-core';
import QRCode from 'qrcode';

import { SK_LOGIN_OPTIONS, type SkLoginModuleOptions } from './options.js';

export interface TargetInfo {
  id: string;
  /** Present in hub mode: the hub's target id the QR points at. */
  hub?: string;
  v: number;
  url: string;
  /** Present when data requests are configured: the `data` route for the app. */
  requestUrl?: string;
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
  /** Data requests (§ 4.6); undefined without the `dataRequest` option. */
  readonly request: SkDataRequest | undefined;
  private readonly checkDigits: string;

  constructor(@Inject(SK_LOGIN_OPTIONS) readonly options: SkLoginModuleOptions<User>) {
    const identity = options.identity ?? (options.mnemonic ? identityFromMnemonic(options.mnemonic) : undefined);
    if (!identity) throw new Error('SkLoginModule: either `mnemonic` or `identity` is required');
    this.login = new SkLogin<User>({
      identity,
      target: options.target.id,
      hub: options.target.hub,
      access: options.access,
      store: options.store,
      ttlMs: options.ttlMs,
      describe: options.describe,
      geo: options.geo,
      messages: options.messages,
    });
    this.request = options.dataRequest
      ? new SkDataRequest({
          identity,
          target: options.target.id,
          hub: options.target.hub,
          store: options.dataRequest.store,
          ttlMs: options.dataRequest.ttlMs ?? options.ttlMs,
          describe: options.describe,
          geo: options.geo,
          messages: options.messages,
        })
      : undefined;
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

  /** Data request plus the QR as SVG; throws without the `dataRequest` option. */
  async initRequest(kind: Kind, owner: string, ctx?: RequestContext): Promise<DataRequestInit & { qrSvg?: string }> {
    const init = await this.dataRequest().init(kind, owner, ctx);
    if (this.options.qr === false) return init;
    const qrSvg = await QRCode.toString(init.payloadUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'H' });
    return { ...init, qrSvg };
  }

  handleDataEnvelope(body: string, lang: Lang): Promise<DataReply> {
    return this.dataRequest().handleEnvelope(body, lang);
  }

  pollRequest(sid: string, owner: string): Promise<DataRequestPoll> {
    return this.dataRequest().poll(sid, owner);
  }

  /** Parameters for the target entry in the Secret Keeper app (or the hub registry). */
  target(loginUrl: string, requestUrl?: string): TargetInfo {
    return {
      id: this.options.target.id,
      ...(this.options.target.hub ? { hub: this.options.target.hub } : {}),
      v: SK_LOGIN_VERSION,
      url: loginUrl,
      ...(this.request && requestUrl ? { requestUrl } : {}),
      serverAddress: this.serverAddress,
      checkDigits: this.checkDigits,
    };
  }

  private dataRequest(): SkDataRequest {
    if (!this.request) throw new Error('SkLoginModule: data requests are not configured (`dataRequest` option)');
    return this.request;
  }
}
