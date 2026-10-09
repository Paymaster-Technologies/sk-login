// Sign-in through Secret Keeper, server side (secret_keeper:
// docs/HANDOFF_SK_LOGIN.md, docs/protocol.md § 4.5; the client is
// lib/services/sk_login.dart).
//
// Steps:
//   1. The browser opens the sign-in popup; init issues a one-time sid and
//      the payload string `https://secretkeeper.net/auth?v=1&sid=…&site=<host>&address=<sk1…>`
//      (a QR for another device, `sk://auth?…` for the same one). The app
//      takes the server address from the QR, like a contact's, and derives
//      the endpoint from the host: `https://<host>/sk/login`. An embedded
//      target (`target=<id>`) is the older form for apps built into Secret
//      Keeper (payload.ts).
//   2. The app POSTs a raw armored envelope (empty text, meta
//      {type:"sk-login", data:{target:<host or id>,v,sid}}) to the endpoint.
//   3. The server decrypts it: a successful decrypt authenticates the
//      sender address (static-static ECDH in the KEK). It replies with a
//      challenge envelope carrying a one-time code (meta sk-login-challenge);
//      the two-step mode closes KCI if the server key leaks. If the app sent
//      `challenge: 2` in meta, the reply is challenge v2 (context.ts): JSON
//      with the code and a name-value list describing the browser that got
//      the sid; the app shows it before asking for confirmation.
//   4. The app returns the code in an sk-login-code envelope (same sender).
//      If it matches, the address is authenticated and admission is decided
//      right here (`access` in the options): granted gives 200
//      `{"sent": true}` (the browser picks up the result by polling); denied
//      gives 403 `access-denied` with a user-facing text, and the request
//      moves to the denied state. If the step 4 POST from the phone fails
//      (network), the app shows the code to the person, who types it into
//      the browser: submitCode accepts the code for a request in challenged.
//   5. The browser polls; on authenticated it receives the user (for its
//      session) and moves on, on denied it shows the refusal.
//   "Cancel" on the confirmation sheet: the app sends an sk-login-cancel
//   envelope (empty text, same sid, same sender). A request in challenged
//   moves to cancelled, reply 204; the browser shows "Declined in Secret
//   Keeper" on the next poll instead of waiting for the TTL.
//
// Errors are LoginError with a status, a reason code and a text; the API
// returns them as JSON `{error, message}` (protocol § 4.5, "refusals").

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import {
  CHALLENGE_V1,
  challengePlaintext,
  challengeVersion,
  describeContext,
  type Describe,
  type GeoLookup,
  type RequestContext,
} from './context.js';
import { decryptEnvelope, encryptEnvelope, extractArmor, senderAddressFromArmor } from './crypto/envelope.js';
import { type IdentityKeys, keyCheckDigits } from './crypto/identity.js';
import { type Lang, type Messages, mergeMessages } from './i18n.js';
import { SK_LOGIN_VERSION, type Service, type ServiceOptions, resolveService } from './payload.js';
import { MemoryPendingStore, type Pending, type PendingState, type PendingStore } from './store.js';

export { SK_LOGIN_VERSION };
/** Secret Keeper dispatcher page: universal link, used by the QR and the button. */
export const SK_AUTH_URL = 'https://secretkeeper.net/auth';
/** Custom app scheme for the "Sign in with the app" button on the same device. */
export const SK_AUTH_SCHEME_URL = 'sk://auth';

/** Default request lifetime: when it runs out the popup offers to refresh
 *  the QR. Once the app has scanned the code (challenged) the countdown
 *  restarts: the person is already in the dialog, cutting them off on the
 *  consent screen would be silly. */
export const DEFAULT_SID_TTL_MS = 2 * 60 * 1000;
/** How many wrong codes we tolerate per sid (the code is short, so it can be brute-forced). */
export const MAX_CODE_ATTEMPTS = 5;
const CODE_LENGTH = 6;

export type { Pending, PendingState, PendingStore };

/** Refusal reason codes in the JSON error for the app. */
export type RefusalCode =
  | 'bad-envelope'
  | 'bad-meta'
  | 'in-progress'
  | 'sid-expired'
  | 'code-invalid'
  | 'access-denied'
  | 'kind-mismatch';

/** Protocol error: HTTP status, reason code and user-facing text;
 *  `access-denied` also carries the service's refusal reason (for the browser). */
export class LoginError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: RefusalCode,
    message: string,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

