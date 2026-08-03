import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  createId,
  createIllustrationDocument,
  createPixelDocument,
  nowIso,
  type Actor,
  type CanvasOperation,
  type IllustrationObject,
  type PaintStyle,
} from '@aidraw/core';
import { DocumentService } from '../src/main/document-service.ts';
import { RecoveryJournal } from '../src/main/journal.ts';
import { renderDocument } from '../src/main/render-document.ts';

const outputDir = join(process.cwd(), 'autonomous-output');
const journalDir = join(outputDir, 'recovery');
const agent: Actor = { id: 'agent-autonomous-drawer', kind: 'agent', name: 'Autonomous Drawer', color: '#7c5cff' };

function baseObject(documentId: string, layerId: string, name: string, transform: { x: number; y: number; rotation?: number }): Record<string, unknown> {
  const timestamp = nowIso();
  return {
    id: createId('object'), revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy: agent.id,
    layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    transform: { x: transform.x, y: transform.y, scaleX: 1, scaleY: 1, rotation: transform.rotation ?? 0, skewX: 0, skewY: 0 },
  };
}

function solid(color: string): PaintStyle { return { kind: 'solid', color }; }
function gradient(stops: Array<{ offset: number; color: string }>): PaintStyle {
  return { kind: 'linear-gradient', stops, x1: 0, y1: 0, x2: 0, y2: 600 };
}
function stroke(color = '#27213c', width = 4): IllustrationObject extends never ? never : { paint: PaintStyle; width: number; opacity: number; lineCap: 'round'; lineJoin: 'round'; dash: number[] } {
  return { paint: solid(color), width, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } as never;
}

function shape(
  documentId: string,
  layerId: string,
  name: string,
  shapeType: 'rectangle' | 'ellipse' | 'polygon' | 'star',
  x: number,
  y: number,
  width: number,
  height: number,
  fill: PaintStyle,
  options: { sides?: number; innerRadius?: number; rotation?: number; stroke?: ReturnType<typeof stroke> } = {},
): IllustrationObject {
  return {
    ...baseObject(documentId, layerId, name, { x, y, rotation: options.rotation }),
    type: 'shape', shape: shapeType, width, height, fill, stroke: options.stroke ?? stroke('#27213c', 3),
    fillRule: 'nonzero', sides: options.sides, innerRadius: options.innerRadius,
  } as IllustrationObject;
}

async function applyTransaction(service: DocumentService, documentId: string, label: string, operations: CanvasOperation[]): Promise<void> {
  const result = await service.apply({
    id: createId('tx'), clientOperationId: `autonomous-${createId('op')}`, documentId, actor: agent, label, createdAt: nowIso(), operations,
    playback: { mode: 'instant', speed: 1 },
  });
  if (result.status !== 'committed') throw new Error(`${label} failed: ${result.message ?? result.status}`);
}

