import { Body, Controller, Get, Inject, Logger, Post, Query, Req, Res, type Type } from '@nestjs/common';
import { LoginError, contextFromHeaders, langFromAcceptLanguage } from '@paymastech/sk-login-core';

import { DEFAULT_MAX_BODY, SK_LOGIN_OPTIONS, type SkLoginModuleOptions } from './options.js';
import { SkLoginService } from './sk-login.service.js';

/** Platform reply (Express `Response` or Fastify `FastifyReply`): the common subset. */
interface Reply {
  status(code: number): Reply;
  header(name: string, value: string): Reply;
  type(value: string): Reply;
  send(body?: unknown): unknown;
}

/**
 * Five sign-in routes under a prefix (`api/sk` by default), the same contract
 * as lashin.su (secret_keeper/docs/HANDOFF_LASHIN_SU_LOGIN_ERRORS.md):
 *
 *   POST init           request: sid, payloadUrl, schemeUrl, ttlMs, qrSvg (widget)
 *   POST login          endpoint from the app's target list: raw text/plain envelope;
 *                       200 challenge envelope | 200 {sent:true} | 204 (cancel) | 4xx {error, message}
 *   GET  status?sid=    poll from the browser: {state[, reason][, ...onAuthenticated]}
 *   POST code           manual code entry {sid, code}: 200 {ok[, ...]} | 403 {denied, reason} | 4xx {error}
 *   GET  target         parameters for the entry in the app's skLoginTargets
 *
 * The class is created by a factory so that the prefix can be a module parameter.
 */
export function createSkLoginController(prefix: string): Type<unknown> {
  @Controller(prefix)
  class SkLoginController {
    private readonly log = new Logger('SkLogin');

    constructor(
      @Inject(SkLoginService) private readonly sk: SkLoginService,
      @Inject(SK_LOGIN_OPTIONS) private readonly options: SkLoginModuleOptions,
    ) {}

    @Post('init')
    async init(@Req() req: any, @Res() res: Reply) {
      const ctx = contextFromHeaders((n) => req.headers?.[n], remoteAddress(req), this.options.trustProxy !== false);
      const init = await this.sk.init(ctx);
      json(res, 200, init);
    }

    @Post('login')
    async login(@Req() req: any, @Res() res: Reply) {
      const lang = langFromAcceptLanguage(req.headers?.['accept-language']);
      let body: string;
      try {
        body = await rawBody(req, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY);
      } catch {
        return json(res, 413, { error: 'bad-envelope', message: 'body too large' });
      }
      try {
        const reply = await this.sk.handleEnvelope(body, lang);
        // One line per envelope: the app swallows refusals (especially on
        // cancel), so the server log is the only place where the outcome is visible.
        this.log.log(reply.kind);
        if (reply.kind === 'challenge') {
          res.status(200).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(reply.armored);
          return;
        }
        if (reply.kind === 'cancelled') {
          res.status(204).header('cache-control', 'no-store').send();
          return;
        }
        json(res, 200, { sent: true });
      } catch (e) {
        if (e instanceof LoginError) {
          this.log.log(`${e.status} ${e.code}: ${e.message}`);
          return json(res, e.status, { error: e.code, message: e.message });
        }
        this.log.error('unexpected', e instanceof Error ? e.stack : String(e));
        json(res, 500, { error: 'internal', message: 'internal error' });
      }
    }

    @Get('status')
    async status(@Query('sid') sid: string | undefined, @Req() req: any, @Res() res: Reply) {
      const result = await this.sk.poll(sid ?? '');
      if (result.state === 'authenticated') {
        const extra = await this.options.onAuthenticated?.(result.user, { req, res });
        return json(res, 200, { state: 'authenticated', ...extra });
      }
      if (result.state === 'denied') return json(res, 200, { state: 'denied', reason: result.reason });
      json(res, 200, { state: result.state });
    }

    @Post('code')
    async code(@Body() payload: unknown, @Req() req: any, @Res() res: Reply) {
      const p = (payload ?? {}) as { sid?: unknown; code?: unknown };
      if (typeof p.sid !== 'string' || typeof p.code !== 'string') return json(res, 400, { error: 'bad-json' });
      const lang = langFromAcceptLanguage(req.headers?.['accept-language']);
      try {
        const user = await this.sk.submitCode(p.sid, p.code, lang);
        const extra = await this.options.onAuthenticated?.(user, { req, res });
        json(res, 200, { ok: true, ...extra });
      } catch (e) {
        if (e instanceof LoginError) {
          // The widget takes the refusal text from its own dictionary by reason.
          if (e.code === 'access-denied') return json(res, 403, { denied: true, reason: e.reason, message: e.message });
          return json(res, e.status, { error: e.code });
        }
        this.log.error('unexpected', e instanceof Error ? e.stack : String(e));
        json(res, 500, { error: 'internal' });
      }
    }

    @Get('target')
    target(@Req() req: any, @Res() res: Reply) {
      const origin = this.options.target.publicUrl?.replace(/\/$/, '') ?? originOf(req);
      res
        .status(200)
        .type('application/json')
        .send(JSON.stringify(this.sk.target(`${origin}/${prefix.replace(/^\/|\/$/g, '')}/login`), null, 2));
    }
  }
  return SkLoginController;
}

function json(res: Reply, status: number, body: unknown): void {
  res.status(status).header('cache-control', 'no-store').type('application/json').send(JSON.stringify(body));
}

function remoteAddress(req: any): string | undefined {
  return req.socket?.remoteAddress ?? req.raw?.socket?.remoteAddress ?? req.ip;
}

function originOf(req: any): string {
  const h = req.headers ?? {};
  const proto = String(h['x-forwarded-proto'] ?? (req.protocol || 'http')).split(',')[0].trim();
  const host = String(h['x-forwarded-host'] ?? h.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

/**
 * Envelope body as a string. Express without `express.text()` does not read
 * the stream, so we read it ourselves (`req` is the stream). Fastify and
 * Nest's `rawBody: true` put the already read body into `req.body` / `req.rawBody`.
 */
async function rawBody(req: any, limit: number): Promise<string> {
  if (typeof req.body === 'string') return sized(req.body, limit);
  if (req.rawBody) return sized(Buffer.from(req.rawBody).toString('utf8'), limit);
  const stream = typeof req.on === 'function' ? req : req.raw;
  if (!stream || typeof stream.on !== 'function') return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += b.length;
    if (total > limit) throw new Error('body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sized(body: string, limit: number): string {
  if (Buffer.byteLength(body) > limit) throw new Error('body too large');
  return body;
}
