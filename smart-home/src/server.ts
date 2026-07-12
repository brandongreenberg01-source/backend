import path from 'node:path';
import express from 'express';
import { scanNetwork } from './discovery/scanner';
import type { DeviceRegistry } from './registry';

export function buildServer(registry: DeviceRegistry): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, '..', 'public')));

  const handle = (fn: (req: express.Request, res: express.Response) => Promise<void>) => {
    return (req: express.Request, res: express.Response) => {
      fn(req, res).catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
    };
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, adapters: registry.enabledBrands, errors: registry.errors });
  });

  app.get('/api/devices', (_req, res) => {
    res.json({ devices: registry.list(), adapters: registry.enabledBrands, errors: registry.errors });
  });

  app.post(
    '/api/devices/refresh',
    handle(async (_req, res) => {
      const devices = await registry.refresh();
      res.json({ devices, adapters: registry.enabledBrands, errors: registry.errors });
    }),
  );

  app.get(
    '/api/devices/:id/state',
    handle(async (req, res) => {
      res.json(await registry.refreshState(req.params.id));
    }),
  );

  app.post(
    '/api/devices/:id/power',
    handle(async (req, res) => {
      const on = Boolean(req.body?.on);
      res.json(await registry.setPower(req.params.id, on));
    }),
  );

  app.post(
    '/api/devices/:id/brightness',
    handle(async (req, res) => {
      const value = Number(req.body?.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        res.status(400).json({ error: 'value must be 0-100' });
        return;
      }
      res.json(await registry.setBrightness(req.params.id, value));
    }),
  );

  app.post(
    '/api/devices/:id/color',
    handle(async (req, res) => {
      const { r, g, b } = req.body ?? {};
      const valid = [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
      if (!valid) {
        res.status(400).json({ error: 'r, g, b must be integers 0-255' });
        return;
      }
      res.json(await registry.setColor(req.params.id, { r, g, b }));
    }),
  );

  app.post(
    '/api/scan',
    handle(async (_req, res) => {
      res.json({ discovered: await scanNetwork(registry) });
    }),
  );

  return app;
}
