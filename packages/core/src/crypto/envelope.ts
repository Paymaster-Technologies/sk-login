import {
  decodeIdentityAddress,
  encodeIdentityAddress,
  hkdfSha256,
  x25519,
  xchacha20poly1305,
  type IdentityKeys,
} from './identity';

// Port of lib/crypto/{envelope,envelope_parse}.dart.
//
// Envelope format: the payload is encrypted once with a random message key,
// which is then wrapped into a slot for every addressee (recipients plus
// always the sender itself, otherwise the sender could not read its own
// history).
// [0x02][sender_pub 32][eph_pub 32][N 1][slot 48 x N][nonce 24][ct+tag]
// Slot: AEAD(message_key, KEK_i, nonce=0). The zero nonce is safe: every KEK
// is unique (an ephemeral key per envelope) and used exactly once.
// KEK_i = HKDF(ECDH(eph, R_i) || ECDH(sender, R_i), 'secret-keeper/kek/v1').
// A reader computes HKDF(ECDH(my, eph_pub) || ECDH(my, sender_pub)) and
// tries every slot; foreign ones are rejected by the AEAD tag. Slots are
// anonymous and shuffled.
//
// Payload (inside the AEAD): [flags u8][sentAt u64 BE, ms Unix UTC]
// [metaLen u32 BE + meta UTF-8, only when flags&1][when flags&2: the
// addressees, count u8, then len u8 + bech32 address UTF-8 for each one
// (without the sender; only slot owners can read them, so the addressees
// never leak outside)][text UTF-8 to the end].
// meta is an opaque string for the recipient's automation (by convention
// JSON {type, data}), not shown in the UI. Version 0x02: the 0x01 payload
// was raw text and the two cannot be told apart reliably, so old envelopes
// are rejected by version.

const ENVELOPE_VERSION = 0x02;
const FLAG_HAS_META = 0x01;
const FLAG_HAS_TO = 0x02;
const HKDF_KEK_INFO = new TextEncoder().encode('secret-keeper/kek/v1');
/** Slot length: 32 (message key) + 16 (AEAD tag). Shared with `.skf`. */
export const SLOT_LENGTH = 48;
const MAX_SLOTS = 255;
const SLOT_NONCE = new Uint8Array(24);

export const ARMOR_BEGIN = '-----BEGIN SECRET MESSAGE V1-----';
export const ARMOR_END = '-----END SECRET MESSAGE V1-----';

/** Decrypted envelope contents. */
export interface EnvelopeContent {
  /** Message text (what is shown to the user). */
  text: string;
  /** Metadata for the recipient's automation (by convention JSON {type, data}). */
  meta?: string;
  /** When the sender built the envelope: ms Unix epoch, UTC. */
  sentAtMs: number;
  /**
   * Envelope addressees (without the sender); the app uses them to file its
   * own envelope into the recipient's chat. undefined means the field is
   * absent (an envelope "to self" or the old format).
   */
  recipients?: string[];
}

/**
 * Wraps the message key into slots for the addressees (recipients plus
 * always the sender itself, no duplicates) under a fresh ephemeral key. The
 * layout is shared by envelopes and `.skf` containers; the slot order is
 * shuffled and means nothing.
 */
export function wrapKeySlots(options: {
  sender: IdentityKeys;
  recipientAddresses: string[];
  messageKey: Uint8Array;
}): { ephPub: Uint8Array; slots: Uint8Array[] } {
  const recipientPubs = new Map<string, Uint8Array>();
  const addPub = (pub: Uint8Array) => recipientPubs.set(toHex(pub), pub);
  for (const address of options.recipientAddresses) {
    addPub(decodeIdentityAddress(address));
  }
  if (recipientPubs.size === 0) {
    throw new Error('At least one recipient is required');
  }
  addPub(options.sender.x25519Public);
  if (recipientPubs.size > MAX_SLOTS) {
    throw new Error(`Too many recipients: ${recipientPubs.size}`);
  }

  const ephPrivate = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPrivate);

  const slots: Uint8Array[] = [];
  for (const pub of recipientPubs.values()) {
    const kek = kekFromParts(
      x25519.getSharedSecret(ephPrivate, pub),
      x25519.getSharedSecret(options.sender.x25519Private, pub),
    );
    slots.push(xchacha20poly1305(kek, SLOT_NONCE).encrypt(options.messageKey));
  }
  shuffle(slots);
  return { ephPub, slots };
}