/**
 * The service's admission decision for a proven address. `user` is anything
 * JSON-serializable: the browser receives it on poll for its session.
 * `reason` is a code for the service and the browser (e.g. `unknown`,
 * `blocked`), `message` is a per-language user-facing text replacing the
 * generic one.
 */
export type AccessDecision<User> =
  | { kind: 'granted'; user: User }
  | { kind: 'denied'; reason: string; message?: Partial<Record<Lang, string>> };

/** The request the decision is about: lets the service tie the proven
 *  address to the account the request was created for (second factor,
 *  binding) and refuse right here, so the app shows the refusal too. */
export interface AccessRequest {
  sid: string;
  /** The browser that opened the request, as given to `init`. */
  ctx?: RequestContext;
}

export type AccessDecider<User> = (address: string, request: AccessRequest) => AccessDecision<User> | Promise<AccessDecision<User>>;

export interface SkLoginOptions<User> extends ServiceOptions {
  /** Server identity (deriveIdentityKeys from the mnemonic). Its sk1…
   *  address goes to the QR: the app encrypts to it and checks the
   *  challenge comes from it. */
  identity: IdentityKeys;
  /** Who to let in. Called once per sign-in, after the code check. */
  access: AccessDecider<User>;
  /** Request store; process memory by default. */
  store?: PendingStore<User>;
  /** Request lifetime, ms. */
  ttlMs?: number;
  /** Context lines for challenge v2; by default IP, browser and OS,
   *  plus "Location" when `geo` is given. */
  describe?: Describe;
  geo?: GeoLookup;
  /** Text overrides (refusal, context labels). */
  messages?: Partial<Record<Lang, Partial<Messages>>>;
  now?: () => number;
}

export interface InitResult {
  sid: string;
  /** QR string and universal link. */
  payloadUrl: string;
  /** The same query on the custom scheme, for the button on the same device. */
  schemeUrl: string;
  /** Deadline by the server clock. */
  expiresAt: number;
  ttlMs: number;
  /** Time left by the server clock; equals `ttlMs` here, see `PollResult`. */
  expiresInMs: number;
}

export type EnvelopeReply =
  | { kind: 'challenge'; armored: string }
  | { kind: 'code-accepted'; address: string }
  | { kind: 'cancelled' };

/** `expiresInMs` comes with an open request (`new`, `challenged`): time left
 *  by the server clock, so the browser's countdown follows the server (the
 *  TTL restarts on `challenged`) without comparing clocks. A service with
 *  its own, shorter deadline passes the smaller value through. */
export type PollResult<User> = { state: PendingState | 'expired'; user?: User; reason?: string; expiresInMs?: number };

/** Public information about the service (`GET target`), readable by humans
 *  and agents. The protocol does not need it: the app takes the address
 *  from the QR. */
export interface TargetInfo {
  /** `site` or the embedded target id: what `meta.data.target` carries. */
  id: string;
  /** Present for a site. */
  site?: string;
  v: number;
  /** The `login` endpoint. */
  url: string;
  /** Present when the service accepts data requests: the `request` endpoint. */
  requestUrl?: string;
  serverAddress: string;
  /** Check digits of the address: visual comparison with the app. */
  checkDigits: string;
}

export class SkLogin<User = unknown> {
  /** `site` or the embedded target id: what `meta.data.target` carries. */
  readonly target: string;
  readonly site: string | undefined;
  readonly ttlMs: number;
  private readonly service: Service;
  readonly messages: Record<Lang, Messages>;
  private readonly identity: IdentityKeys;
  private readonly access: AccessDecider<User>;
  private readonly store: PendingStore<User>;
  private readonly describe: Describe;
  private readonly now: () => number;

  constructor(options: SkLoginOptions<User>) {
    this.identity = options.identity;
    this.service = resolveService(options);
    this.target = this.service.id;
    this.site = this.service.site;
    this.access = options.access;
    this.ttlMs = options.ttlMs ?? DEFAULT_SID_TTL_MS;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new MemoryPendingStore<User>(this.now);
    this.messages = mergeMessages(options.messages);
    this.describe = options.describe ?? ((ctx, lang) => describeContext(ctx, lang, this.messages, options.geo));
  }

  get serverAddress(): string {
    return this.identity.address;
  }

  /** The `GET target` document. `requestUrl` only when the service also
   *  runs SkDataRequest. */
  targetInfo(loginUrl: string, requestUrl?: string): TargetInfo {
    return {
      id: this.target,
      ...(this.site ? { site: this.site } : {}),
      v: SK_LOGIN_VERSION,
      url: loginUrl,
      ...(requestUrl ? { requestUrl } : {}),
      serverAddress: this.identity.address,
      checkDigits: keyCheckDigits(this.identity.x25519Public),
    };
  }

