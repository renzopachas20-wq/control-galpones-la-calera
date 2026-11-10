import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { apiCors } from './cors.ts';

test('CORS admite el origen propio, la lista exacta y loopback solo en desarrollo', async t => {
  const app = express();
  app.use('/api', apiCors('https://web.example.test, capacitor://localhost', true, false));
  app.use('/dev', apiCors(undefined, false, true));
  app.get(['/api/health', '/dev/health'], (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const health = (origin: string, path = '/api/health') => fetch(base + path, { headers: { Origin: origin } });
  assert.equal((await health(base)).status, 200);
  assert.equal((await fetch(base + '/api/health', { headers: {
    Origin: base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https'
  } })).status, 200);
  const preflight = (origin: string) => fetch(base + '/api/health', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization'
  } });
  const allowed = await preflight('https://web.example.test');
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://web.example.test');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  const denied = await preflight('https://web.example.test.attacker.invalid');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await health('null')).status, 403);
  assert.equal((await health('http://localhost:5173')).status, 403);
  assert.equal((await health('http://localhost:5173', '/dev/health')).status, 200);
  assert.equal((await health('capacitor://localhost')).status, 200);
  assert.equal((await fetch(base + '/api/health')).headers.get('access-control-allow-origin'), null);
});
