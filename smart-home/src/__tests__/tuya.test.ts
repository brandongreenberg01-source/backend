import { describe, it, expect } from 'bun:test';
import crypto from 'node:crypto';
import { buildStringToSign, buildSignature } from '../adapters/tuya';

const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('tuya request signing', () => {
  it('builds the canonical string for a GET with no body', () => {
    const str = buildStringToSign({ method: 'GET', path: '/v1.0/token?grant_type=1' });
    expect(str).toBe(`GET\n${SHA256_EMPTY}\n\n/v1.0/token?grant_type=1`);
  });

  it('hashes the body into the canonical string for POSTs', () => {
    const body = JSON.stringify({ commands: [{ code: 'switch_led', value: true }] });
    const str = buildStringToSign({ method: 'POST', path: '/v1.0/iot-03/devices/abc/commands', body });
    const expectedHash = crypto.createHash('sha256').update(body).digest('hex');
    expect(str.split('\n')).toEqual(['POST', expectedHash, '', '/v1.0/iot-03/devices/abc/commands']);
  });

  it('signs token requests without an access token', () => {
    const input = {
      clientId: 'client123',
      clientSecret: 'secret456',
      t: '1700000000000',
      nonce: 'nonce-1',
      method: 'GET' as const,
      path: '/v1.0/token?grant_type=1',
    };
    const expected = crypto
      .createHmac('sha256', input.clientSecret)
      .update(input.clientId + input.t + input.nonce + buildStringToSign(input))
      .digest('hex')
      .toUpperCase();
    expect(buildSignature(input)).toBe(expected);
    expect(buildSignature(input)).toMatch(/^[0-9A-F]{64}$/);
  });

  it('includes the access token for business requests and changes the signature', () => {
    const base = {
      clientId: 'client123',
      clientSecret: 'secret456',
      t: '1700000000000',
      method: 'GET' as const,
      path: '/v1.0/iot-03/devices/abc/status',
    };
    const unsigned = buildSignature(base);
    const signed = buildSignature({ ...base, accessToken: 'tok789' });
    expect(signed).not.toBe(unsigned);
    const expected = crypto
      .createHmac('sha256', base.clientSecret)
      .update(base.clientId + 'tok789' + base.t + buildStringToSign(base))
      .digest('hex')
      .toUpperCase();
    expect(signed).toBe(expected);
  });
});
