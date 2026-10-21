import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { verifyManifest, compareVersions, releaseUrl, fetchBounded, downloadBundle } from '../updater/release.mjs';
import { createUpdateManager } from '../updater/manager.mjs';
import { createUpdaterServer } from '../updater/server.mjs';
import { validateConfig, composeArguments, backupDatabase } from '../updater/docker.mjs';
import { updateRequest } from '../integration/updates.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const manifest = () => ({
  schema: 1, protocol: 1, repository: 'wangjialiangsaa/miaomiaowux',
  version: '1.0.1', tag: 'gateway-v1.0.1', revision: 'a'.repeat(40),
  images: {
    amd64: { asset: 'gateway-1.0.1-amd64.tar.gz', size: 12345, sha256: 'b'.repeat(64), image: 'mmwx-gateway:1.0.1-amd64', imageId: 'sha256:' + 'c'.repeat(64) },
    arm64: { asset: 'gateway-1.0.1-arm64.tar.gz', size: 12346, sha256: 'd'.repeat(64), image: 'mmwx-gateway:1.0.1-arm64', imageId: 'sha256:' + 'e'.repeat(64) },
  },
});
function candidate(value = manifest()) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { manifest: verifyManifest(bytes, sign(null, bytes, privateKey), publicKey, 'amd64'), manifestSha256: createHash('sha256').update(bytes).digest('hex'), notes: 'Release fixture' };
}
function fixture(context, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mmwx-updates-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const runner = {
    current: async () => ({ version: '1.0.0', revision: '0'.repeat(40), image: 'sha256:' + '1'.repeat(64) }),
    preflight: async () => { calls.push('preflight'); return { engines: ['engine-one'] }; },
    download: async () => { calls.push('download'); },
    backup: async () => { calls.push('backup'); },
    load: async () => { calls.push('load'); return manifest().images.amd64.imageId; },
    deploy: async image => { calls.push('deploy:' + image); },
    healthy: async () => { calls.push('health'); },
    restore: async () => { calls.push('restore'); },
    cleanup: async () => { calls.push('cleanup'); },
    ...overrides,
  };
  return { directory, runner, calls, source: { latest: async () => candidate() } };
}
async function settle(manager) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = manager.status();
    if (!result.busy) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Update job did not settle');
}
const confirmation = () => ({ version: '1.0.1', manifestSha256: candidate().manifestSha256 });

test('signed release verification pins repository, tag, architecture, immutable identity and exact bytes', () => {
  assert.equal(candidate().manifest.version, '1.0.1');
  const bytes = Buffer.from(JSON.stringify(manifest()));
  assert.throws(() => verifyManifest(Buffer.concat([bytes, Buffer.from(' ')]), sign(null, bytes, privateKey), publicKey, 'amd64'), /签名/);
  assert.throws(() => verifyManifest(bytes, Buffer.alloc(64), publicKey, 'amd64'), /签名/);
  for (const change of [
    value => { value.repository = 'someone/other'; },
    value => { value.tag = 'other-v1.0.1'; },
    value => { value.version = '1.0.1-beta'; },
    value => { value.revision = 'main'; },
    value => { value.protocol = 2; },
    value => { value.images.amd64.asset = '../escape'; },
    value => { value.images.amd64.image = 'other:latest'; },
    value => { value.images.amd64.size = 0; },
    value => { value.images.amd64.size = 2 ** 40; },
    value => { value.images.amd64.imageId = 'latest'; },
    value => { value.images.amd64.sha256 = 'invalid'; },
    value => { value.images.amd64.command = 'not-allowed'; },
    value => { value.version = ['1.0.1']; },
    value => { value.revision = ['a'.repeat(40)]; },
    value => { value.images.amd64.sha256 = ['b'.repeat(64)]; },
  ]) {
    const value = manifest(); change(value);
    assert.throws(() => candidate(value));
  }
  assert.throws(() => verifyManifest(bytes, sign(null, bytes, privateKey), publicKey, 'x64'), /架构/);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
  assert.throws(() => compareVersions('1.0.1;rm', '1.0.0'));
  assert.equal(releaseUrl('gateway-v1.0.1', 'manifest.json'), 'https://github.com/wangjialiangsaa/miaomiaowux/releases/download/gateway-v1.0.1/manifest.json');
  assert.throws(() => releaseUrl('../../main', 'manifest.json'));
});

