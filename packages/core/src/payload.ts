// Who the service is, shared by sign-in (§ 4.5) and data requests (§ 4.6):
// a site (`site=<host>&address=<sk1…>` in the QR; the app derives the
// endpoints `https://<host>/sk/login` and `https://<host>/sk/request` from
// the host and names the service by it) or an embedded target (`target=<id>`:
// an app whose URL and server address are built into Secret Keeper, such
// as Tetatet). The QR payload query is `v`, `sid`, then the service, then
// flow-specific params such as `kind`. The same id goes to `meta.data.target`
// of every envelope and is checked against the incoming ones.

export const SK_LOGIN_VERSION = 1;

/**
 * The host form the app accepts in `site` (lib/services/sk_login.dart):
 * ASCII labels of letters, digits and hyphens, at least one dot, no scheme,
 * port or path; IP literals and `localhost` are not services. IDN hosts
 * go in punycode.
 */
export const SITE_HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export interface ServiceOptions {
  /** The site's host (`lashin.su`): goes to the QR with the server address
   *  and to `meta.data.target`. Lower-cased; must be in the form the app accepts. */
  site?: string;
  /** An embedded target id instead of a site: an app that Secret Keeper
   *  knows by name (its URL and server address are built in). */
  target?: string;
  /** Other `meta.data.target` values to accept for a while, e.g. the
   *  embedded id a site had before it moved to `site` (older app builds
   *  still send it). */
  legacyTargets?: string[];
}

/** The resolved service: the id for `meta.data.target`, the QR params, the acceptance check. */
export interface Service {
  /** `site` or `target`: what every envelope's `meta.data.target` must carry. */
  id: string;
  site: string | undefined;
  /** `meta.data.target` of an incoming envelope is for this service. */
  accepts(target: unknown): boolean;
  /** The QR payload query; `address` is the server's sk1… address (sites only). */
  query(sid: string, address: string, extra?: Record<string, string>): URLSearchParams;
}

export function resolveService(options: ServiceOptions): Service {
  const site = options.site?.trim().toLowerCase() || undefined;
  const target = options.target?.trim() || undefined;
  if (!!site === !!target) throw new Error('sk-login: set exactly one of `site` (the host) or `target` (an embedded id)');
  if (site && !SITE_HOST_RE.test(site)) {
    throw new Error(`sk-login: \`site\` must be a bare ASCII host (no scheme, port or path; IDN in punycode), got "${options.site}"`);
  }
  const id = (site ?? target)!;
  const accepted = new Set([id, ...(options.legacyTargets ?? [])]);
  return {
    id,
    site,
    accepts: (t) => typeof t === 'string' && accepted.has(t),
    query(sid, address, extra = {}) {
      const query = new URLSearchParams({ v: String(SK_LOGIN_VERSION), sid });
      if (site) {
        query.set('site', site);
        query.set('address', address);
      } else {
        query.set('target', id);
      }
      for (const [key, value] of Object.entries(extra)) query.set(key, value);
      return query;
    },
  };
}
