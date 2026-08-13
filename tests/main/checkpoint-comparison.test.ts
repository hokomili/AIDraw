import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { HUMAN_ACTOR, createIllustrationDocument } from '@aidraw/core';
import type { DocumentCheckpointRecord, DocumentCheckpointSummary } from '@common/contracts';
import {
  buildCheckpointComparison,
  type CheckpointPngRenderer,
} from '@main/checkpoint-comparison';
import { describe, expect, it, vi } from 'vitest';

function checkpointFixture() {
  const current = createIllustrationDocument('Current checkpoint view');
  current.artboard = { ...current.artboard, width: 3, height: 2, background: '#ff6b7a' };
  current.revision = 4;
  const saved = structuredClone(current);
  saved.name = 'Saved checkpoint view';
  saved.artboard = { ...saved.artboard, width: 2, height: 1, background: '#31a6a0' };
  saved.revision = 2;
  const summary: DocumentCheckpointSummary = {
    id: 'checkpoint-one', documentId: current.id, name: 'Before crop', createdAt: current.createdAt,
    createdBy: HUMAN_ACTOR, sourceRevision: saved.revision, kind: 'manual',
  };
  const checkpoint: DocumentCheckpointRecord = { ...summary, document: saved };
  return { current, saved, summary, checkpoint };
}

function png(width: number, height: number, color: string): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

describe('checkpoint comparison rendering', () => {
  it('renders immutable current and saved snapshots sequentially with exact PNG identities', async () => {
    const { current, saved, summary, checkpoint } = checkpointFixture();
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const renderPng = vi.fn<CheckpointPngRenderer>(async (document) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(document.name);
      await Promise.resolve();
      const width = document.kind === 'illustration' ? document.artboard.width : 1;
      const height = document.kind === 'illustration' ? document.artboard.height : 1;
      const bytes = png(width, height, document.name.startsWith('Current') ? '#ff6b7a' : '#31a6a0');
      active -= 1;
      return bytes;
    });
    const candidates = [{ id: 'layer-one', name: 'Vector 1', type: 'illustration-layer' as const, detail: 'vector' }];

    const result = await buildCheckpointComparison(current, checkpoint, summary, candidates, renderPng);
    expect(order).toEqual([current.name, saved.name]);
    expect(maximumActive).toBe(1);
    expect(renderPng).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      checkpoint: summary,
      current: { revision: 4, width: 3, height: 2, dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
      saved: { revision: 2, width: 2, height: 1, dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
      candidates,
    });
    expect(Buffer.from(result.current.dataUrl.slice('data:image/png;base64,'.length), 'base64')).toEqual(png(3, 2, '#ff6b7a'));
    expect(result.checkpoint).not.toBe(summary);
    expect(result.candidates).not.toBe(candidates);
  });

  it('rejects malformed or contradictory PNG output before returning comparison data', async () => {
    const { current, summary, checkpoint } = checkpointFixture();
    const malformed = vi.fn<CheckpointPngRenderer>(async () => Buffer.from('not a PNG'));
    await expect(buildCheckpointComparison(current, checkpoint, summary, [], malformed)).rejects.toThrow(/invalid PNG/);
    expect(malformed).toHaveBeenCalledOnce();

    const wrongGeometry = vi.fn<CheckpointPngRenderer>(async () => png(1, 1, '#000000'));
    await expect(buildCheckpointComparison(current, checkpoint, summary, [], wrongGeometry)).rejects.toThrow(/contradictory PNG geometry/);
    expect(wrongGeometry).toHaveBeenCalledOnce();
  });

  it('rejects inconsistent checkpoint identity before starting native work', async () => {
    const { current, summary, checkpoint } = checkpointFixture();
    const renderPng = vi.fn<CheckpointPngRenderer>(async () => png(1, 1, '#000000'));
    await expect(buildCheckpointComparison(
      current,
      { ...checkpoint, sourceRevision: checkpoint.sourceRevision + 1 },
      summary,
      [],
      renderPng,
    )).rejects.toThrow(/metadata is inconsistent/);
    expect(renderPng).not.toHaveBeenCalled();
  });

  it('wires the production IPC path to supervised PNG export without a direct renderer import', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    expect(source).toContain('buildCheckpointComparison(current, checkpoint, summary, candidates');
    expect(source).toContain("engineRuntime.rasterUtilities.exportDocument(document, 'png')");
    expect(source).not.toContain("from './render-document'");
    expect(source).not.toContain('Promise.all([renderDocument(current), renderDocument(checkpoint.document)])');
  });
});