async function drawIllustration(service: DocumentService): Promise<void> {
  const document = createIllustrationDocument('Autonomous Constellation');
  document.artboard.width = 960;
  document.artboard.height = 600;
  document.artboard.background = '#17152b';
  const vectorLayer = Object.values(document.layers).find((layer) => layer.type === 'vector');
  if (!vectorLayer || vectorLayer.type !== 'vector') throw new Error('Vector layer unavailable');
  service.addDocument(document);

  const operations: CanvasOperation[] = [];
  const add = (object: IllustrationObject) => operations.push({ kind: 'illustration.object.add', object });
  add(shape(document.id, vectorLayer.id, 'Sky glow', 'rectangle', 0, 0, 960, 600, gradient([
    { offset: 0, color: '#25204b' }, { offset: 0.55, color: '#382a67' }, { offset: 1, color: '#101326' },
  ]), { stroke: stroke('#25204b', 0) }));
  add(shape(document.id, vectorLayer.id, 'Moon', 'ellipse', 690, 76, 118, 118, solid('#fff1c7'), { stroke: stroke('#fff1c7', 2) }));
  add(shape(document.id, vectorLayer.id, 'Moon shadow', 'ellipse', 726, 62, 110, 110, solid('#25204b'), { stroke: stroke('#25204b', 0) }));
  add(shape(document.id, vectorLayer.id, 'Distant ridge', 'polygon', 0, 300, 500, 260, solid('#40376f'), { sides: 3, rotation: 0, stroke: stroke('#40376f', 0) }));
  add(shape(document.id, vectorLayer.id, 'Distant ridge 2', 'polygon', 420, 286, 600, 274, solid('#332d5d'), { sides: 3, stroke: stroke('#332d5d', 0) }));
  add(shape(document.id, vectorLayer.id, 'Front ridge', 'polygon', 0, 392, 620, 250, solid('#17152b'), { sides: 3, stroke: stroke('#17152b', 0) }));
  add(shape(document.id, vectorLayer.id, 'Front ridge 2', 'polygon', 500, 360, 560, 280, solid('#101326'), { sides: 3, stroke: stroke('#101326', 0) }));
  add(shape(document.id, vectorLayer.id, 'Summit star', 'star', 456, 100, 46, 46, solid('#ffb38a'), { sides: 5, innerRadius: 0.42, stroke: stroke('#fff1c7', 2) }));
  for (const [index, x, y] of [[0, 100, 110], [1, 210, 170], [2, 330, 82], [3, 585, 128], [4, 830, 212], [5, 760, 324], [6, 160, 280]] as Array<[number, number, number]>) {
    add(shape(document.id, vectorLayer.id, `Star ${index + 1}`, 'ellipse', x, y, 7, 7, solid(index % 2 ? '#74c7ec' : '#fffdf7'), { stroke: stroke('#fffdf7', 0) }));
  }
  add({
    ...baseObject(document.id, vectorLayer.id, 'Title', { x: 54, y: 48 }), type: 'text', text: 'NIGHT SIGNALS', width: 500, height: 70,
    align: 'left', lineHeight: 1.1, ranges: [{ start: 0, end: 12, fontFamily: 'sans-serif', fontSize: 34, fontWeight: 700, fontStyle: 'normal', color: '#fffdf7', letterSpacing: 7 }],
  } as IllustrationObject);
  add({
    ...baseObject(document.id, vectorLayer.id, 'Subtitle', { x: 58, y: 101 }), type: 'text', text: 'an autonomous study in violet', width: 420, height: 34,
    align: 'left', lineHeight: 1.1, ranges: [{ start: 0, end: 28, fontFamily: 'sans-serif', fontSize: 15, fontWeight: 400, fontStyle: 'normal', color: '#ad8ee6', letterSpacing: 1.2 }],
  } as IllustrationObject);
  await applyTransaction(service, document.id, 'Compose autonomous constellation', operations);
  const final = service.getDocument(document.id)!;
  await service.save(document.id, join(outputDir, 'autonomous-constellation.aidraw'));
  const png = (await renderDocument(final)).toBuffer('image/png');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(outputDir, 'autonomous-constellation.png'), png));
}

async function drawPixelSprite(service: DocumentService): Promise<void> {
  const document = createPixelDocument('sprite', 'Autonomous Firefly');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite?.type !== 'sprite') throw new Error('Sprite unavailable');
  sprite.width = 32; sprite.height = 32;
  service.addDocument(document);
  const cx = 15.5; const cy = 16;
  const circle = (radius: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= radius;
  const changes = Array.from({ length: 32 * 32 }, (_, n) => {
    const x = n % 32; const y = Math.floor(n / 32); const dx = Math.abs(x - cx); const dy = Math.abs(y - cy);
    let index = 0;
    if (circle(10)(x, y)) index = 2;
    if (circle(7)(x, y)) index = 4;
    if (dx <= 3 && dy <= 5) index = 6;
    if (x >= 12 && x <= 19 && y >= 8 && y <= 10) index = 7;
    if ((x === 10 || x === 21) && y >= 12 && y <= 18) index = 8;
    if ((x === 8 || x === 23) && y >= 15 && y <= 17) index = 9;
    if ((x === 13 || x === 18) && y >= 13 && y <= 15) index = 12;
    return { x, y, index };
  });
  await applyTransaction(service, document.id, 'Paint autonomous firefly sprite', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: Object.values(sprite.cels)[0].id, changes }]);
  const final = service.getDocument(document.id)!;
  await service.save(document.id, join(outputDir, 'autonomous-firefly.aidraw'));
  const png = (await renderDocument(final)).toBuffer('image/png');
  const preview = createCanvas(512, 512);
  const previewContext = preview.getContext('2d');
  previewContext.imageSmoothingEnabled = false;
  previewContext.drawImage((await renderDocument(final)), 0, 0, 512, 512);
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(join(outputDir, 'autonomous-firefly.png'), png),
    writeFile(join(outputDir, 'autonomous-firefly-zoom.png'), preview.toBuffer('image/png')),
  ]));
}

await mkdir(outputDir, { recursive: true });
const service = new DocumentService(new RecoveryJournal(journalDir), '1.0.0-autonomous-test');
await drawIllustration(service);
await drawPixelSprite(service);
console.log(JSON.stringify({ outputDir, files: ['autonomous-constellation.aidraw', 'autonomous-constellation.png', 'autonomous-firefly.aidraw', 'autonomous-firefly.png', 'autonomous-firefly-zoom.png'] }, null, 2));
