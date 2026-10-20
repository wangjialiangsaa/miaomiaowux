import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseSessionCookie } from '../integration/auth.mjs';
import { readNodeCtlCredentials, signNodeCtlToken } from '../integration/nodectl.mjs';
import { createGateway } from '../integration/server.mjs';
import { importMissingNodes } from '../ui/nodectl/native-import.mjs';

const publicOrigin = 'https://panel.example.test';
const secret = 'synthetic-test-signing-secret-not-a-production-key';
const adminCookie = 'traffic_info_access_token="test-admin-session"';
let mmwx, nodectl, gateway, base;
let profileStatus = 200;
let received = [];
let nodes = [];
const upgradedSockets = new Set();
const node = () => ({
  uuid: 'server-one', name: 'Example server', install_id: 'test-install-id',
  links: { vless_reality: 'vless://synthetic@example.test:443#Example' },
  disabled_links: [], link_ports: { vless_reality: 443 }, ip_mode: 1,
  traffic_limit: 123456, traffic_limit_type: 'up', traffic_reset_mode: 'interval_days',
  traffic_reset_anchor_at: '2026-10-01T08:00:00+08:00', traffic_reset_interval_days: 7,
  tunnel_token: 'synthetic-private-tunnel-token', traffic_up: 456, remark: 'Keep me',
});
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
before(async () => {
  mmwx = createServer((request, response) => {
    if (request.url === '/api/user/profile') {
      if (profileStatus !== 200) return json(response, profileStatus, { error: 'private upstream error' });
      const token = request.headers['mm-authorization'];
      if (!['test-admin-session', 'test-user-session'].includes(token)) return json(response, 401, {});
      return json(response, 200, { username: 'fixture', role: token === 'test-admin-session' ? 'admin' : 'user', is_admin: token === 'test-admin-session' });
    }
    if (request.url?.startsWith('/subscription')) {
      response.writeHead(200, { 'content-type': 'application/yaml', etag: '"fixture-subscription"' });
      return response.end('proxies:\n  - name: 原有节点\n# ' + request.url);
    }
    if (request.url === '/api/admin/nodes') return json(response, 200, { nodes: [{ id: 97, raw_url: 'keep-existing' }] });
    if (request.url === '/compressed') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return response.end(gzipSync('<html><head></head><body>Compressed native page</body></html>'));
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"native-html"' });
    response.end('<!doctype html><html><head></head><body><main>Native panel</main></body></html>');
  });
  const mmwxUrl = await listen(mmwx);
  nodectl = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/agent/init-config')) return json(response, 200, { status: 'success', fixture: 'agent' });
    const signed = request.headers.cookie?.replace('nodectl_token=', '');
    assert.ok(signed);
    const [header, claims, signature] = signed.split('.');
    assert.equal(signature, createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url'));
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).username, 'node-admin');
    assert.equal(request.headers['x-forwarded-proto'], 'https');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ url: request.url, method: request.method, body: body ? JSON.parse(body) : null });
    response.setHeader('set-cookie', 'nodectl_token=must-not-leak');
    if (request.url === '/api/get-nodes') return json(response, 200, { status: 'success', data: { direct_nodes: nodes.filter(node => node.routing_type !== 2), land_nodes: nodes.filter(node => node.routing_type === 2) } });
    if (request.url?.startsWith('/api/traffic/consumption-rank?')) return json(response, 200, { status: 'success', rank: { generated_at: new URL(request.url, publicOrigin).searchParams.get('date'), items: [{ uuid: 'server-one', name: 'Example server', region: 'JP', offline: false, traffic_up: 100, traffic_down: 200, total_bytes: 300, tunnel_token: 'synthetic-private-tunnel-token' }] } });
    if (request.url === '/api/update-node') nodes = nodes.map(current => current.uuid === JSON.parse(body).uuid ? { ...JSON.parse(body), remark: current.remark } : current);
    return json(response, 200, { status: 'success', message: 'done' });
  });
  nodectl.on('upgrade', (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    if (request.url === '/api/traffic/live') {
      const signed = request.headers.cookie?.replace('nodectl_token=', '');
      assert.ok(signed);
      const [header, claims, signature] = signed.split('.');
      assert.equal(signature, createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url'));
    } else assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['mm-authorization'], undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: must-not-leak\r\n\r\n');
    if (head.length) socket.write('echo:' + head.toString());
    socket.on('data', chunk => socket.write('echo:' + chunk.toString()));
    socket.on('error', () => {});
  });
  const nodectlUrl = await listen(nodectl);
  gateway = createGateway({ mmwxUrl, nodectlUrl, publicOrigin, credentials: () => ({ secret, username: 'node-admin', panelUrl: 'https://agent.example.test' }) });
  base = await listen(gateway);
});
after(async () => {
  for (const socket of upgradedSockets) socket.destroy();
  for (const server of [gateway, mmwx, nodectl]) {
    server?.closeAllConnections();
    await new Promise(resolve => server?.close(resolve));
  }
});
const headers = extra => ({ cookie: adminCookie, ...extra });
const mutationHeaders = () => headers({ origin: publicOrigin, 'x-mmwx-nodectl': '1', 'content-type': 'application/json' });

