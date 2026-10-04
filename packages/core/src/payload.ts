// QR payload query shared by sign-in (§ 4.5) and data requests (§ 4.6):
// `v`, `sid`, then either `target=<id>` (direct mode) or
// `target=<hub>&destination=<id>` (hub mode), plus flow-specific params
// such as `kind`.

export const SK_LOGIN_VERSION = 1;

export function payloadQuery(
  sid: string,
  target: string,
  hub: string | undefined,
  extra: Record<string, string> = {},
): URLSearchParams {
  const query = new URLSearchParams({ v: String(SK_LOGIN_VERSION), sid });
  if (hub) {
    query.set('target', hub);
    query.set('destination', target);
  } else {
    query.set('target', target);
  }
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query;
}
