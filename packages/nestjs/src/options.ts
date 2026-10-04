import type {
  AccessDecider,
  Describe,
  GeoLookup,
  IdentityKeys,
  Lang,
  Messages,
  PendingStore,
} from '@paymastech/sk-login-core';

/** Provider token with the module options (for forRootAsync and your own providers). */
export const SK_LOGIN_OPTIONS = Symbol('SK_LOGIN_OPTIONS');

/** Platform HTTP objects (Express or Fastify) as Nest sees them. */
export interface HttpPair {
  req: any;
  res: any;
}

/**
 * What the service does when the browser learns about admission (status
 * with `authenticated` or a manual code): set a cookie via `res`, issue a
 * token, etc. The returned object is merged into the JSON reply to the
 * browser (e.g. `{ token }`); the widget passes it to `onSuccess`.
 */
export type OnAuthenticated<User> = (
  user: User,
  http: HttpPair,
) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;

export interface SkLoginModuleOptions<User = unknown> {
  /** BIP-39 mnemonic of the server identity (a secret: env or vault). Or `identity`. */
  mnemonic?: string | string[];
  identity?: IdentityKeys;
  target: {
    /** Service id: the entry in the Secret Keeper app's `skLoginTargets`
     *  (direct mode) or the `destination` registered at the hub (hub mode). */
    id: string;
    /** Hub mode: the hub's target id in the app (e.g. `auth_secretkeeper`).
     *  The QR becomes `target=<hub>&destination=<id>`; the hub relays the
     *  app's envelopes to this server's `login` route. */
    hub?: string;
    /** Public origin of the service for `GET target` (e.g. https://api.example.com);
     *  without it, built from the request's Host and X-Forwarded-Proto. */
    publicUrl?: string;
  };
  /** Who to let in. Called once per sign-in, after the code check. */
  access: AccessDecider<User>;
  onAuthenticated?: OnAuthenticated<User>;
  /** Request store; process memory by default (a single replica). */
  store?: PendingStore<User>;
  ttlMs?: number;
  describe?: Describe;
  geo?: GeoLookup;
  messages?: Partial<Record<Lang, Partial<Messages>>>;
  /** Trust X-Forwarded-For (its last entry) when collecting the request context. Defaults to true. */
  trustProxy?: boolean;
  /** Return the QR as SVG from `init` (for the widget). Defaults to true. */
  qr?: boolean;
  /** Envelope body limit; real envelopes are hundreds of bytes. */
  maxBodyBytes?: number;
}

export interface SkLoginModuleAsyncOptions<User = unknown> {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => SkLoginModuleOptions<User> | Promise<SkLoginModuleOptions<User>>;
  /** The route prefix is known before the factory runs (the controller is declared statically). */
  routePrefix?: string;
}

export const DEFAULT_ROUTE_PREFIX = 'api/sk';
export const DEFAULT_MAX_BODY = 16 * 1024;