  /** Step 1: a new request; `ctx` is the browser that opened it. */
  async init(ctx?: RequestContext): Promise<InitResult> {
    const sid = randomBytes(24).toString('base64url');
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    await this.save({ sid, createdAt, expiresAt, state: 'new', ctx, codeAttempts: 0 });
    const query = this.service.query(sid, this.identity.address);
    return {
      sid,
      payloadUrl: `${SK_AUTH_URL}?${query}`,
      schemeUrl: `${SK_AUTH_SCHEME_URL}?${query}`,
      expiresAt,
      ttlMs: this.ttlMs,
      expiresInMs: this.ttlMs,
    };
  }

  /** Steps 3-4: an envelope from the app (request, code or cancel). `lang`
   *  is the language of the user-facing refusal text (request Accept-Language). */
  async handleEnvelope(body: string, lang: Lang = 'en'): Promise<EnvelopeReply> {
    let armored: string;
    try {
      armored = extractArmor(body);
    } catch {
      throw new LoginError(400, 'bad-envelope', 'body is not a Secret Keeper envelope');
    }
    let text: string;
    let metaRaw: string | undefined;
    try {
      const content = decryptEnvelope({ recipient: this.identity, armored });
      text = content.text;
      metaRaw = content.meta;
    } catch {
      throw new LoginError(400, 'bad-envelope', 'envelope is not addressed to this server or is damaged');
    }
    // After a successful decrypt the address from the header is
    // authenticated: the slot KEK includes ECDH with the sender's static key.
    const sender = senderAddressFromArmor(armored);
    const meta = this.parseMeta(metaRaw);
    const entry = await this.live(meta.sid);

    if (meta.type === 'sk-login') {
      if (entry.state !== 'new') {
        throw new LoginError(409, 'in-progress', 'this sign-in request is already in progress');
      }
      entry.state = 'challenged';
      entry.sender = sender;
      entry.code = generateCode();
      entry.expiresAt = this.now() + this.ttlMs;
      const { plaintext, challenge: cv } = challengePlaintext(entry.code, entry.ctx, lang, meta.challenge, this.describe);
      const challenge = encryptEnvelope({
        sender: this.identity,
        recipientAddress: sender,
        plaintext,
        meta: loginMeta(this.target, 'sk-login-challenge', entry.sid, cv),
        sentAtMs: this.now(),
      });
      await this.save(entry);
      return { kind: 'challenge', armored: challenge };
    }

    if (meta.type === 'sk-login-code') {
      if (entry.state !== 'challenged' || entry.sender !== sender) {
        throw new LoginError(409, 'in-progress', 'no challenge is waiting for this sender');
      }
      await this.checkCode(entry, text);
      // The code matched: the address is proven, decide admission right
      // here so the refusal reaches the app and not only the browser.
      entry.state = 'authenticated';
      entry.user = await this.admit(entry, sender, lang);
      await this.save(entry);
      return { kind: 'code-accepted', address: sender };
    }

    if (meta.type === 'sk-login-cancel') {
      // Only the sender of the request may cancel, and only while we wait
      // for the code: a stranger who saw the QR cannot kill somebody else's
      // request, in new there is no request yet, in authenticated/used the
      // sign-in has already happened.
      if (entry.state !== 'challenged' || entry.sender !== sender) {
        throw new LoginError(409, 'in-progress', 'nothing to cancel for this sender');
      }
      entry.state = 'cancelled';
      entry.code = undefined;
      await this.save(entry);
      return { kind: 'cancelled' };
    }

    throw new LoginError(400, 'bad-meta', `unexpected envelope type: ${meta.type}`);
  }

  /**
   * Manual code entry in the browser: the app showed the code because its
   * POST never reached the server, and the request is still in challenged.
   * The browser is right here, so an admitted user is returned immediately
   * and the request is closed (`used`); a refusal is LoginError 403 and the
   * denied state.
   */
  async submitCode(sid: string, code: string, lang: Lang = 'en'): Promise<User> {
    const entry = await this.live(sid);
    if (entry.state !== 'challenged' || !entry.sender) {
      throw new LoginError(409, 'in-progress', 'no challenge is waiting for this request');
    }
    await this.checkCode(entry, code);
    entry.state = 'used';
    const user = await this.admit(entry, entry.sender, lang);
    await this.store.delete(sid);
    return user;
  }

