import { createHash, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const repository = 'wangjialiangsaa/miaomiaowux';
export const maximumBundleSize = 300 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const downloadHosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export class UpdateError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function compareVersions(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !versionPattern.test(left) || !versionPattern.test(right)) throw new UpdateError(400, '无效的更新版本');
  const leftParts = left.split('.').map(Number), rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  return 0;
}

export function verifyManifest(bytes, signature, publicKey, architecture) {
  if (!['amd64', 'arm64'].includes(architecture)) throw new UpdateError(400, '不支持的服务器架构');
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !Buffer.isBuffer(signature) || signature.length !== 64 || !verify(null, bytes, publicKey, signature)) throw new UpdateError(422, '发布签名校验失败');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new UpdateError(422, '发布清单无效'); }
  const invalid = () => new UpdateError(422, '发布清单字段或镜像身份不符合要求');
  if (!exactKeys(value, ['schema', 'protocol', 'repository', 'version', 'tag', 'revision', 'images']) || value.schema !== 1 || value.protocol !== 1 || value.repository !== repository || typeof value.version !== 'string' || !versionPattern.test(value.version) || value.tag !== `gateway-v${value.version}` || typeof value.revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.revision)) throw invalid();
  if (!exactKeys(value.images, ['amd64', 'arm64'])) throw invalid();
  for (const platform of ['amd64', 'arm64']) {
    const image = value.images[platform];
    if (!exactKeys(image, ['asset', 'size', 'sha256', 'image', 'imageId']) || image.asset !== `gateway-${value.version}-${platform}.tar.gz` || !Number.isSafeInteger(image.size) || image.size < 1 || image.size > maximumBundleSize || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) || image.image !== `mmwx-gateway:${value.version}-${platform}` || typeof image.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.imageId)) throw invalid();
  }
  return { ...value, architecture, selected: value.images[architecture] };
}

export function releaseUrl(tag, asset) {
  if (!/^gateway-v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(tag) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(asset) || asset.includes('..')) throw new UpdateError(400, '无效的下载标识');
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

async function openDownload(address, options = {}) {
  let target = new URL(address);
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs || 20000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !downloadHosts.has(target.hostname)) throw new UpdateError(422, '下载地址不在受信任的 HTTPS 发布源中');
    const response = await (options.fetch || fetch)(target.href, { redirect: 'manual', signal, headers: { accept: 'application/octet-stream', 'user-agent': 'mmwx-gateway-updater/1' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new UpdateError(502, '发布下载重定向无效');
      target = new URL(location, target); continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new UpdateError(502, '无法从 GitHub 下载发布文件，请稍后重试'); }
    return response;
  }
  throw new UpdateError(502, '发布下载重定向过多');
}

export async function fetchBounded(address, limit, options = {}) {
  const response = await openDownload(address, options);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new UpdateError(422, '发布文件大小超过限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadBundle(candidate, destination, options = {}) {
  const image = candidate.manifest.selected;
  const digest = createHash('sha256');
  let size = 0;
  try {
    const response = await openDownload(releaseUrl(candidate.manifest.tag, image.asset), { timeoutMs: 300000, ...options });
    const verifier = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > image.size) return callback(new UpdateError(422, '镜像文件大小校验失败'));
      digest.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (size !== image.size || digest.digest('hex') !== image.sha256) throw new UpdateError(422, '镜像文件 SHA-256 校验失败');
  } catch (error) { await rm(destination, { force: true }); throw error; }
}

export function createReleaseSource(publicKey, architecture) {
  let cached = null, lastCheck = 0;
  return { async latest() {
    if (cached && Date.now() - lastCheck < 60000) return cached;
    if (Date.now() - lastCheck < 15000) throw new UpdateError(429, '检查过于频繁，请稍后重试');
    lastCheck = Date.now();
    try {
      const bytes = await fetchBounded(`https://api.github.com/repos/${repository}/releases?per_page=100`, 2 * 1024 * 1024);
      const releases = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(releases)) throw new Error('Invalid release list');
      const release = releases.filter(item => !item.draft && !item.prerelease && /^gateway-v\d+\.\d+\.\d+$/.test(item.tag_name)).sort((left, right) => compareVersions(right.tag_name.slice(9), left.tag_name.slice(9)))[0];
      if (!release) throw new UpdateError(404, '暂时没有已签名的网关发布版本');
      const [manifestBytes, signature] = await Promise.all([fetchBounded(releaseUrl(release.tag_name, 'manifest.json'), 65536), fetchBounded(releaseUrl(release.tag_name, 'manifest.sig'), 64)]);
      const manifest = verifyManifest(manifestBytes, signature, publicKey, architecture);
      if (manifest.tag !== release.tag_name) throw new UpdateError(422, '发布标签与签名清单不一致');
      cached = { manifest, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), notes: String(release.body || '').slice(0, 6000) };
      return cached;
    } catch (error) { cached = null; throw error instanceof UpdateError ? error : new UpdateError(502, '无法校验 GitHub 发布，请稍后重试'); }
  } };
}
