import type {
  AccessDecider,
  DataRequestStore,
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
    /** The site's host (`example.com`): the QR carries it with the server
     *  address, the app posts to `https://<host>/sk/login` and
     *  `https://<host>/sk/request`, so this module must answer there
     *  (the routes `sk/login` and `sk/request` are mounted at the root).
     *  Lower-case ASCII, no scheme, port or path; IDN in punycode. */
    site?: string;
    /** An embedded target id instead of `site`: an app whose URL and
     *  server address are built into Secret Keeper (e.g. `tetatet`). */
    id?: string;
    /** Other `meta.data.target` values to accept for a while: the embedded
     *  id a site had before it moved to `site` (older app builds send it). */
    legacyTargets?: string[];
    /** Public origin of the service for `GET target` (e.g. https://api.example.com);
     *  without it, built from the request's Host and X-Forwarded-Proto. */
    publicUrl?: string;
  };
  /** Who to let in. Called once per sign-in, after the code check. */
  access: AccessDecider<User>;
  onAuthenticated?: OnAuthenticated<User>;
  /**
   * Data requests from the vault (protocol § 4.6): routes `request/init`,
   * `request/status` and the app endpoint `sk/request`. Without this option
   * those routes answer 404 `not-configured` and `GET target` has no `requestUrl`.
   */
  dataRequest?: DataRequestOptions;
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

export interface DataRequestOptions {
  /**
   * Who owns a request: a key of the page session (e.g. `ownerKey(token)`
   * from core over the session cookie). Only this owner receives the
   * values on `request/status`. `undefined` means no session: 401.
   */
  owner: (http: HttpPair) => string | undefined | Promise<string | undefined>;
  /** Request store; process memory by default. */
  store?: DataRequestStore;
  ttlMs?: number;
  /** Body limit of the `data` route; a vault record is a few kilobytes. Defaults to 64 KiB. */
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
/** The app's endpoints, derived from the site host by convention (protocol § 4.5-4.6). */
export const SK_LOGIN_ENDPOINT = 'sk/login';
export const SK_REQUEST_ENDPOINT = 'sk/request';
export const DEFAULT_MAX_BODY = 16 * 1024;
export const DEFAULT_DATA_MAX_BODY = 64 * 1024;
