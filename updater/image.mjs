import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

function readTarMember(archive, member) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xOf', archive, member], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Image configuration reader unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && size <= 1024 * 1024) resolve(Buffer.concat(chunks)); else reject(new Error('Image configuration export is invalid or oversized')); });
  });
}

export async function archiveConfigDigest(archive, { readMember = readTarMember } = {}) {
  const bytes = await readMember(archive, 'manifest.json');
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) throw new Error('Invalid image archive manifest');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(manifest) || manifest.length !== 1 || typeof manifest[0]?.Config !== 'string' || !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(manifest[0].Config)) throw new Error('Image archive must contain exactly one safe configuration');
  const config = await readMember(archive, manifest[0].Config);
  if (!Buffer.isBuffer(config) || config.length > 1024 * 1024) throw new Error('Invalid image configuration');
  const digest = createHash('sha256').update(config).digest('hex');
  if (!manifest[0].Config.includes(digest)) throw new Error('Image configuration filename digest mismatch');
  return 'sha256:' + digest;
}
