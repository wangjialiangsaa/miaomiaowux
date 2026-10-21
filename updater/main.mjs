import { createPublicKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createDockerRunner, validateConfig } from './docker.mjs';
import { createUpdateManager } from './manager.mjs';
import { createReleaseSource } from './release.mjs';
import { createUpdaterServer } from './server.mjs';

process.umask(0o077);
try {
  const config = validateConfig(JSON.parse(readFileSync('/control/config.json', 'utf8')));
  if (config.architecture !== { x64: 'amd64', arm64: 'arm64' }[process.arch]) throw new Error('Architecture mismatch');
  const publicKey = createPublicKey(readFileSync(new URL('./release-signing.pub', import.meta.url)));
  const manager = await createUpdateManager({ source: createReleaseSource(publicKey, config.architecture), runner: createDockerRunner(config), stateDirectory: '/state' });
  await manager.recover();
  mkdirSync('/run/mmwx-updater', { recursive: true, mode: 0o750 }); chmodSync('/run/mmwx-updater', 0o750);
  const socketPath = '/run/mmwx-updater/updater.sock';
  rmSync(socketPath, { force: true });
  const server = createUpdaterServer(manager);
  server.listen(socketPath, () => { chmodSync(socketPath, 0o660); console.log(JSON.stringify({ event: 'restricted_updater_ready' })); });
  server.on('error', () => { console.error('Updater socket unavailable'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); });
} catch { console.error('Updater startup failed; check root-controlled configuration, image labels and private state'); process.exitCode = 1; }
