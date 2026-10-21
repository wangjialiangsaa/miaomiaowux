import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { downloadBundle, exactKeys, repository, UpdateError } from './release.mjs';
import { privateJson } from './manager.mjs';

const dockerEnvironment = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: '/tmp/docker-config', LANG: 'C' };
function loopbackUrl(value) {
  const address = new URL(value);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.username || address.password || address.hash || address.search) throw new Error('Only fixed loopback health URLs are allowed');
  return address;
}

export function validateConfig(config) {
  if (!exactKeys(config, ['project', 'gatewayService', 'gatewayUrl', 'engineContainers', 'engineUrls', 'architecture', 'databases', 'keyFiles']) || typeof config.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.project) || config.gatewayService !== 'gateway' || !['amd64', 'arm64'].includes(config.architecture)) throw new Error('Invalid fixed updater configuration');
  loopbackUrl(config.gatewayUrl);
  if (!Array.isArray(config.engineContainers) || config.engineContainers.length < 1 || config.engineContainers.length > 8 || !config.engineContainers.every(name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name))) throw new Error('Invalid protected engine names');
  if (!Array.isArray(config.engineUrls) || config.engineUrls.length !== config.engineContainers.length) throw new Error('Missing protected engine health URLs');
  config.engineUrls.forEach(loopbackUrl);
  for (const entries of [config.databases, config.keyFiles]) {
    if (!Array.isArray(entries) || entries.length > 8 || !entries.every(entry => exactKeys(entry, ['source', 'name']) && typeof entry.name === 'string' && typeof entry.source === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(entry.name) && !entry.name.includes('..') && /^\/data\/(mmwx|nodectl)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(entry.source) && !entry.source.includes('..'))) throw new Error('Invalid read-only backup sources');
  }
  if (new Set([...config.databases, ...config.keyFiles].map(entry => entry.name)).size !== config.databases.length + config.keyFiles.length) throw new Error('Duplicate backup filenames');
  return config;
}

export function composeArguments(config, action) {
  validateConfig(config);
  const args = ['compose', '--project-name', config.project, '--env-file', '/control/gateway.env', '--env-file', '/state/selected.env', '-f', '/control/gateway.yml'];
  if (action === 'up') return [...args, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'gateway'];
  if (action === 'ps') return [...args, 'ps', '-a', '-q', 'gateway'];
  throw new Error('Only the fixed gateway service can be inspected or recreated');
}

function docker(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: '/control', env: dockerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Fixed Docker operation unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && size <= 2 * 1024 * 1024) resolve(Buffer.concat(chunks).toString('utf8').trim()); else reject(new Error('Fixed Docker operation failed')); });
  });
}

async function saveImage(image, destination) {
  const child = spawn('docker', ['image', 'save', image], { cwd: '/control', env: dockerEnvironment, stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Previous image backup failed'))); });
  try { await Promise.all([exited, pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))]); }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}

async function localHealth(address, expected) {
  const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!expected) { await response.body?.cancel(); if (response.status < 200 || response.status >= 400) throw new Error('Engine unavailable'); return; }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 4096) throw new Error('Unexpected health response'); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.status !== 200 || result.ok !== true || result.version !== expected.version || result.revision !== expected.revision) throw new Error('Gateway version health mismatch');
}

export async function backupDatabase(source, destination) {
  const database = new DatabaseSync(source, { readOnly: true, timeout: 10000 });
  try { await sqliteBackup(database, destination); chmodSync(destination, 0o600); }
  finally { database.close(); }
}

