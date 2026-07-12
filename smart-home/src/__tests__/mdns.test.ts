import { describe, it, expect } from 'bun:test';
import { readName, parseAnswerNames } from '../discovery/mdns';

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const chunks = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'utf8')]));
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

describe('mdns dns parser', () => {
  it('reads a plain name', () => {
    const buf = encodeName('_hue._tcp.local');
    const { name, next } = readName(buf, 0);
    expect(name).toBe('_hue._tcp.local');
    expect(next).toBe(buf.length);
  });

  it('follows compression pointers', () => {
    // name at offset 0, then a pointer at the end referencing offset 0
    const plain = encodeName('example.local');
    const pointer = Buffer.from([0xc0, 0x00]);
    const buf = Buffer.concat([plain, pointer]);
    const { name, next } = readName(buf, plain.length);
    expect(name).toBe('example.local');
    expect(next).toBe(buf.length);
  });

  it('extracts PTR answers from a response packet', () => {
    const owner = encodeName('_services._dns-sd._udp.local');
    const target = encodeName('_hue._tcp.local');
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // response flags
    header.writeUInt16BE(1, 6); // ANCOUNT = 1
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(12, 0); // TYPE = PTR
    fixed.writeUInt16BE(1, 2); // CLASS = IN
    fixed.writeUInt32BE(120, 4); // TTL
    fixed.writeUInt16BE(target.length, 8); // RDLENGTH
    const packet = Buffer.concat([header, owner, fixed, target]);

    const names = parseAnswerNames(packet);
    expect(names).toContain('_services._dns-sd._udp.local');
    expect(names).toContain('_hue._tcp.local');
  });

  it('survives truncated garbage without throwing', () => {
    expect(parseAnswerNames(Buffer.from([1, 2, 3]))).toEqual([]);
    const junk = Buffer.alloc(30, 0xff);
    expect(() => parseAnswerNames(junk)).not.toThrow();
  });
});
