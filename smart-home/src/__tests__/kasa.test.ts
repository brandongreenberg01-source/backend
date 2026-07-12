import { describe, it, expect } from 'bun:test';
import { encrypt, decrypt } from '../adapters/kasa';

describe('kasa autokey cipher', () => {
  it('encrypts the first byte with the seed key 171', () => {
    // '{' is 0x7b; 0x7b ^ 171 (0xab) = 0xd0
    expect(encrypt('{')[0]).toBe(0xd0);
  });

  it('round-trips commands', () => {
    const cmd = JSON.stringify({ system: { get_sysinfo: {} } });
    expect(decrypt(encrypt(cmd))).toBe(cmd);
  });

  it('round-trips arbitrary utf8', () => {
    const text = 'Living Room Lamp — 客厅 💡';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('chains the key from ciphertext (autokey), not a fixed xor', () => {
    const twoBytes = encrypt('{{');
    // second byte must be keyed off the FIRST CIPHERTEXT byte (0xd0), not 171
    expect(twoBytes[1]).toBe(0x7b ^ 0xd0);
    expect(twoBytes[1]).not.toBe(0x7b ^ 0xab);
  });
});