test('expose validated read-only daily traffic without upstream secrets', async () => {
  const response = await fetch(base + '/_nodectl/api/traffic?date=2026-10-20', { headers: headers() });
  assert.equal(response.status, 200);
  const payload = await response.text();
  assert.doesNotMatch(payload, /tunnel_token|synthetic-private|nodectl_token/);
  const { rank } = JSON.parse(payload);
  assert.equal(rank.generated_at, '2026-10-20');
  assert.equal(rank.items[0].traffic_up, 100);
  assert.equal(rank.items[0].traffic_down, 200);
  for (const date of ['', '2026-02-30', '2026-13-01', '../secret']) {
    assert.equal((await fetch(base + '/_nodectl/api/traffic?date=' + encodeURIComponent(date), { headers: headers() })).status, 400);
  }
  assert.equal((await fetch(base + '/_nodectl/api/traffic?date=2026-10-20')).status, 401);
});

test('traffic WebSocket requires an administrator and exact same origin', { timeout: 5000 }, async () => {
  const address = new URL(base);
  async function upgrade(cookie, origin) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: address.hostname, port: address.port }, () => socket.write(`GET /_nodectl/api/traffic/live HTTP/1.1\r\nHost: panel.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}${origin ? `Origin: ${origin}\r\n` : ''}\r\n`));
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Traffic upgrade timed out')); });
      socket.on('error', reject);
      socket.once('data', chunk => { resolve(chunk.toString()); socket.destroy(); });
    });
  }
  assert.match(await upgrade(adminCookie, publicOrigin), /101 Switching Protocols/);
  assert.doesNotMatch(await upgrade(adminCookie, publicOrigin), /must-not-leak|set-cookie|nodectl_token/i);
  assert.match(await upgrade('', publicOrigin), /401/);
  assert.match(await upgrade('traffic_info_access_token="test-user-session"', publicOrigin), /403/);
  assert.match(await upgrade(adminCookie, 'https://other.example.test'), /403/);
  assert.match(await upgrade(adminCookie, ''), /403/);
});

