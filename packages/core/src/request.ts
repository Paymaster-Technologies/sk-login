// Data request from the Secret Keeper vault, server side (secret_keeper:
// docs/protocol.md § 4.6). The service asks for a record of type `kind`
// (a card, a login, personal data) and the app hands it over in an sk-data
// envelope. The envelopes mirror sign-in; the data travels only in the third.
//
// Steps:
//   1. A page with a session calls init(kind, owner): a one-time sid and the
//      payload `https://secretkeeper.net/request?v=1&sid=…&site=<host>&address=<sk1…>&kind=…`
//      (a QR for another device, `sk://request?…` for the same one); the
//      app derives the endpoint `https://<host>/sk/request` from the host.
//   2. The app POSTs an sk-data-request envelope (empty text, meta.data
//      {target, v, sid, kind}) to the data endpoint. The decrypt
//      authenticates the address; the reply is an sk-data-challenge envelope
//      with a one-time code (challenge v2 with the browser context when the
//      app asks for it, as in sign-in).
//   3. The app POSTs an sk-data envelope: the code in meta.data.code, the
//      field values of the `kind` dictionary as JSON in text. Code matched,
//      keys from the dictionary: the values wait in memory, state filled,
//      reply 204. A refusal is a 4xx JSON {error, message} as in sign-in.
//   4. The page polls: on filled it receives the values once (the request
//      moves to used and is wiped); another session never sees the request.
//   "Cancel" on the confirmation sheet: an sk-data-cancel envelope (empty
//   text, meta.data {target, v, sid} without kind) from the request sender
//   while in challenged moves it to cancelled, reply 204.
//
// There is no access list here: such a form usually lives on a page
// without sign-in (card payment, registration), any address may hand over
// a record. The values live only in the store until the first poll that
// returns them: never log them and never persist them.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

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
import type { IdentityKeys } from './crypto/identity.js';
import { type Lang, type Messages, mergeMessages } from './i18n.js';
import { DEFAULT_SID_TTL_MS, LoginError, MAX_CODE_ATTEMPTS } from './login.js';
import { SK_LOGIN_VERSION, type Service, type ServiceOptions, resolveService } from './payload.js';
import { MemorySidStore, type SidStore } from './store.js';

/** Secret Keeper dispatcher page for data requests: universal link. */
export const SK_REQUEST_URL = 'https://secretkeeper.net/request';
/** Custom app scheme for the button on the same device. */
export const SK_REQUEST_SCHEME_URL = 'sk://request';
const CODE_LENGTH = 6;

/** Vault record types and their field dictionaries (protocol § 4.6): an
 *  arbitrary set of fields cannot be requested. */
export const KINDS = {
  'login-password': ['site', 'login', 'password'],
  'card-details': ['holder', 'pan', 'exp', 'cvv', 'billingAddress'],
  'personal-data': ['name', 'birthdate', 'phone', 'email', 'address'],
} as const;

export type Kind = keyof typeof KINDS;
export const KIND_IDS = Object.keys(KINDS) as Kind[];

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && value in KINDS;
}

export type DataRequestState = 'new' | 'challenged' | 'filled' | 'cancelled' | 'used';

export interface DataPending {
  sid: string;
  kind: Kind;
  /** The page session that opened the request: only it receives the values. */
  owner: string;
  createdAt: number;
  expiresAt: number;
  state: DataRequestState;
  /** The browser that opened the request (challenge v2). */
  ctx?: RequestContext;
  sender?: string;
  code?: string;
  codeAttempts: number;
  /** Field values after step 3 (state filled), until the first poll. */
  values?: Record<string, string>;
  filledAt?: number;
}

export type DataRequestStore = SidStore<DataPending>;

export interface SkDataRequestOptions extends ServiceOptions {
  /** Server identity: the same one as for sign-in. */
  identity: IdentityKeys;
  /** Request store; process memory by default. */
  store?: DataRequestStore;
  /** Request lifetime, ms; restarts when the app scans (challenged), as in sign-in. */
  ttlMs?: number;
  /** Context lines for challenge v2; by default IP, browser and OS, plus "Location" with `geo`. */
  describe?: Describe;
  geo?: GeoLookup;
  /** Text overrides (kind mismatch, context labels). */
  messages?: Partial<Record<Lang, Partial<Messages>>>;
  now?: () => number;
}

