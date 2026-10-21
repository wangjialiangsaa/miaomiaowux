import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { buildManifest, signManifest } from '../scripts/release-gateway.mjs';
import { verifyManifest } from '../updater/release.mjs';

test('release builder generates the exact updater protocol and requires the pinned signing key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '1.0.0', revision = 'f'.repeat(40);
  const images = Object.fromEntries(['amd64', 'arm64'].map(architecture => [architecture, { asset: `gateway-${version}-${architecture}.tar.gz`, image: `mmwx-gateway:${version}-${architecture}`, size: 1024, sha256: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64) }]));
  const bytes = buildManifest({ version, revision, images });
  const signature = signManifest(bytes, privateKey, publicKey);
  assert.equal(verifyManifest(bytes, signature, publicKey, 'arm64').revision, revision);
  assert.throws(() => signManifest(bytes, generateKeyPairSync('ed25519').privateKey, publicKey), /pinned/);
  assert.throws(() => buildManifest({ version: 'latest', revision, images }));
});