test('parse native JSON cookies; reject ambiguous, malformed and unquoted values', () => {
  assert.equal(parseSessionCookie(adminCookie), 'test-admin-session');
  assert.equal(parseSessionCookie('traffic_info_access_token=%22test-admin-session%22'), 'test-admin-session');
  for (const cookie of ['traffic_info_access_token=test-admin-session', adminCookie + '; ' + adminCookie, 'traffic_info_access_token=""', 'traffic_info_access_token=%invalid']) assert.equal(parseSessionCookie(cookie), '');
});
test('sign short-lived NodeCTL JWTs', () => {
  const [header, payload, signature] = signNodeCtlToken({ secret, username: 'node-admin' }, 1000).split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { username: 'node-admin', iat: 1000, exp: 1060 });
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
});
test('read SQLite credentials without modifying or creating a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mmwx-sqlite-test-'));
  try {
    const path = join(directory, 'nodectl.db');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE sys_config (key TEXT PRIMARY KEY, value TEXT)');
    const statement = database.prepare('INSERT INTO sys_config VALUES (?, ?)');
    for (const [key, value] of [['jwt_secret', secret], ['admin_username', 'node-admin'], ['panel_url', 'https://agent.example.test']]) statement.run(key, value);
    database.close();
    const original = readFileSync(path);
    assert.deepEqual(readNodeCtlCredentials(path), { secret, username: 'node-admin', panelUrl: 'https://agent.example.test' });
    assert.deepEqual(readFileSync(path), original);
    assert.throws(() => readNodeCtlCredentials(join(directory, 'missing.db')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('reject missing, forged and non-admin sessions', async () => {
  for (const [cookie, expected] of [['', 401], ['traffic_info_access_token="forged"', 401], ['traffic_info_access_token="test-user-session"', 403]]) assert.equal((await fetch(base + '/_nodectl/api/nodes', { headers: { cookie } })).status, expected);
});
test('revalidate revoked sessions and fail closed on native authorization errors', async () => {
  assert.equal((await fetch(base + '/_nodectl/api/session', { headers: headers() })).status, 200);
  profileStatus = 401;
  assert.equal((await fetch(base + '/_nodectl/api/session', { headers: headers() })).status, 401);
  profileStatus = 500;
  const response = await fetch(base + '/_nodectl/api/session', { headers: headers() });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private upstream error/);
  profileStatus = 200;
});
test('reject cross-site, missing-origin and non-JSON writes', async () => {
  for (const extra of [{}, { origin: 'https://evil.test' }, { origin: publicOrigin }, { origin: publicOrigin, 'x-mmwx-nodectl': '1', 'content-type': 'text/plain' }]) assert.ok([403, 415].includes((await fetch(base + '/_nodectl/api/nodes', { method: 'POST', headers: headers(extra), body: '{"name":"blocked"}' })).status));
});
test('expose nodes without leaking upstream cookies or tunnel secrets', async () => {
  nodes = [node()];
  const response = await fetch(base + '/_nodectl/api/nodes', { headers: headers() });
  const payload = await response.json();
  assert.equal(payload.nodes[0].uuid, 'server-one');
  assert.equal(payload.nodes[0].tunnel_token, undefined);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-private-tunnel-token|must-not-leak/);
});
test('preserve original protocol, traffic and reset fields during metadata edits', async () => {
  nodes = [node()]; received = [];
  const response = await fetch(base + '/_nodectl/api/nodes/server-one', { method: 'PATCH', headers: mutationHeaders(), body: '{"name":"New name"}' });
  assert.equal(response.status, 200);
  const update = received.find(request => request.url === '/api/update-node').body;
  assert.equal(update.name, 'New name');
  assert.equal(update.remark, 'Keep me');
  assert.equal(update.traffic_limit, 123456);
  assert.equal(update.traffic_limit_type, 'up');
  assert.deepEqual(update.links, node().links);
  assert.equal(update.traffic_reset_anchor_date, '2026-10-01');
  assert.equal(update.tunnel_token, node().tunnel_token);
});
test('allow only fixed fields, routes and protocol actions', async () => {
  for (const [path, method, body, status] of [
    ['/nodes/server-one', 'PATCH', { jwt_secret: 'not-allowed' }, 400],
    ['/nodes/server-one', 'PATCH', { remark: 'Unsupported change' }, 400],
    ['/nodes/server-one/protocol', 'POST', { action: 'run-shell', protocols: ['vless_reality'] }, 400],
    ['/nodes/server-one/protocol', 'POST', { action: 'disable', protocols: ['unknown_protocol'] }, 400],
    ['/reset-jwt', 'POST', {}, 404],
  ]) assert.equal((await fetch(base + '/_nodectl/api' + path, { method, headers: mutationHeaders(), body: JSON.stringify(body) })).status, status);
});
test('translate protocol actions and preserve original Agent installation endpoints', async () => {
  nodes = [node()]; received = [];
  assert.equal((await fetch(base + '/_nodectl/api/nodes/server-one/protocol', { method: 'POST', headers: mutationHeaders(), body: '{"action":"disable","protocols":["vless_reality"]}' })).status, 200);
  assert.deepEqual(received.find(request => request.url === '/api/callback/reset-protocol').body, { install_id: 'test-install-id', action: 'disable', protocols: ['vless_reality'] });
  const result = await (await fetch(base + '/_nodectl/api/nodes/server-one/install', { headers: headers() })).json();
  assert.match(result.command, /https:\/\/agent\.example\.test\/api\/public\/new-install-script\?id=test-install-id/);
});
test('enforce request body limits', async () => {
  assert.equal((await fetch(base + '/_nodectl/api/nodes', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'x'.repeat(300000) }) })).status, 413);
});
test('inject the extension only in HTML, invalidating its old etag', async () => {
  const response = await fetch(base + '/');
  const html = await response.text();
  assert.match(html, /Native panel/);
  assert.match(html, /\/_nodectl\/assets\/extension\.mjs/);
  assert.equal(response.headers.get('etag'), null);
  assert.equal((html.match(/data-mmwx-nodectl/g) || []).length, 1);
  assert.equal((await fetch(base + '/_nodectl/assets/extension.mjs')).status, 200);
});
test('keep subscription bytes, query parameters and validators unchanged', async () => {
  const path = '/subscription?token=synthetic-token&target=clash';
  const response = await fetch(base + path);
  assert.equal(await response.text(), 'proxies:\n  - name: 原有节点\n# ' + path);
  assert.equal(response.headers.get('etag'), '"fixture-subscription"');
});
test('preserve public Agent requests without browser authentication', async () => {
  const response = await fetch(base + '/api/agent/init-config?install_id=synthetic');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fixture, 'agent');
});
test('native import is additive, skips existing URLs and deduplicates exports', async () => {
  const saved = [];
  const native = { post: async (route, body) => {
    if (route === '§46a7672619bac609') return { data: { proxies: [{ name: 'Parsed', type: 'vless', server: 'example.test', port: 443 }] } };
    assert.equal(route, '§a096b479adc7fa16'); saved.push(...body.nodes);
    return { data: { nodes: body.nodes.map((entry, index) => ({ ...entry, id: index + 100 })) } };
  } };
  const entries = [{ url: 'keep-existing', server: 'Old', uuid: 'old', protocol: 'vless_reality' }, { url: 'new-link', server: 'New', uuid: 'new', protocol: 'vless_reality' }, { url: 'new-link', server: 'Duplicate', uuid: 'duplicate', protocol: 'vless_reality' }];
  const existing = [{ id: 97, raw_url: 'keep-existing', tags: ['unchanged'] }];
  assert.deepEqual(await importMissingNodes(native, entries, existing), { imported: 1, skipped: 2 });
  assert.equal(saved[0].raw_url, 'new-link');
  assert.deepEqual(existing, [{ id: 97, raw_url: 'keep-existing', tags: ['unchanged'] }]);
});
test('incompatible native parsers never partially write nodes', async () => {
  let saved = false;
  const native = { post: async route => { if (route === '§46a7672619bac609') return { data: { unexpected: true } }; saved = true; } };
  await assert.rejects(importMissingNodes(native, [{ url: 'unsupported', server: 'Test', protocol: 'vless' }], []));
  assert.equal(saved, false);
});