test('image download checks actual byte size and SHA-256 before keeping any artifact', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'release-download-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = manifest(); const payload = Buffer.from('synthetic verified image');
  value.images.amd64.size = payload.length;
  value.images.amd64.sha256 = createHash('sha256').update(payload).digest('hex');
  const release = candidate(value);
  const destination = join(directory, 'image.tar.gz');
  await downloadBundle(release, destination, { fetch: async () => new Response(payload) });
  assert.deepEqual(readFileSync(destination), payload);
  rmSync(destination);
  await assert.rejects(downloadBundle(release, destination, { fetch: async () => new Response(Buffer.alloc(payload.length)) }), /SHA-256/);
  await assert.rejects(downloadBundle(release, destination, { fetch: async () => new Response(payload.subarray(1)) }), /校验/);
});

test('downloads reject non-HTTPS, untrusted redirects, timeouts and oversized bodies', async () => {
  await assert.rejects(fetchBounded('http://github.com/file', 100), /下载/);
  await assert.rejects(fetchBounded('https://attacker.example/file', 100), /下载/);
  await assert.rejects(fetchBounded('https://github.com/file', 3, { fetch: async () => new Response('oversize') }), /大小/);
  await assert.rejects(fetchBounded('https://github.com/file', 100, { fetch: async () => new Response('', { status: 302, headers: { location: 'https://attacker.example/file' } }) }), /下载/);
});

test('GitHub release discovery requests JSON while binary assets request octet-stream', async () => {
  for (const [address, accept] of [['https://api.github.com/repos/wangjialiangsaa/miaomiaowux/releases?per_page=100', 'application/vnd.github+json'], ['https://github.com/wangjialiangsaa/miaomiaowux/releases/download/gateway-v1.0.0/manifest.sig', 'application/octet-stream']]) {
    await fetchBounded(address, 100, { fetch: async (url, options) => { assert.equal(options.headers.accept, accept); return new Response('fixture'); } });
  }
});

test('successful update verifies, backs up, deploys only the gateway and persists private status', async context => {
  const setup = fixture(context);
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  assert.equal(manager.status().current.version, '1.0.0');
  await manager.check();
  assert.equal(manager.status().available, true);
  const started = await manager.apply(confirmation());
  assert.equal(started.busy, true);
  const result = await settle(manager);
  assert.equal(result.job.phase, 'succeeded');
  assert.equal(result.current.version, '1.0.1');
  assert.deepEqual(setup.calls, ['preflight', 'download', 'backup', 'load', 'deploy:' + manifest().images.amd64.imageId, 'health', 'cleanup']);
  const persisted = JSON.parse(readFileSync(join(setup.directory, 'state.json')));
  assert.equal(persisted.job.phase, 'succeeded');
  assert.equal(result.job.previous, undefined);
  await assert.rejects(manager.apply(confirmation()), /更新版本/);
});

test('confirmation is exact, no commands or URLs accepted, duplicate jobs conflict', async context => {
  let releaseDownload;
  const setup = fixture(context, { download: () => new Promise(resolve => { releaseDownload = resolve; }) });
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  await assert.rejects(manager.apply(confirmation()), /检查更新/);
  await manager.check();
  await assert.rejects(manager.apply({ ...confirmation(), manifestSha256: '0'.repeat(64) }), /确认/);
  await assert.rejects(manager.apply({ ...confirmation(), url: 'https://attacker.example' }), /参数/);
  await manager.apply(confirmation());
  await assert.rejects(manager.apply(confirmation()), /正在/);
  await assert.rejects(manager.check(), /正在/);
  while (!releaseDownload) await new Promise(resolve => setTimeout(resolve, 5));
  releaseDownload(); await settle(manager);
});

test('deployment pins the verified host image identity after portable configuration verification', async context => {
  const hostImage = 'sha256:' + '9'.repeat(64);
  const setup = fixture(context, { load: async () => hostImage });
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  await manager.check(); await manager.apply(confirmation());
  assert.equal((await settle(manager)).job.phase, 'succeeded');
  assert.ok(setup.calls.includes('deploy:' + hostImage));
  assert.equal(JSON.parse(readFileSync(join(setup.directory, 'state.json'))).current.image, hostImage);
});

test('health/deployment failure rolls back without overwriting business databases', async context => {
  for (const stage of ['deploy', 'healthy']) {
    const setup = fixture(context, { [stage]: async () => { throw new Error('private failure with token'); } });
    const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
    await manager.check(); await manager.apply(confirmation());
    const result = await settle(manager);
    assert.equal(result.job.phase, 'rolled-back');
    assert.equal(result.current.version, '1.0.0');
    assert.ok(setup.calls.includes('restore'));
    assert.doesNotMatch(JSON.stringify(result), /private failure|token/);
  }
});

