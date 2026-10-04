// @paymastech/sk-login-core: sign-in (§ 4.5) and data requests (§ 4.6)
// through Secret Keeper, framework-agnostic server side. An adapter
// provides the HTTP routes on top of SkLogin and SkDataRequest (see
// @paymastech/sk-login-nestjs), the widget is the browser popup.

export {
  DEFAULT_SID_TTL_MS,
  LoginError,
  MAX_CODE_ATTEMPTS,
  SK_AUTH_SCHEME_URL,
  SK_AUTH_URL,
  SK_LOGIN_VERSION,
  SkLogin,
  loginMeta,
  ownerHash,
  type AccessDecider,
  type AccessDecision,
  type EnvelopeReply,
  type InitResult,
  type PollResult,
  type RefusalCode,
  type SkLoginOptions,
  type TargetInfo,
} from './login.js';
export {
  KINDS,
  KIND_IDS,
  SK_REQUEST_SCHEME_URL,
  SK_REQUEST_URL,
  SkDataRequest,
  isKind,
  ownerKey,
  requestMeta,
  type DataPending,
  type DataReply,
  type DataRequestInit,
  type DataRequestPoll,
  type DataRequestState,
  type DataRequestStore,
  type Kind,
  type SkDataRequestOptions,
} from './request.js';
export { payloadQuery } from './payload.js';
export {
  MemoryPendingStore,
  MemorySidStore,
  type Pending,
  type PendingState,
  type PendingStore,
  type SidStore,
} from './store.js';
export {
  CHALLENGE_V1,
  CHALLENGE_V2,
  challengePlaintext,
  challengeVersion,
  clientIp,
  contextFromHeaders,
  describeContext,
  parseUserAgent,
  type ContextItem,
  type Describe,
  type GeoLookup,
  type HeaderGetter,
  type RequestContext,
} from './context.js';
export { defaultMessages, langFromAcceptLanguage, mergeMessages, type Lang, type Messages } from './i18n.js';
export {
  decodeIdentityAddress,
  deriveIdentityKeys,
  encodeIdentityAddress,
  generateMnemonic,
  keyCheckDigits,
  validateMnemonic,
  type IdentityKeys,
} from './crypto/identity.js';
export {
  containsArmor,
  decryptEnvelope,
  encryptEnvelope,
  extractArmor,
  senderAddressFromArmor,
} from './crypto/envelope.js';

import { deriveIdentityKeys, type IdentityKeys, validateMnemonic } from './crypto/identity.js';

/**
 * Server identity from a BIP-39 mnemonic (a space-separated string or an
 * array of words). The same key scheme as an app user: X25519 for
 * envelopes, an sk1… address. Keep the mnemonic as a secret (env, vault);
 * leaking it allows impersonating the server to the app.
 */
export function identityFromMnemonic(mnemonic: string | string[]): IdentityKeys {
  const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.trim().split(/\s+/);
  if (!validateMnemonic(words)) throw new Error('invalid BIP-39 mnemonic for the server identity');
  return deriveIdentityKeys(words);
}
