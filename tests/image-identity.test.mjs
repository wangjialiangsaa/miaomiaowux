import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { archiveConfigDigest } from '../updater/image.mjs';

test('portable signed image identity uses exact configuration bytes, not store-specific manifest IDs', async () => {
  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', config: { User: 'node' }, rootfs: { type: 'layers', diff_ids: ['sha256:' + 'a'.repeat(64)] } }));
  const digest = createHash('sha256').update(config).digest('hex');
  for (const filename of [digest + '.json', 'blobs/sha256/' + digest]) {
    const members = new Map([['manifest.json', Buffer.from(JSON.stringify([{ Config: filename, Layers: ['layer.tar'], RepoTags: ['mmwx-gateway:1.0.2-amd64'] }]))], [filename, config]]);
    assert.equal(await archiveConfigDigest('/private/synthetic.tar', { readMember: async (archive, member) => members.get(member) }), 'sha256:' + digest);
  }
});

test('image configuration extraction rejects traversal, ambiguous manifests and digest mismatches', async () => {
  for (const manifest of [[], [{ Config: '../../etc/shadow' }], [{ Config: 'a'.repeat(64) + '.json' }, { Config: 'b'.repeat(64) + '.json' }], [{ Config: 'a'.repeat(64) + '.json' }]]) {
    await assert.rejects(archiveConfigDigest('/private/synthetic.tar', { readMember: async (archive, member) => member === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : Buffer.from('tampered configuration') }));
  }
});