test('pre-deployment failure leaves gateway untouched and failed rollback blocks further updates', async context => {
  const setup = fixture(context, { backup: async () => { throw Error('disk'); } });
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  await manager.check(); await manager.apply(confirmation());
  assert.equal((await settle(manager)).job.phase, 'failed');
  assert.ok(!setup.calls.some(call => call.startsWith('deploy:') || call === 'restore'));
  const broken = fixture(context, { healthy: async () => { throw Error('unhealthy'); }, restore: async () => { throw Error('unhealthy old image'); } });
  const blocked = await createUpdateManager({ source: broken.source, runner: broken.runner, stateDirectory: broken.directory });
  await blocked.check(); await blocked.apply(confirmation());
  assert.equal((await settle(blocked)).job.phase, 'manual-required');
  await assert.rejects(blocked.apply(confirmation()), /人工/);
});

test('interrupted deployment recovers previous immutable image before accepting requests', async context => {
  const setup = fixture(context);
  const previous = await setup.runner.current();
  writeFileSync(join(setup.directory, 'state.json'), JSON.stringify({ schema: 1, current: previous, job: { id: '12345678-1234-1234-1234-123456789abc', phase: 'health', previous, baseline: { engines: ['engine-one'] } } }));
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  await manager.recover();
  assert.equal(manager.status().job.phase, 'rolled-back');
  assert.deepEqual(setup.calls, ['restore']);
});

test('restricted configuration and compose arguments cannot alter project/service or inject commands', () => {
  const config = { project: 'mmwx-unified-jp', gatewayService: 'gateway', gatewayUrl: 'http://127.0.0.1:12900', engineContainers: ['miaomiaowux-jp', 'nodectl'], engineUrls: ['http://127.0.0.1:12890/login', 'http://127.0.0.1:7878/'], architecture: 'amd64', databases: [{ source: '/data/mmwx/mmwx.db', name: 'mmwx.db' }, { source: '/data/nodectl/nodectl.db', name: 'nodectl.db' }], keyFiles: [{ source: '/data/mmwx/mmwx_master.key', name: 'mmwx_master.key' }] };
  assert.equal(validateConfig(config).project, 'mmwx-unified-jp');
  for (const mutation of [{ ...config, project: 'project;rm -rf /' }, { ...config, gatewayService: 'nodectl' }, { ...config, gatewayUrl: 'https://attacker.example' }, { ...config, command: 'sh' }, { ...config, databases: [{ source: '/etc/shadow', name: '../escape' }] }]) assert.throws(() => validateConfig(mutation));
  const args = composeArguments(config, 'up');
  assert.ok(args.includes('--no-deps')); assert.ok(args.includes('--no-build')); assert.ok(args.includes('never'));
  assert.equal(args.at(-1), 'gateway');
  assert.throws(() => composeArguments(config, 'exec'));
});

test('SQLite snapshot includes live WAL data without writing to the original business database', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'updater-database-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.db'), destination = join(directory, 'backup.db');
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO nodes(name) VALUES ('keep original')");
    const previous = readFileSync(source);
    await backupDatabase(source, destination);
    assert.deepEqual(readFileSync(source), previous);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM nodes').get().total, 1);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT name FROM nodes').get().name, 'keep original'); }
    finally { snapshot.close(); }
    assert.equal(statSync(destination).mode & 0o777, 0o600);
  } finally { database.close(); }
});

test('Unix socket API rejects extra parameters and exposes only bounded fixed actions', async context => {
  const setup = fixture(context);
  const manager = await createUpdateManager({ source: setup.source, runner: setup.runner, stateDirectory: setup.directory });
  const socketPath = join(setup.directory, 'updater.sock');
  const server = createUpdaterServer(manager);
  await new Promise(resolve => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o660);
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal((await updateRequest(socketPath, 'status')).enabled, true);
  await assert.rejects(updateRequest(socketPath, 'exec', {}), /操作/);
  await assert.rejects(updateRequest(socketPath, 'check', { url: 'arbitrary' }), /参数/);
  assert.equal((await updateRequest(socketPath, 'check', {})).latest.version, '1.0.1');
  const badStatus = await new Promise(resolve => {
    const outgoing = request({ socketPath, path: '/v1/status?command=exec', method: 'GET' }, response => { response.resume(); resolve(response.statusCode); }); outgoing.end();
  });
  assert.equal(badStatus, 404);
  assert.equal((await updateRequest(null, 'status')).enabled, false);
  await assert.rejects(updateRequest(join(setup.directory, 'missing.sock'), 'status'), /更新器/);
});