export function createDockerRunner(configuration) {
  const config = validateConfig(configuration);
  const jobsDirectory = '/state/jobs';
  mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
  const jobDirectory = job => {
    if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid private job identifier');
    const directory = join(jobsDirectory, job.id); mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
  };
  const inspect = async name => JSON.parse(await docker(['container', 'inspect', '--format', '{{json .}}', name], 15000));
  async function current() {
    const container = await docker(composeArguments(config, 'ps'), 15000);
    if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Exactly one existing gateway is required');
    const result = await inspect(container);
    if (result.Config.Labels?.['com.docker.compose.project'] !== config.project || result.Config.Labels?.['com.docker.compose.service'] !== 'gateway' || !/^sha256:[a-f0-9]{64}$/.test(result.Image)) throw new Error('Gateway identity mismatch');
    const image = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', result.Image], 15000));
    const version = image.Config.Labels?.['org.opencontainers.image.version'];
    const revision = image.Config.Labels?.['org.opencontainers.image.revision'];
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Bootstrap a version-labelled gateway before enabling online updates');
    return { version, revision, image: result.Image };
  }
  async function engines() {
    return Promise.all(config.engineContainers.map(async name => {
      const result = await inspect(name);
      if (!result.State.Running) throw new Error('Protected engine is stopped');
      return { name, id: result.Id, startedAt: result.State.StartedAt };
    }));
  }
  async function healthy(expected, baseline) {
    const deadline = Date.now() + 90000;
    while (true) {
      try {
        await localHealth(config.gatewayUrl.replace(/\/$/, '') + '/_nodectl/health', expected);
        await Promise.all(config.engineUrls.map(address => localHealth(address)));
        if (JSON.stringify(await engines()) !== JSON.stringify(baseline.engines)) throw new Error('Protected engines changed');
        return;
      } catch { if (Date.now() >= deadline) throw new Error('Deployment health checks failed'); await new Promise(resolve => setTimeout(resolve, 2000)); }
    }
  }
  async function deploy(image) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Only immutable verified images can be selected');
    const temporary = '/state/selected.env.tmp';
    writeFileSync(temporary, `GATEWAY_IMAGE=${image}\n`, { mode: 0o600 }); chmodSync(temporary, 0o600);
    const { renameSync } = await import('node:fs'); renameSync(temporary, '/state/selected.env');
    await docker(composeArguments(config, 'up'));
  }
  return {
    current,
    async preflight(candidate, previous) {
      if ((await current()).image !== previous.image) throw new Error('Gateway changed outside updater');
      const disk = statfsSync('/state', { bigint: true });
      const databaseBytes = config.databases.reduce((total, entry) => total + statSync(entry.source).size, 0);
      const needed = BigInt(candidate.manifest.selected.size * 6 + databaseBytes * 2 + 512 * 1024 * 1024);
      if (disk.bavail * disk.bsize < needed) throw new UpdateError(409, '磁盘空间不足，未替换运行中的网关');
      await Promise.all(config.engineUrls.map(address => localHealth(address)));
      return { engines: await engines() };
    },
    async download(job, candidate) { await downloadBundle(candidate, join(jobDirectory(job), 'gateway.tar.gz')); },
    async backup(job) {
      const directory = jobDirectory(job);
      for (const entry of config.databases) {
        await backupDatabase(entry.source, join(directory, entry.name));
      }
      for (const entry of config.keyFiles) { copyFileSync(entry.source, join(directory, entry.name)); chmodSync(join(directory, entry.name), 0o600); }
      for (const file of ['config.json', 'gateway.env', 'gateway.yml']) { copyFileSync('/control/' + file, join(directory, file)); chmodSync(join(directory, file), 0o600); }
      await saveImage(job.previous.image, join(directory, 'previous-image.tar.gz'));
      privateJson(join(directory, 'transaction.json'), { schema: 1, previous: job.previous, baseline: job.baseline });
    },
    async load(job, candidate) {
      await docker(['image', 'load', '--input', join(jobDirectory(job), 'gateway.tar.gz'), '--quiet'], 180000);
      const selected = candidate.manifest.selected;
      const image = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', selected.image], 15000));
      const labels = image.Config?.Labels || {};
      if (image.Id !== selected.imageId || image.Architecture !== config.architecture || labels['org.opencontainers.image.version'] !== candidate.manifest.version || labels['org.opencontainers.image.revision'] !== candidate.manifest.revision || labels['org.opencontainers.image.source'] !== `https://github.com/${repository}`) throw new Error('Loaded image identity or release labels mismatch');
    },
    deploy, healthy,
    async restore(job) { await deploy(job.previous.image); await healthy(job.previous, job.baseline); },
    async cleanup(job) {
      rmSync(join(jobDirectory(job), 'gateway.tar.gz'), { force: true });
      const directories = readdirSync(jobsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)).map(entry => ({ name: entry.name, modified: statSync(join(jobsDirectory, entry.name)).mtimeMs })).sort((left, right) => right.modified - left.modified);
      for (const entry of directories.slice(3)) if (entry.name !== job.id) rmSync(join(jobsDirectory, entry.name), { recursive: true, force: true });
    },
  };
}
