import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createPixelDocument, type DocumentAsset, type LinkedAsset } from '@aidraw/core';
import { portableProjectAssetPath, preparePixelLinkRelink, projectLinkFileExtension, verifiedPixelLinkCache } from '@main/pixel-link-files';

function fixture() {
  const document = createPixelDocument('project');
  document.filePath = join(tmpdir(), 'aidraw-project', 'project.aidraw');
  const bytes = createCanvas(2, 2).toBuffer('image/png');
  const cached: DocumentAsset = {
    id: 'cache-old', name: 'tiles.png', mimeType: 'image/png', byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64'),
  };
  const link: LinkedAsset = {
    id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'old/tiles.png',
    sha256: cached.sha256, cachedPreviewAssetId: cached.id,
  };
  document.assets[cached.id] = cached; document.linkedAssets = [link];
  return { document, bytes, cached, link };
}

describe('pixel project link file preparation', () => {
  it('derives portable paths and verifies the cached source bytes', () => {
    const { document, bytes, cached, link } = fixture();
    expect(portableProjectAssetPath(document, join(tmpdir(), 'aidraw-project', 'art', 'tiles.png'))).toBe('art/tiles.png');
    expect(verifiedPixelLinkCache(document, link.id)).toMatchObject({ link, asset: cached });
    expect(verifiedPixelLinkCache(document, link.id).bytes.equals(bytes)).toBe(true);
    expect(projectLinkFileExtension(cached)).toBe('png');
    document.assets[cached.id].byteLength += 1;
    expect(() => verifiedPixelLinkCache(document, link.id)).toThrow(/stale or corrupt/);
    expect(() => projectLinkFileExtension({ ...cached, mimeType: 'image/svg+xml' })).toThrow(/does not support/);
  });

  it('prepares an atomic relink and deletes an otherwise unreferenced old cache', () => {
    const { document, link } = fixture();
    const replacementCanvas = createCanvas(3, 2); replacementCanvas.getContext('2d').fillRect(0, 0, 3, 2);
    const prepared = preparePixelLinkRelink(document, link.id, join(tmpdir(), 'aidraw-project', 'new', 'tiles.png'), replacementCanvas.toBuffer('image/png'));
    expect(prepared.relativePath).toBe('new/tiles.png');
    expect(prepared.replacement).toMatchObject({ mimeType: 'image/png', source: 'embedded' });
    expect(prepared.linkedAssets[0]).toMatchObject({ id: link.id, mode: 'linked', relativePath: 'new/tiles.png', cachedPreviewAssetId: prepared.replacement.id, sha256: prepared.replacement.sha256 });
    expect(prepared.operations.map((operation) => operation.kind)).toEqual(['asset.add', 'pixel.links.replace', 'asset.delete']);
    expect(document.linkedAssets[0]).toEqual(link);
  });

  it('retains an old cache that still has another canonical reference', () => {
    const { document, link, cached } = fixture();
    document.provenance.push({ id: 'provenance-a', assetId: cached.id, provider: 'external', modelOrWorkflow: 'manual', sourceAssetIds: [], createdAt: new Date().toISOString() });
    const replacement = createCanvas(1, 1).toBuffer('image/png');
    const prepared = preparePixelLinkRelink(document, link.id, join(tmpdir(), 'aidraw-project', 'new.png'), replacement);
    expect(prepared.operations.map((operation) => operation.kind)).toEqual(['asset.add', 'pixel.links.replace']);
  });
});
