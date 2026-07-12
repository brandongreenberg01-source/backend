import dgram from 'node:dgram';

export interface MdnsResult {
  ip: string;
  /** Service/instance names advertised by this host. */
  names: string[];
}

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_PTR = 12;

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const chunks = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'utf8')]));
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

function buildQuery(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const question = Buffer.concat([encodeName(name), Buffer.from([0, TYPE_PTR, 0, 1])]);
  return Buffer.concat([header, question]);
}

/** Read a (possibly compressed) DNS name. Returns the name and the offset after it. */
export function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let guard = 0;
  while (guard++ < 128 && offset < buf.length) {
    const len = buf[offset];
    if (len === 0) {
      if (next < 0) next = offset + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) break;
      if (next < 0) next = offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1];
      continue;
    }
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'));
    offset += len + 1;
  }
  return { name: labels.join('.'), next: next < 0 ? offset : next };
}

/** Extract answer names (owner + PTR targets) from an mDNS response. */
export function parseAnswerNames(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const names: string[] = [];
  let offset = 12;
  try {
    for (let i = 0; i < qdcount; i++) {
      offset = readName(buf, offset).next + 4;
    }
    for (let i = 0; i < ancount && offset < buf.length; i++) {
      const owner = readName(buf, offset);
      offset = owner.next;
      if (offset + 10 > buf.length) break;
      const type = buf.readUInt16BE(offset);
      const rdlength = buf.readUInt16BE(offset + 8);
      const rdataStart = offset + 10;
      if (owner.name) names.push(owner.name);
      if (type === TYPE_PTR) {
        const target = readName(buf, rdataStart);
        if (target.name) names.push(target.name);
      }
      offset = rdataStart + rdlength;
    }
  } catch {
    /* truncated or malformed packet — keep what we parsed */
  }
  return names;
}

/**
 * One-shot mDNS sweep: ask for the service directory plus a few common IoT
 * service types, and record every host that answers anything.
 */
export function mdnsScan(timeoutMs = 3000): Promise<MdnsResult[]> {
  return new Promise((resolve) => {
    const byIp = new Map<string, Set<string>>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...byIp.entries()].map(([ip, names]) => ({ ip, names: [...names] })));
    };

    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      const names = parseAnswerNames(msg);
      if (!names.length) return;
      const set = byIp.get(rinfo.address) ?? new Set<string>();
      for (const n of names) set.add(n);
      byIp.set(rinfo.address, set);
    });
    socket.bind(() => {
      const queries = [
        '_services._dns-sd._udp.local',
        '_hue._tcp.local',
        '_googlecast._tcp.local',
        '_hap._tcp.local', // HomeKit accessories
        '_ewelink._tcp.local', // Sonoff
      ];
      try {
        for (const q of queries) socket.send(buildQuery(q), MDNS_PORT, MDNS_ADDR);
      } catch {
        done();
        return;
      }
      setTimeout(done, timeoutMs);
    });
  });
}
