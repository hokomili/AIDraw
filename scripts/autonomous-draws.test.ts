import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNativeDocument } from '../src/main/persistence';

describe('autonomous drawing smoke test', () => {
  it('generates native documents and previews', async () => {
    await import('./autonomous-draws.ts');
    const outputDir = join(process.cwd(), 'autonomous-output');
    for (const file of ['autonomous-constellation.aidraw', 'autonomous-constellation.png', 'autonomous-firefly.aidraw', 'autonomous-firefly.png', 'autonomous-firefly-zoom.png']) {
      const bytes = await readFile(join(outputDir, file));
      expect(bytes.byteLength).toBeGreaterThan(100);
    }
    const constellation = await readNativeDocument(join(outputDir, 'autonomous-constellation.aidraw'));
    const firefly = await readNativeDocument(join(outputDir, 'autonomous-firefly.aidraw'));
    expect(constellation.document.kind).toBe('illustration');
    expect(firefly.document.kind).toBe('pixel');
    expect(constellation.document.activity[0]?.actor.id).toBe('agent-autonomous-drawer');
    expect(firefly.document.activity[0]?.actor.id).toBe('agent-autonomous-drawer');
  }, 120_000);
});