export function encryptEnvelope(options: {
  sender: IdentityKeys;
  recipientAddress?: string;
  recipientAddresses?: string[];
  plaintext: string;
  /** Optional metadata, encrypted together with the text. */
  meta?: string;
  /** Creation time; defaults to now. */
  sentAtMs?: number;
}): string {
  const addresses = [
    ...(options.recipientAddress ? [options.recipientAddress] : []),
    ...(options.recipientAddresses ?? []),
  ];
  const messageKey = crypto.getRandomValues(new Uint8Array(32));
  const { ephPub: ephPublic, slots } = wrapKeySlots({
    sender: options.sender,
    recipientAddresses: addresses,
    messageKey,
  });

  // Addressees go inside the encrypted payload so that the sender, when
  // decrypting again, knows whose chat the envelope belongs to. Our own
  // address is not written: a "message to self" goes to notes anyway.
  const to = [...new Set(addresses)].filter(
    (address) => address !== options.sender.address,
  );

  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(messageKey, nonce).encrypt(
    buildPayload(options.plaintext, options.meta, options.sentAtMs, to),
  );

  const binary = new Uint8Array(
    1 + 32 + 32 + 1 + slots.length * SLOT_LENGTH + 24 + ciphertext.length,
  );
  let offset = 0;
  binary[offset++] = ENVELOPE_VERSION;
  binary.set(options.sender.x25519Public, offset);
  offset += 32;
  binary.set(ephPublic, offset);
  offset += 32;
  binary[offset++] = slots.length;
  for (const slot of slots) {
    binary.set(slot, offset);
    offset += SLOT_LENGTH;
  }
  binary.set(nonce, offset);
  offset += 24;
  binary.set(ciphertext, offset);

  return `${ARMOR_BEGIN}\n${toBase64(binary)}\n${ARMOR_END}`;
}