  /**
   * Poll from the browser. `authenticated` is returned once (with the user
   * for the session): the request is moved to `used` right away so that a
   * second request with the same sid does not get a session. `denied` comes
   * with the reason, for the refusal text.
   */
  async poll(sid: string): Promise<PollResult<User>> {
    const entry = await this.store.get(sid);
    if (!entry || entry.expiresAt + this.ttlMs < this.now() || entry.state === 'used') return { state: 'expired' };
    const open = entry.state === 'new' || entry.state === 'challenged';
    if (open && entry.expiresAt < this.now()) return { state: 'expired' };
    if (entry.state === 'authenticated') {
      await this.store.delete(sid);
      return { state: 'authenticated', user: entry.user };
    }
    if (entry.state === 'denied') return { state: 'denied', reason: entry.denied };
    if (open) return { state: entry.state, expiresInMs: entry.expiresAt - this.now() };
    return { state: entry.state };
  }

  /** Code check: a miss is 400, attempts exhausted is 410 and the request is deleted. */
  private async checkCode(entry: Pending<User>, code: string): Promise<void> {
    const expected = entry.code ?? '';
    const given = code.trim();
    const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) {
      entry.codeAttempts += 1;
      if (entry.codeAttempts >= MAX_CODE_ATTEMPTS) {
        await this.store.delete(entry.sid);
        throw new LoginError(410, 'code-invalid', 'too many wrong codes, request a new QR');
      }
      await this.save(entry);
      throw new LoginError(400, 'code-invalid', 'wrong code');
    }
    entry.code = undefined;
  }

  /** Admission of a proven address: the user, or 403 with a text in `lang`. */
  private async admit(entry: Pending<User>, address: string, lang: Lang): Promise<User> {
    const decision = await this.access(address, { sid: entry.sid, ctx: entry.ctx });
    if (decision.kind === 'granted') return decision.user;
    entry.state = 'denied';
    entry.denied = decision.reason;
    await this.save(entry);
    const message = decision.message?.[lang] ?? decision.message?.en ?? this.messages[lang].accessDenied;
    throw new LoginError(403, 'access-denied', message, decision.reason);
  }

  /** Live request by sid; a stale or unknown one is a 4xx "code expired". */
  private async live(sid: string): Promise<Pending<User>> {
    const entry = await this.store.get(sid);
    // A settled request stays visible to the browser but is closed for
    // envelopes: its fate is decided.
    if (!entry || entry.expiresAt < this.now() || entry.state === 'used') {
      throw new LoginError(404, 'sid-expired', 'sign-in request expired, refresh the QR code');
    }
    return entry;
  }

  /** The record lives one TTL past its deadline: the browser still has to pick up a settled request. */
  private save(entry: Pending<User>): Promise<void> {
    return this.store.set(entry, Math.max(0, entry.expiresAt + this.ttlMs - this.now()));
  }

  private parseMeta(raw: string | undefined): LoginMeta {
    if (!raw) throw new LoginError(400, 'bad-meta', 'envelope has no meta');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LoginError(400, 'bad-meta', 'envelope meta is not JSON');
    }
    const meta = parsed as {
      type?: unknown;
      data?: { target?: unknown; v?: unknown; sid?: unknown; challenge?: unknown };
    };
    if (typeof meta?.type !== 'string' || typeof meta.data?.sid !== 'string') {
      throw new LoginError(400, 'bad-meta', 'envelope meta lacks type or sid');
    }
    if (!this.service.accepts(meta.data.target) || Number(meta.data.v) !== SK_LOGIN_VERSION) {
      throw new LoginError(400, 'bad-meta', 'envelope is meant for another service or protocol version');
    }
    return { type: meta.type, sid: meta.data.sid, challenge: challengeVersion(meta.data.challenge) };
  }
}

interface LoginMeta {
  type: string;
  sid: string;
  /** Challenge version the app understands (no field means 1). */
  challenge: number;
}

/** meta of login envelopes: the sid sits inside the AEAD, not in the transport.
 *  `challenge` is written only for v2 so that v1 envelopes stay unchanged. */
export function loginMeta(target: string, type: string, sid: string, challenge: number = CHALLENGE_V1): string {
  const data: Record<string, unknown> = { target, v: SK_LOGIN_VERSION, sid };
  if (challenge > CHALLENGE_V1) data.challenge = challenge;
  return JSON.stringify({ type, data });
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += randomInt(0, 10);
  return code;
}
