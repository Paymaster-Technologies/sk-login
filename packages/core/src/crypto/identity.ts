import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { bech32 } from '@scure/base';
import {
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as scureValidateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

// Port of lib/crypto/{identity_keys,bech32,bip39}.dart to noble/scure.
// Compatibility is checked by tests against tools/test_vectors/test_vectors.json,
// the same vectors as the Dart implementation (test/protocol_cross_test.dart).

const HKDF_X25519_INFO = new TextEncoder().encode('secret-keeper/x25519/v1');
const HKDF_ED25519_INFO = new TextEncoder().encode('secret-keeper/ed25519/v1');

export interface IdentityKeys {
  x25519Private: Uint8Array;
  x25519Public: Uint8Array;
  ed25519Private: Uint8Array;
  ed25519Public: Uint8Array;
  address: string;
}

/// 12 words, English wordlist (128 bits of entropy), as in the app.
export function generateMnemonic(): string[] {
  return scureGenerateMnemonic(wordlist, 128).split(' ');
}

export function validateMnemonic(mnemonic: string[]): boolean {
  return mnemonic.length === 12 && scureValidateMnemonic(mnemonic.join(' '), wordlist);
}

export function mnemonicToSeed(mnemonic: string[]): Uint8Array {
  return mnemonicToSeedSync(mnemonic.join(' '));
}

/// X25519 private key clamping (RFC 7748). The Dart implementation stores
/// the already clamped key, so we repeat it to make the hex match byte for byte.
function clampX25519(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

export function deriveIdentityKeys(mnemonic: string[]): IdentityKeys {
  return deriveIdentityKeysFromSeed(mnemonicToSeed(mnemonic));
}

export function deriveIdentityKeysFromSeed(seed: Uint8Array): IdentityKeys {
  const x25519Private = clampX25519(hkdf(sha256, seed, undefined, HKDF_X25519_INFO, 32));
  const ed25519Private = hkdf(sha256, seed, undefined, HKDF_ED25519_INFO, 32);
  const x25519Public = x25519.getPublicKey(x25519Private);
  return {
    x25519Private,
    x25519Public,
    ed25519Private,
    ed25519Public: ed25519.getPublicKey(ed25519Private),
    address: encodeIdentityAddress(x25519Public),
  };
}

/// The `sk1...` address: bech32 (BIP-173) with HRP `sk` over the X25519 key.
export function encodeIdentityAddress(x25519Public: Uint8Array): string {
  if (x25519Public.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return bech32.encode('sk', bech32.toWords(x25519Public));
}

export function decodeIdentityAddress(address: string): Uint8Array {
  const { prefix, words } = bech32.decode(address.toLowerCase() as `${string}1${string}`);
  if (prefix !== 'sk') throw new Error(`Expected HRP sk, got ${prefix}`);
  const decoded = bech32.fromWords(words);
  if (decoded.length !== 32) throw new Error(`Expected 32-byte pubkey, got ${decoded.length}`);
  return Uint8Array.from(decoded);
}

/// Safety numbers of a contact pair: SHA-256 of both keys in canonical
/// (lexicographic) order, so both sides see the same 25 digits.
export function safetyNumbers(myPublic: Uint8Array, contactPublic: Uint8Array): string {
  const ordered =
    compareBytes(myPublic, contactPublic) <= 0
      ? concatBytes(myPublic, contactPublic)
      : concatBytes(contactPublic, myPublic);
  return digestDigits(ordered);
}

/// Check digits of a SINGLE key, as keyCheckDigits in the app.
export function keyCheckDigits(publicKey: Uint8Array): string {
  return digestDigits(publicKey);
}

/// 25 digits (5 groups of 5) from the first 10 bytes of SHA-256.
function digestDigits(data: Uint8Array): string {
  const digest = sha256(data);
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    value = (value << 8n) | BigInt(digest[i]);
  }
  const digits = value.toString().padStart(25, '0').slice(0, 25);
  const groups: string[] = [];
  for (let i = 0; i < 25; i += 5) {
    groups.push(digits.slice(i, i + 5));
  }
  return groups.join(' ');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const hkdfSha256 = (ikm: Uint8Array, info: Uint8Array): Uint8Array =>
  hkdf(sha256, ikm, undefined, info, 32);

export { x25519, xchacha20poly1305 };