export interface DataRequestInit {
  sid: string;
  kind: Kind;
  payloadUrl: string;
  schemeUrl: string;
  expiresAt: number;
  ttlMs: number;
}

export type DataReply = { kind: 'challenge'; armored: string } | { kind: 'filled'; address: string } | { kind: 'cancelled' };

export type DataRequestPoll =
  | { state: 'new' | 'challenged' | 'cancelled' | 'expired' }
  | { state: 'filled'; values: Record<string, string>; sender: string; filledAt: number };

/** Owner key from a session token: the token itself never sits in the store. */
export function ownerKey(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('base64url');
}

export class SkDataRequest {
  /** `site` or the embedded target id: what `meta.data.target` carries. */
  readonly target: string;
  readonly site: string | undefined;
  readonly ttlMs: number;
  private readonly service: Service;
  readonly messages: Record<Lang, Messages>;
  private readonly identity: IdentityKeys;
  private readonly store: DataRequestStore;
  private readonly describe: Describe;
  private readonly now: () => number;

  constructor(options: SkDataRequestOptions) {
    this.identity = options.identity;
    this.service = resolveService(options);
    this.target = this.service.id;
    this.site = this.service.site;
    this.ttlMs = options.ttlMs ?? DEFAULT_SID_TTL_MS;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new MemorySidStore<DataPending>(this.now);
    this.messages = mergeMessages(options.messages);
    this.describe = options.describe ?? ((ctx, lang) => describeContext(ctx, lang, this.messages, options.geo));
  }

  get serverAddress(): string {
    return this.identity.address;
  }

  /** Step 1: a new request for a record of `kind` from the session `owner`;
   *  `ctx` is the browser that opened it (challenge v2). */
  async init(kind: Kind, owner: string, ctx?: RequestContext): Promise<DataRequestInit> {
    const sid = randomBytes(24).toString('base64url');
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    await this.save({ sid, kind, owner, createdAt, expiresAt, state: 'new', ctx, codeAttempts: 0 });
    const query = this.service.query(sid, this.identity.address, { kind });
    return {
      sid,
      kind,
      payloadUrl: `${SK_REQUEST_URL}?${query}`,
      schemeUrl: `${SK_REQUEST_SCHEME_URL}?${query}`,
      expiresAt,
      ttlMs: this.ttlMs,
    };
  }

  /** Steps 2-3: an envelope from the app (request, data or cancel). */
  async handleEnvelope(body: string, lang: Lang = 'en'): Promise<DataReply> {
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
    const sender = senderAddressFromArmor(armored);
    const meta = this.parseMeta(metaRaw);
    const entry = await this.live(meta.sid);

    if (meta.type === 'sk-data-cancel') {
      // As sk-login-cancel: only the request sender, only while challenged.
      if (entry.state !== 'challenged' || entry.sender !== sender) {
        throw new LoginError(409, 'in-progress', 'nothing to cancel for this sender');
      }
      entry.state = 'cancelled';
      entry.code = undefined;
      await this.save(entry);
      return { kind: 'cancelled' };
    }

    // The app does not show the kind-mismatch text (it has its own "refresh
    // the QR"), but it goes out in the request language like other refusals.
    if (meta.kind !== entry.kind) throw new LoginError(400, 'kind-mismatch', this.messages[lang].kindMismatch);

    if (meta.type === 'sk-data-request') {
      if (entry.state !== 'new') {
        throw new LoginError(409, 'in-progress', 'this data request is already in progress');
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
        meta: requestMeta(this.target, 'sk-data-challenge', entry.sid, entry.kind, undefined, cv),
        sentAtMs: this.now(),
      });
      await this.save(entry);
      return { kind: 'challenge', armored: challenge };
    }

    if (meta.type === 'sk-data') {
      if (entry.state !== 'challenged' || entry.sender !== sender) {
        throw new LoginError(409, 'in-progress', 'no challenge is waiting for this sender');
      }
      await this.checkCode(entry, meta.code ?? '');
      // Malformed data does not burn the code: the app may send it again.
      const values = parseValues(text, entry.kind, this.messages[lang].kindMismatch);
      entry.code = undefined;
      entry.state = 'filled';
      entry.values = values;
      entry.filledAt = this.now();
      await this.save(entry);
      return { kind: 'filled', address: sender };
    }

