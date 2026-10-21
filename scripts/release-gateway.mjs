import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { compareVersions, repository, verifyManifest } from '../updater/release.mjs';
import { archiveConfigDigest } from '../updater/image.mjs';

export function buildManifest({ version, revision, images }) {
  compareVersions(version, version);
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('A full source commit is required');
  return Buffer.from(JSON.stringify({ schema: 1, protocol: 1, repository, version, tag: `gateway-v${version}`, revision, images }, null, 2) + '\n');
}

export function signManifest(bytes, privateKey, publicKey) {
  const derived = createPublicKey(privateKey);
  const expected = publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (derived.asymmetricKeyType !== 'ed25519' || !derived.export({ format: 'der', type: 'spki' }).equals(expected.export({ format: 'der', type: 'spki' }))) throw new Error('Release signing key does not match the pinned updater key');
  return sign(null, bytes, privateKey);
}

function run(args, label) {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GATEWAY_RELEASE_SIGNING_KEY: '' } });
  if (result.status !== 0) throw new Error(label + ' failed; review CI build output without publishing secret material');
  return result.stdout.trim();
}

async function main() {
  const tag = process.argv[2];
  if (!/^gateway-v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Expected a stable gateway-vMAJOR.MINOR.PATCH tag');
  const version = tag.slice(9); compareVersions(version, version);
  const privateKey = createPrivateKey(process.env.GATEWAY_RELEASE_SIGNING_KEY || '');
  const publicKey = createPublicKey(readFileSync(new URL('../updater/release-signing.pub', import.meta.url)));
  signManifest(Buffer.from('key preflight'), privateKey, publicKey);
  const revision = run(['git', 'rev-parse', 'HEAD'], 'Resolve release source');
  const directory = resolve(process.argv[3] || '_release'); mkdirSync(directory, { recursive: true });
  const images = {};
  for (const architecture of ['amd64', 'arm64']) {
    const image = `mmwx-gateway:${version}-${architecture}`;
    const asset = `gateway-${version}-${architecture}.tar.gz`;
    const archive = resolve(directory, asset.replace(/\.gz$/, ''));
    console.log(`Building signed gateway ${version} for linux/${architecture}`);
    run(['docker', 'build', '--platform', `linux/${architecture}`, '--build-arg', `GATEWAY_VERSION=${version}`, '--build-arg', `GATEWAY_REVISION=${revision}`, '-f', 'integration/Dockerfile', '-t', image, '.'], 'Gateway image build');
    run(['docker', 'image', 'save', '--output', archive, image], 'Export release image');
    const imageId = await archiveConfigDigest(archive);
    await pipeline(createReadStream(archive), createGzip({ level: 6 }), createWriteStream(resolve(directory, asset)));
    rmSync(archive);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(resolve(directory, asset))) digest.update(chunk);
    images[architecture] = { asset, size: statSync(resolve(directory, asset)).size, sha256: digest.digest('hex'), image, imageId };
  }
  const bytes = buildManifest({ version, revision, images });
  const signature = signManifest(bytes, privateKey, publicKey);
  verifyManifest(bytes, signature, publicKey, 'amd64'); verifyManifest(bytes, signature, publicKey, 'arm64');
  writeFileSync(resolve(directory, 'manifest.json'), bytes);
  writeFileSync(resolve(directory, 'manifest.sig'), signature);
  console.log(JSON.stringify({ release: tag, revision, signed: true, architectures: Object.keys(images) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Gateway release failed validation or build; no release should be published'); process.exitCode = 1; });
