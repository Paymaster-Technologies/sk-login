import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decryptEnvelope, encryptEnvelope, senderAddressFromArmor } from '../src/crypto/envelope.js';
import { deriveIdentityKeys, generateMnemonic } from '../src/crypto/identity.js';

// The fixtures were recorded by the Secret Keeper app code
// (tools/test_vectors/generate_app_fixtures.dart): the "app writes, server
// reads" direction, which is exactly the one used in the login.
// Sync: scripts/sync_sk_crypto.sh (repo root).
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/app_fixtures.json', import.meta.url), 'utf8'));

const reader = () => deriveIdentityKeys(fixtures.reader.mnemonic);
const sender = () => deriveIdentityKeys(fixtures.sender.mnemonic);

describe('envelopes written by the app', () => {
  it('decrypts a message with meta and reads the authenticated sender', () => {
    const v = fixtures.envelopes.to_reader_meta;
    const content = decryptEnvelope({ recipient: reader(), armored: v.armored });
    expect(content.text).toBe(v.text);
    expect(content.meta).toBe(v.meta);
    expect(senderAddressFromArmor(v.armored)).toBe(sender().address);
  });

  it('rejects an envelope addressed to somebody else', () => {
    const v = fixtures.envelopes.to_reader_meta;
    expect(() => decryptEnvelope({ recipient: sender(), armored: v.armored })).not.toThrow();
    const stranger = deriveIdentityKeys(generateMnemonic());
    expect(() => decryptEnvelope({ recipient: stranger, armored: v.armored })).toThrow();
  });

  it('round-trips our own envelope back to the app identity', () => {
    const armored = encryptEnvelope({
      sender: reader(),
      recipientAddress: sender().address,
      plaintext: '123456',
      meta: '{"type":"sk-login-challenge"}',
    });
    const content = decryptEnvelope({ recipient: sender(), armored });
    expect(content.text).toBe('123456');
  });
});
