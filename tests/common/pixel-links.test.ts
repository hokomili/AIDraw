import { describe, expect, it } from 'vitest';
import { createPixelDocument, type DocumentAsset, type LinkedAsset } from '@aidraw/core';
import { embedPixelLink, externalizePixelLink, packPixelLinks, pixelLinkHealth, relinkPixelLink } from '../../src/common/pixel-links';

describe('pixel project links', () => {
  const setup = () => {
    const document = createPixelDocument('project');
    const cached: DocumentAsset = { id: 'cache-a', name: 'tiles.png', mimeType: 'image/png', byteLength: 3, sha256: 'a'.repeat(64), source: 'embedded', data: 'YWJj' };
    const link: LinkedAsset = { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'art/tiles.png', sha256: cached.sha256, cachedPreviewAssetId: cached.id };
    document.assets[cached.id] = cached; document.linkedAssets = [link]; return { document, cached, link };
  };

  it('embeds, extracts, relinks, and packs without mutating the source document', () => {
    const { document, cached, link } = setup(); expect(pixelLinkHealth(document, link)).toBe('ready');
    const embedded = embedPixelLink(document, link.id); expect(embedded[0]).toMatchObject({ mode: 'embedded', sha256: cached.sha256 }); expect(embedded[0].relativePath).toBeUndefined();
    document.linkedAssets = embedded; expect(externalizePixelLink(document, link.id, 'exports\\tiles.png')[0]).toMatchObject({ mode: 'linked', relativePath: 'exports/tiles.png' });
    const replacement: DocumentAsset = { ...cached, id: 'cache-b', sha256: 'b'.repeat(64) }; document.assets[replacement.id] = replacement;
    expect(relinkPixelLink(document, link.id, replacement.id, replacement.sha256, 'new/tiles.png')[0]).toMatchObject({ cachedPreviewAssetId: replacement.id, sha256: replacement.sha256, relativePath: 'new/tiles.png' });
    expect(packPixelLinks(document)[0]).toMatchObject({ mode: 'embedded' }); expect(document.linkedAssets[0]).toEqual(embedded[0]);
  });

  it('surfaces missing and mismatched caches instead of packing stale content', () => {
    const { document, link } = setup(); document.assets[link.cachedPreviewAssetId!].sha256 = 'c'.repeat(64); expect(pixelLinkHealth(document, link)).toBe('hash-mismatch'); expect(() => packPixelLinks(document)).toThrow(/does not match/); expect(() => embedPixelLink(document, link.id)).toThrow(/stale cached content/);
    delete document.assets[link.cachedPreviewAssetId!]; expect(pixelLinkHealth(document, link)).toBe('missing-cache'); expect(() => embedPixelLink(document, link.id)).toThrow(/no cached source/);
  });
});
