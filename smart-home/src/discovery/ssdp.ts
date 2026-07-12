import dgram from 'node:dgram';

export interface SsdpResult {
  ip: string;
  headers: Record<string, string>;
}

const MSEARCH = [
  'M-SEARCH * HTTP/1.1',
  'HOST: 239.255.255.250:1900',
  'MAN: "ssdp:discover"',
  'MX: 2',
  'ST: ssdp:all',
  '',
  '',
].join('\r\n');

/** Broadcast an SSDP M-SEARCH and collect every responder (routers, TVs, hubs, cameras...). */
export function ssdpScan(timeoutMs = 3000): Promise<SsdpResult[]> {
  return new Promise((resolve) => {
    const byIp = new Map<string, SsdpResult>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...byIp.values()]);
    };

    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      const headers: Record<string, string> = {};
      for (const line of msg.toString('utf8').split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
      }
      const existing = byIp.get(rinfo.address);
      byIp.set(rinfo.address, { ip: rinfo.address, headers: { ...existing?.headers, ...headers } });
    });
    socket.bind(() => {
      try {
        socket.send(MSEARCH, 1900, '239.255.255.250');
      } catch {
        done();
        return;
      }
      setTimeout(done, timeoutMs);
    });
  });
}