export function decryptEnvelope(options: {
  recipient: Pick<IdentityKeys, 'x25519Private'>;
  armored: string;
}): EnvelopeContent {
  const binary = parseArmor(options.armored);
  if (binary.length === 0) throw new Error('Envelope too short');
  if (binary[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${binary[0]}`);
  }

  const slotsOffset = 1 + 32 + 32 + 1;
  if (binary.length < slotsOffset) throw new Error('Envelope too short');
  const senderPub = binary.subarray(1, 33);
  const ephPub = binary.subarray(33, 65);
  const slotCount = binary[65];
  const nonceOffset = slotsOffset + slotCount * SLOT_LENGTH;
  if (slotCount === 0 || binary.length < nonceOffset + 24 + 16) {
    throw new Error('Envelope too short');
  }

  const messageKey = unwrapKeySlots({
    recipientPrivate: options.recipient.x25519Private,
    senderPub,
    ephPub,
    slots: Array.from({ length: slotCount }, (_, i) =>
      binary.subarray(
        slotsOffset + i * SLOT_LENGTH,
        slotsOffset + (i + 1) * SLOT_LENGTH,
      ),
    ),
  });
  if (messageKey === null) {
    // The envelope is not addressed to us.
    throw new Error('invalid tag');
  }

  const nonce = binary.subarray(nonceOffset, nonceOffset + 24);
  const ciphertext = binary.subarray(nonceOffset + 24);
  const clear = xchacha20poly1305(messageKey, nonce).decrypt(ciphertext);
  return parsePayload(clear);
}

// AEAD payload: [flags][sentAt u64 BE][metaLen u32 BE + meta?]
// [count u8 + (len u8 + address)xcount?][text].
function buildPayload(
  text: string,
  meta: string | undefined,
  sentAtMs: number | undefined,
  recipients: string[],
): Uint8Array {
  const encoder = new TextEncoder();
  const metaBytes = meta === undefined ? null : encoder.encode(meta);
  const textBytes = encoder.encode(text);
  const toBytes = recipients.map((address) => {
    const bytes = encoder.encode(address);
    if (bytes.length > 0xff) {
      throw new Error(`Recipient address too long: ${address}`);
    }
    return bytes;
  });
  const toLength = toBytes.length
    ? toBytes.reduce((sum, bytes) => sum + 1 + bytes.length, 1)
    : 0;
  const headerLength = 1 + 8 + (metaBytes ? 4 : 0);
  const payload = new Uint8Array(
    headerLength + (metaBytes?.length ?? 0) + toLength + textBytes.length,
  );
  const view = new DataView(payload.buffer);
  view.setUint8(
    0,
    (metaBytes ? FLAG_HAS_META : 0) | (toBytes.length ? FLAG_HAS_TO : 0),
  );
  view.setBigUint64(1, BigInt(sentAtMs ?? Date.now()));
  let offset = 9;
  if (metaBytes) {
    view.setUint32(offset, metaBytes.length);
    offset += 4;
    payload.set(metaBytes, offset);
    offset += metaBytes.length;
  }
  if (toBytes.length) {
    view.setUint8(offset, toBytes.length);
    offset += 1;
    for (const bytes of toBytes) {
      view.setUint8(offset, bytes.length);
      offset += 1;
      payload.set(bytes, offset);
      offset += bytes.length;
    }
  }
  payload.set(textBytes, offset);
  return payload;
}

function parsePayload(payload: Uint8Array): EnvelopeContent {
  if (payload.length < 9) throw new Error('Envelope payload too short');
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint8(0);
  if ((flags & ~(FLAG_HAS_META | FLAG_HAS_TO)) !== 0) {
    // Unknown flags mean an envelope from a future format version: it is
    // more honest to refuse than to show incorrectly parsed text.
    throw new Error(`Unsupported payload flags: ${flags}`);
  }
  const sentAtMs = Number(view.getBigUint64(1));
  let offset = 9;
  let meta: string | undefined;
  if (flags & FLAG_HAS_META) {
    if (payload.length < offset + 4) {
      throw new Error('Envelope payload too short');
    }
    const metaLength = view.getUint32(offset);
    offset += 4;
    if (payload.length < offset + metaLength) {
      throw new Error('Envelope payload too short');
    }
    meta = new TextDecoder().decode(
      payload.subarray(offset, offset + metaLength),
    );
    offset += metaLength;
  }
  let recipients: string[] | undefined;
  if (flags & FLAG_HAS_TO) {
    if (payload.length < offset + 1) {
      throw new Error('Envelope payload too short');
    }
    const count = view.getUint8(offset);
    offset += 1;
    recipients = [];
    for (let i = 0; i < count; i++) {
      if (payload.length < offset + 1) {
        throw new Error('Envelope payload too short');
      }
      const length = view.getUint8(offset);
      offset += 1;
      if (payload.length < offset + length) {
        throw new Error('Envelope payload too short');
      }
      recipients.push(
        new TextDecoder().decode(payload.subarray(offset, offset + length)),
      );
      offset += length;
    }
  }
  return {
    text: new TextDecoder().decode(payload.subarray(offset)),
    meta,
    sentAtMs,
    recipients,
  };
}

/// Sender address from an armored envelope without decrypting it.
export function senderAddressFromArmor(armored: string): string {
  const binary = parseArmor(armored);
  if (binary.length < 33) throw new Error('Envelope too short');
  return encodeIdentityAddress(binary.subarray(1, 33));
}

/// Whether the text contains something that looks like our envelope (for the page scanner).
export function containsArmor(text: string): boolean {
  const begin = text.indexOf(ARMOR_BEGIN);
  return begin >= 0 && text.indexOf(ARMOR_END) > begin;
}

/**
 * The canonical armor block (BEGIN…END inclusive) inside arbitrary text:
 * envelopes get forwarded with messenger captions around them ("Igor,
 * 19:20: …" and replies after), so only the block goes out and into
 * decryption. Throws if the marker pair is missing.
 */
export function extractArmor(input: string): string {
  const begin = input.indexOf(ARMOR_BEGIN);
  const end = input.indexOf(ARMOR_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error('Missing armor markers');
  }
  return input.slice(begin, end + ARMOR_END.length);
}

/**
 * Extracts the message key from the slots of an envelope or an `.skf`
 * container; they share the slot layout. null means none of the slots is ours.
 */
export function unwrapKeySlots(options: {
  recipientPrivate: Uint8Array;
  senderPub: Uint8Array;
  ephPub: Uint8Array;
  slots: Uint8Array[];
}): Uint8Array | null {
  // One KEK per reader; try every slot with it.
  const kek = kekFromParts(
    x25519.getSharedSecret(options.recipientPrivate, options.ephPub),
    x25519.getSharedSecret(options.recipientPrivate, options.senderPub),
  );
  for (const slot of options.slots) {
    try {
      return xchacha20poly1305(kek, SLOT_NONCE).decrypt(slot);
    } catch {
      // Not our slot, try the next one.
    }
  }
  return null;
}

function kekFromParts(shared1: Uint8Array, shared2: Uint8Array): Uint8Array {
  return hkdfSha256(concat(shared1, shared2), HKDF_KEK_INFO);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function shuffle(items: Uint8Array[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseArmor(armored: string): Uint8Array {
  const block = extractArmor(armored);
  const payload = block
    .slice(ARMOR_BEGIN.length, block.length - ARMOR_END.length)
    .replace(/\s+/g, '');
  return fromBase64(payload);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(payload: string): Uint8Array {
  const binary = atob(payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