    throw new LoginError(400, 'bad-meta', `unexpected envelope type: ${meta.type}`);
  }

  /**
   * Poll from the page. The values are returned once to the request owner
   * and wiped (the request moves to used). To another session the request
   * looks expired.
   */
  async poll(sid: string, owner: string): Promise<DataRequestPoll> {
    const entry = await this.store.get(sid);
    if (!entry || entry.owner !== owner || entry.state === 'used') return { state: 'expired' };
    const open = entry.state === 'new' || entry.state === 'challenged';
    if (open && entry.expiresAt < this.now()) return { state: 'expired' };
    if (entry.state === 'filled') {
      const { values, sender, filledAt } = entry;
      await this.store.delete(sid);
      return { state: 'filled', values: values!, sender: sender!, filledAt: filledAt! };
    }
    return { state: entry.state };
  }

  private async checkCode(entry: DataPending, code: string): Promise<void> {
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
  }

  private async live(sid: string): Promise<DataPending> {
    const entry = await this.store.get(sid);
    if (!entry || entry.expiresAt < this.now() || entry.state === 'used') {
      throw new LoginError(404, 'sid-expired', 'data request expired, refresh the QR code');
    }
    return entry;
  }

  /** A settled request waits for the page one more TTL; the values go with it. */
  private save(entry: DataPending): Promise<void> {
    return this.store.set(entry, Math.max(0, entry.expiresAt + this.ttlMs - this.now()));
  }

  private parseMeta(raw: string | undefined): RequestMeta {
    if (!raw) throw new LoginError(400, 'bad-meta', 'envelope has no meta');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LoginError(400, 'bad-meta', 'envelope meta is not JSON');
    }
    const meta = parsed as {
      type?: unknown;
      data?: { target?: unknown; v?: unknown; sid?: unknown; kind?: unknown; code?: unknown; challenge?: unknown };
    };
    if (typeof meta?.type !== 'string' || typeof meta.data?.sid !== 'string') {
      throw new LoginError(400, 'bad-meta', 'envelope meta lacks type or sid');
    }
    if (meta.type !== 'sk-data-cancel' && typeof meta.data.kind !== 'string') {
      throw new LoginError(400, 'bad-meta', 'envelope meta lacks kind');
    }
    if (!this.service.accepts(meta.data.target) || Number(meta.data.v) !== SK_LOGIN_VERSION) {
      throw new LoginError(400, 'bad-meta', 'envelope is meant for another service or protocol version');
    }
    return {
      type: meta.type,
      sid: meta.data.sid,
      kind: typeof meta.data.kind === 'string' ? meta.data.kind : undefined,
      code: typeof meta.data.code === 'string' ? meta.data.code : undefined,
      challenge: challengeVersion(meta.data.challenge),
    };
  }
}

interface RequestMeta {
  type: string;
  sid: string;
  /** Absent only in sk-data-cancel: the cancel refers to the sid, not to a record type. */
  kind?: string;
  code?: string;
  /** Challenge version the app understands (no field means 1). */
  challenge: number;
}

/** meta of data request envelopes: as loginMeta, plus kind and (in sk-data) code. */
export function requestMeta(
  target: string,
  type: string,
  sid: string,
  kind: string,
  code?: string,
  challenge: number = CHALLENGE_V1,
): string {
  const data: Record<string, unknown> = { target, v: SK_LOGIN_VERSION, sid, kind };
  if (code !== undefined) data.code = code;
  if (challenge > CHALLENGE_V1) data.challenge = challenge;
  return JSON.stringify({ type, data });
}

/** Step 3 text: a JSON object, keys from the kind dictionary, string values.
 *  Anything else is kind-mismatch; the content never reaches the error text. */
function parseValues(text: string, kind: Kind, message: string): Record<string, string> {
  const mismatch = () => new LoginError(400, 'kind-mismatch', message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw mismatch();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw mismatch();
  const allowed: readonly string[] = KINDS[kind];
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw mismatch();
    values[key] = value;
  }
  return values;
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += randomInt(0, 10);
  return code;
}