test('accept the real categorized NodeCTL response with direct and landing servers', async () => {
  nodes = [node(), { ...node(), uuid: 'server-two', routing_type: 2 }];
  const response = await fetch(base + '/_nodectl/api/nodes', { headers: headers() });
  assert.deepEqual((await response.json()).nodes.map(node => node.uuid), ['server-one', 'server-two']);
});

test('decode compressed HTML safely before same-origin instrumentation', async () => {
  const response = await fetch(base + '/compressed');
  assert.equal(response.headers.get('content-encoding'), null);
  const html = await response.text();
  assert.match(html, /Compressed native page/);
  assert.match(html, /data-mmwx-nodectl/);
});

test('reject raw authority and backslash paths instead of proxying to another host', async () => {
  const address = new URL(base);
  for (const path of ['//example.invalid/probe', '/\\example.invalid/probe']) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: address.hostname, port: address.port, path }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 400);
  }
});

test('Agent WebSocket upgrades survive timeouts, strip cookies and close both peers', { timeout: 5000 }, async () => {
  const isolated = createGateway({ mmwxUrl: `http://127.0.0.1:${mmwx.address().port}`, nodectlUrl: `http://127.0.0.1:${nodectl.address().port}`, publicOrigin, timeoutMs: 50, credentials: () => ({ secret, username: 'node-admin' }) });
  const connections = new Set();
  isolated.on('connection', connection => connections.add(connection));
  const origin = new URL(await listen(isolated));
  let socket;
  try {
    const result = await new Promise((resolve, reject) => {
      let received = '', sent = false;
      socket = connect({ host: origin.hostname, port: origin.port }, () => socket.write('GET /api/callback/traffic/ws?install_id=synthetic HTTP/1.1\r\nHost: panel.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: browser-only-secret\r\nMM-Authorization: browser-only-secret\r\n\r\n'));
      socket.setTimeout(3000, () => reject(new Error('WebSocket test timeout')));
      socket.on('error', reject);
      socket.on('close', () => { if (!received.includes('echo:fixture-payload')) reject(new Error('WebSocket closed during idle handshake test')); });
      socket.on('data', chunk => {
        received += chunk;
        if (received.includes('\r\n\r\n') && !sent) { sent = true; setTimeout(() => { if (!socket.destroyed) socket.write('fixture-payload'); }, 100); }
        if (received.includes('echo:fixture-payload')) resolve(received);
      });
    });
    assert.match(result, /101 Switching Protocols/);
    assert.doesNotMatch(result, /must-not-leak|Set-Cookie/i);
    const closed = Promise.all([...connections].map(connection => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway left an upgraded connection half-open')), 500);
      connection.once('close', () => { clearTimeout(timer); resolve(); });
    })));
    socket.destroy();
    await closed;
  } finally {
    socket?.destroy();
    for (const connection of connections) connection.destroy();
    isolated.closeAllConnections(); await new Promise(resolve => isolated.close(resolve));
  }
});
