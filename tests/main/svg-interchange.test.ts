import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { importDocument } from '@main/import-document';
import { illustrationToSvg } from '@main/export-document';
import { importEditableSvg } from '@main/svg-import';
import { renderIllustration } from '@main/render-document';
import { convertPathArcsToCubics } from '@common/path-conversion';
import { inspectPathNodes } from '@common/path-nodes';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { createId, createIllustrationDocument, HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, validateDocument, type DocumentAsset, type ImageObject, type TextObject } from '@aidraw/core';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'svg', 'structured-editor.svg');

describe('editable SVG interchange', () => {
  it('rejects hostile path grammar before it can enter an imported canonical document', () => {
    for (const pathData of [
      'M0 0 A1 2 0 1e0 0 3 4',
      'M0 0 A1 2 0 0.0 1 3 4',
      'M0 0 L10 10 garbage',
      'M0 0 A-1 2 0 0 1 3 4',
      'M0 0',
      'M0 0 L1 1 M2 2 L3 3',
      'M0 0 L0 0 Z',
      'M0 0 L0.00000001 0 Z',
      'M0 0 C1 1 2 2 0 0 Z',
      'M0 0 A10 10 0 0 1 0 0',
      'M0 0 A10 10 0 0 1 0.000001 0',
      'M0 0 A1 1000 0 0 0 0 0.00001',
      `M0 0${' L1 1'.repeat(100_000)}`,
      `M0 0${' A1 1 0 0 1 2 2'.repeat(25_000)}`,
      `M0 0 A1 1 0 0 1 2 2 ${'L0 0 '.repeat(200_000)}`,
    ]) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path d="${pathData}"/></svg>`;
      expect(() => importEditableSvg(source, 'Hostile path import'), pathData).toThrow("SVG import produced content outside AIDraw's canonical illustration limits.");
    }
  });

  it('retains compact imported arc flags through edit, render, export, delete, undo, checkpoint, and recovery', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path id="compact-arc" d="M0 0 A1 2 0 013 4" fill="none" stroke="#000"/></svg>';
    const imported = importEditableSvg(source, 'Compact arc compatibility').document;
    const path = Object.values(imported.objects).find((object) => object.name === 'compact-arc');
    if (!path || path.type !== 'path') throw new Error('Expected imported compact arc');
    expect(path.pathData).toBe('M0 0 A1 2 0 013 4');
    await expect(renderIllustration(imported)).resolves.toBeTruthy();
    expect(illustrationToSvg(imported)).toContain('d="M0 0 A1 2 0 013 4"');
    const converted = convertPathArcsToCubics(path.pathData);
    expect(converted.pathData).not.toMatch(/[aA]/);
    expect(inspectPathNodes(converted.pathData).length).toBeGreaterThanOrEqual(2);
    expect(inspectPathNodes(converted.pathData).length).toBeLessThanOrEqual(5);
    const convertedDocument = structuredClone(imported); convertedDocument.objects[path.id] = { ...path, ...converted, revision: path.revision + 1 };
    await expect(renderIllustration(convertedDocument)).resolves.toBeTruthy();
    expect(illustrationToSvg(convertedDocument)).toContain(' d="M');

    const root = await mkdtemp(join(tmpdir(), 'aidraw-compact-arc-'));
    const journal = new RecoveryJournal(root);
    const service = new DocumentService(journal, '1.0.0');
    try {
      service.initialize();
      service.addDocument(imported);
      expect(await service.apply({
        id: createId('tx'), clientOperationId: 'compact-arc-edit', documentId: imported.id, actor: HUMAN_ACTOR,
        label: 'Edit compact imported arc', createdAt: nowIso(), operations: [{ kind: 'illustration.object.replace', object: { ...path, pathData: 'M0 0 A1 2 0 01 3 4' }, expectedRevision: path.revision }],
      })).toMatchObject({ status: 'committed' });
      const checkpoint = service.createCheckpoint(imported.id, 'Compact arc retained');
      const edited = service.getDocument(imported.id);
      if (!edited || edited.kind !== 'illustration') throw new Error('Expected edited illustration');
      const editedPath = edited.objects[path.id];
      expect(await service.apply({
        id: createId('tx'), clientOperationId: 'compact-arc-delete', documentId: imported.id, actor: HUMAN_ACTOR,
        label: 'Delete compact imported arc', createdAt: nowIso(), operations: [{ kind: 'illustration.object.delete', objectId: path.id, expectedRevision: editedPath.revision }],
      })).toMatchObject({ status: 'committed' });
      expect(await service.undo(imported.id)).toMatchObject({ status: 'committed' });
      const undone = service.getDocument(imported.id);
      expect(undone?.kind === 'illustration' ? undone.objects[path.id] : undefined).toMatchObject({ pathData: 'M0 0 A1 2 0 01 3 4' });
      expect(await service.redo(imported.id)).toMatchObject({ status: 'committed' });
      expect(await service.restoreCheckpoint(imported.id, checkpoint.id)).toMatchObject({ status: 'committed' });
      await service.flushRecovery();
      const recovered = (await new RecoveryJournal(root).recover()).find((document) => document.id === imported.id);
      expect(recovered?.kind === 'illustration' ? recovered.objects[path.id] : undefined).toMatchObject({ pathData: 'M0 0 A1 2 0 01 3 4' });
      if (!recovered || recovered.kind !== 'illustration') throw new Error('Expected recovered compact arc');
      await expect(renderIllustration(recovered)).resolves.toBeTruthy();
      expect(illustrationToSvg(recovered)).toContain('d="M0 0 A1 2 0 01 3 4"');
    } finally {
      await service.flushRecovery();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports external-style groups, transforms, styles, gradients, use, masks, filters, text ranges, and embedded images', async () => {
    const imported = await importDocument(fixture);
    expect(imported.documents).toHaveLength(1);
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(document.artboard).toMatchObject({ width: 160, height: 120, background: null });
    const byName = (name: string) => Object.values(document.objects).find((object) => object.name === name);
    const locomotive = byName('locomotive'); expect(locomotive).toMatchObject({ type: 'group', opacity: 0.9, transform: { x: 20, y: 30 } }); expect(locomotive?.transform.rotation).toBeCloseTo(5);
    const body = byName('gold-body');
    expect(body?.type === 'shape' ? body.fill : undefined).toMatchObject({ kind: 'linear-gradient', stops: [{ color: '#6f3d08' }, { color: '#fff0a0', opacity: 0.8 }, { color: '#9b5f10' }] });
    expect(body?.type === 'shape' ? body.stroke : undefined).toMatchObject({ width: 2, lineJoin: 'round', paint: { kind: 'solid', color: '#3a2418' } });
    const label = byName('label');
    expect(label?.type === 'text' ? label.text : undefined).toBe('Gold Express');
    expect(label?.type === 'text' ? label.ranges.map((range) => ({ text: label.text.slice(range.start, range.end), color: range.color, fontStyle: range.fontStyle })) : undefined).toEqual([
      { text: 'Gold ', color: '#20150f', fontStyle: 'normal' },
      { text: 'Express', color: '#b02040', fontStyle: 'italic' },
    ]);
    const lamp = byName('lamp'); expect(lamp?.type).toBe('image'); expect(lamp?.type === 'image' ? document.assets[lamp.assetId]?.mimeType : undefined).toBe('image/png');
    const glow = byName('window-glow'); expect(glow).toMatchObject({ type: 'path', blur: 1.5 }); expect(glow?.maskObjectId).toBeTruthy(); expect(glow?.maskObjectId ? document.objects[glow.maskObjectId]?.visible : undefined).toBe(false);
    expect(byName('badge-use')?.type).toBe('group');
    expect(byName('ViewBox')).toMatchObject({ type: 'group', transform: { x: -10, y: -20 } });
    expect(imported.warnings).toContainEqual(expect.stringMatching(/foreignObject/));
    expect(validateDocument(document)).toEqual(document);
  });

  it('round-trips the supported editable structure through AIDraw SVG export', async () => {
    const imported = await importDocument(fixture); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const svg = illustrationToSvg(document);
    expect(svg).toContain('<linearGradient'); expect(svg).toContain('<g transform='); expect(svg).toContain('<tspan'); expect(svg).toContain('data:image/png;base64'); expect(svg).toContain('clip-path="url(#clip-');
    const reopened = importEditableSvg(svg, 'Round trip').document;
    expect(Object.values(reopened.objects).some((object) => object.type === 'group')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'shape' && object.fill.kind === 'linear-gradient')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'text' && object.ranges.length >= 2)).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'image')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => Boolean(object.maskObjectId))).toBe(true);
  });

  it('applies the outer SVG viewBox scale and preserveAspectRatio alignment before editable geometry', async () => {
    const source = (preserveAspectRatio?: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="10 20 100 100"${preserveAspectRatio ? ` preserveAspectRatio="${preserveAspectRatio}"` : ''}><rect id="top" x="10" y="20" width="100" height="50" fill="#ff0000"/><rect id="bottom" x="10" y="70" width="100" height="50" fill="#0000ff"/></svg>`;
    const inspect = async (preserveAspectRatio?: string) => {
      const result = importEditableSvg(source(preserveAspectRatio), preserveAspectRatio ?? 'default meet');
      const viewport = Object.values(result.document.objects).find((object) => object.name === 'ViewBox');
      const canvas = await renderIllustration(result.document); const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const pixel = (x: number, y: number) => [...pixels.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)];
      return { result, viewport, canvas, pixel };
    };

    const meet = await inspect();
    expect(meet.viewport).toMatchObject({ type: 'group', transform: { x: 40, y: -20, scaleX: 1, scaleY: 1 } });
    expect(meet.pixel(25, 25)).toEqual([0, 0, 0, 0]); expect(meet.pixel(75, 25)).toEqual([255, 0, 0, 255]); expect(meet.pixel(75, 75)).toEqual([0, 0, 255, 255]);
    meet.canvas.width = 1; meet.canvas.height = 1;

    const stretched = await inspect('none');
    expect(stretched.viewport).toMatchObject({ type: 'group', transform: { x: -20, y: -20, scaleX: 2, scaleY: 1 } });
    expect(stretched.pixel(25, 25)).toEqual([255, 0, 0, 255]); expect(stretched.pixel(175, 75)).toEqual([0, 0, 255, 255]);
    stretched.canvas.width = 1; stretched.canvas.height = 1;

    const sliced = await inspect('xMidYMax slice');
    expect(sliced.viewport).toMatchObject({ type: 'group', transform: { x: -20, y: -140, scaleX: 2, scaleY: 2 } });
    expect(sliced.pixel(25, 25)).toEqual([0, 0, 255, 255]); expect(sliced.pixel(175, 75)).toEqual([0, 0, 255, 255]);
    sliced.canvas.width = 1; sliced.canvas.height = 1;

    const invalid = await inspect('xSidewaysYMid crop');
    expect(invalid.result.warnings).toContain('Invalid SVG preserveAspectRatio was reduced to the default xMidYMid meet behavior.');
    expect(invalid.viewport).toMatchObject({ type: 'group', transform: { x: 40, y: -20, scaleX: 1, scaleY: 1 } });
    invalid.canvas.width = 1; invalid.canvas.height = 1;
    expect(() => importEditableSvg(source('none').replace('viewBox="10 20 100 100"', 'viewBox="10 20 5e-324 100"'), 'Non-finite outer viewport')).toThrow('SVG viewBox produces a non-finite viewport transform.');
  });

  it('applies nested SVG and referenced-symbol viewports while leaving unreferenced symbols hidden', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="120"><defs><symbol id="badge" viewBox="0 0 10 20"><rect id="badge-top" width="10" height="10" fill="#ff0000"/><rect id="badge-bottom" y="10" width="10" height="10" fill="#0000ff"/></symbol></defs><symbol id="unused"><rect id="unused-fill" width="240" height="120" fill="#ff00ff"/></symbol><use id="badge-use" xlink:href="#badge" x="20" y="10" width="50%" height="100px"/><svg id="nested" x="60%" y="10" width="80px" height="100" viewBox="0 0 20 10" preserveAspectRatio="none"><rect id="nested-left" width="10" height="10" fill="#00ff00"/><rect id="nested-right" x="10" width="10" height="10" fill="#ffff00"/></svg></svg>';
    const result = importEditableSvg(source, 'Nested viewports'); const byName = (name: string) => Object.values(result.document.objects).find((object) => object.name === name);
    expect(byName('badge-use')).toMatchObject({ type: 'group', transform: { x: 20, y: 10 } });
    expect(byName('Symbol ViewBox')).toMatchObject({ type: 'group', transform: { x: 35, y: 0, scaleX: 5, scaleY: 5 } });
    expect(byName('nested')).toMatchObject({ type: 'group', transform: { x: 144, y: 10 } });
    expect(byName('Nested SVG ViewBox')).toMatchObject({ type: 'group', transform: { x: 0, y: 0, scaleX: 4, scaleY: 10 } });
    expect(byName('unused')).toBeUndefined(); expect(byName('unused-fill')).toBeUndefined();
    expect(result.warnings).toContain('Nested SVG/symbol overflow clipping is not represented; transformed content remains editable outside its viewport.');

    const referenceSource = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><svg x="20" y="10" width="120" height="100" viewBox="0 0 10 20"><rect width="10" height="10" fill="#ff0000"/><rect y="10" width="10" height="10" fill="#0000ff"/></svg><svg x="144" y="10" width="80" height="100" viewBox="0 0 20 10" preserveAspectRatio="none"><rect width="10" height="10" fill="#00ff00"/><rect x="10" width="10" height="10" fill="#ffff00"/></svg></svg>';
    const imported = await renderIllustration(result.document); const referenceImage = await loadImage(Buffer.from(referenceSource)); const reference = createCanvas(240, 120); reference.getContext('2d').drawImage(referenceImage, 0, 0);
    const importedPixels = Buffer.from(imported.getContext('2d').getImageData(0, 0, imported.width, imported.height).data);
    const referencePixels = Buffer.from(reference.getContext('2d').getImageData(0, 0, reference.width, reference.height).data);
    let totalDelta = 0; let changed = 0;
    for (let index = 0; index < importedPixels.length; index += 1) { const delta = Math.abs(importedPixels[index] - referencePixels[index]); totalDelta += delta; if (delta > 32) changed += 1; }
    expect({ mean: totalDelta / importedPixels.length, changed: changed / importedPixels.length }).toEqual({ mean: 0, changed: 0 });
    imported.width = 1; imported.height = 1; reference.width = 1; reference.height = 1;

    const invalid = importEditableSvg(source.replace('width="80px" height="100" viewBox', 'width="0" height="100" viewBox'), 'Invalid nested viewport');
    expect(invalid.warnings).toContain('A nested SVG with invalid or zero viewport dimensions was omitted.');
    expect(Object.values(invalid.document.objects).some((object) => object.name === 'nested')).toBe(false);
    const invalidTransform = importEditableSvg(source.replace('viewBox="0 0 20 10"', 'viewBox="0 0 5e-324 10"'), 'Invalid nested transform');
    expect(invalidTransform.warnings).toContain('A nested SVG with an invalid viewport transform was omitted.');
    expect(Object.values(invalidTransform.document.objects).some((object) => object.name === 'nested-left')).toBe(false);
    const invalidSymbol = importEditableSvg(source.replace('width="50%" height="100px"', 'width="0" height="100px"'), 'Invalid symbol viewport');
    expect(invalidSymbol.warnings).toContain('An SVG <use> symbol with invalid or zero viewport dimensions was omitted.');
    expect(Object.values(invalidSymbol.document.objects).some((object) => object.name === 'badge-top')).toBe(false);
  });

  it('rejects SVG transform arithmetic that cannot produce finite canonical geometry', async () => {
    const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">${body}</svg>`;
    const invalid = [
      ['non-finite token', svg('<rect width="4" height="4" transform="scale(1e309)"/>')],
      ['transform-list overflow', svg('<g transform="scale(1e308) scale(1e308)"><image href="data:image/png;base64,AA=="/></g>')],
      ['nested visual overflow', svg('<g transform="scale(1e308)"><rect width="4" height="4" transform="scale(2)"/></g>')],
      ['decomposition overflow', svg('<rect width="4" height="4" transform="matrix(1.7976931348623157e308 1.7976931348623157e308 0 1 0 0)"/>')],
      ['referenced-symbol overflow', svg('<defs><symbol id="unsafe" transform="scale(1e309)"><image href="data:image/png;base64,AA=="/></symbol></defs><use href="#unsafe" width="4" height="4"/>')],
      ['positioned nested overflow', svg('<g transform="scale(1e308)"><svg x="2" width="4" height="4"><image href="data:image/png;base64,AA=="/></svg></g>')],
      ['mask-prefix overflow', svg('<defs><clipPath id="unsafe" transform="scale(1e308) scale(1e308)"><image href="data:image/png;base64,AA=="/></clipPath></defs><rect width="4" height="4" clip-path="url(#unsafe)"/>')],
      ['linear-gradient endpoint overflow', svg('<defs><linearGradient id="unsafe" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0" gradientTransform="scale(1e308)"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#unsafe)"/>')],
      ['radial-gradient endpoint overflow', svg('<defs><radialGradient id="unsafe" gradientUnits="userSpaceOnUse" cx="10" cy="0" r="10" gradientTransform="scale(1e308)"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient></defs><rect width="10" height="10" fill="url(#unsafe)"/>')],
    ] as const;
    for (const [label, source] of invalid) expect(() => importEditableSvg(source, `Invalid transform · ${label}`)).toThrow('SVG transform produces non-finite canonical geometry.');

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-svg-transform-')); const filePath = join(directory, 'invalid.svg');
    try {
      await writeFile(filePath, invalid[1][1], 'utf8');
      await expect(importDocument(filePath)).rejects.toThrow('SVG transform produces non-finite canonical geometry.');
    } finally { await rm(directory, { recursive: true, force: true }); }

    const valid = importEditableSvg(svg('<g id="finite-parent" transform="scale(100)"><rect id="finite-child" width="4" height="4" transform="scale(100)"/></g><rect id="finite-list" width="4" height="4" transform="scale(100) scale(100)"/>'), 'Finite transform');
    for (const name of ['finite-parent', 'finite-child', 'finite-list']) {
      const object = Object.values(valid.document.objects).find((entry) => entry.name === name);
      expect(object).toBeDefined();
      expect(Object.values(object!.transform).every(Number.isFinite)).toBe(true);
    }

    const ignored = importEditableSvg(svg('<title transform="scale(1e309)">Metadata only</title><foreignObject transform="scale(1e309)"/><rect id="safe" width="4" height="4" transform="unknown(1e309)"/>'), 'Ignored transforms');
    expect(Object.values(ignored.document.objects).some((entry) => entry.name === 'safe')).toBe(true);
    expect(ignored.warnings).toContain('Unsupported SVG <foreignObject> content was omitted.');
  });

  it('returns canonical editable SVG colors, names, and reverse-direction line geometry or fails the whole import', async () => {
    const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">${body}</svg>`;
    const longName = 'n'.repeat(201); const longFamily = 'f'.repeat(201);
    const result = importEditableSvg(svg(`
      <defs><linearGradient id="colors"><stop offset="0" stop-color="#abc"/><stop offset="1" stop-color="rgba(10,20,30,.5)"/></linearGradient><linearGradient id="single"><stop offset=".5" stop-color="orange"/></linearGradient></defs>
      <rect id="named" x="0" width="8" height="8" fill="red"/>
      <rect id="short-alpha" x="8" width="8" height="8" fill="#0f08"/>
      <rect id="functional" x="16" width="8" height="8" fill="hsl(240 100% 50%)"/>
      <g color="rebeccapurple"><rect id="current" x="24" width="8" height="8" fill="currentColor"/></g>
      <rect id="transparent" x="32" width="8" height="8" fill="transparent"/>
      <rect id="invalid" x="40" width="8" height="8" fill="not-a-color"/>
      <rect id="gradient" y="8" width="8" height="8" fill="url(#colors)"/>
      <rect id="single-gradient" x="8" y="8" width="8" height="8" fill="url(#single)"/>
      <line id="reverse" x1="20" y1="30" x2="5" y2="12" stroke="rgb(10, 20, 30)"/>
      <rect id="${longName}" y="32" width="2" height="2"/>
      <text id="bounded-font" y="46" font-family="${longFamily}" font-size="12" fill="navy">x</text>
    `), 'Canonical SVG');
    const byName = (name: string) => Object.values(result.document.objects).find((object) => object.name === name);
    const color = (name: string) => { const object = byName(name); return object?.type === 'shape' && object.fill.kind === 'solid' ? object.fill.color : undefined; };
    expect(color('named')).toBe('#ff0000'); expect(color('short-alpha')).toBe('#00ff0088'); expect(color('functional')).toBe('#0000ff');
    expect(color('current')).toBe('#663399'); expect(color('transparent')).toBe('#00000000'); expect(color('invalid')).toBe('#000000');
    const gradient = byName('gradient'); expect(gradient?.type === 'shape' ? gradient.fill : undefined).toMatchObject({ kind: 'linear-gradient', stops: [{ color: '#aabbcc' }, { color: '#0a141e7f' }] });
    const single = byName('single-gradient'); expect(single?.type === 'shape' ? single.fill : undefined).toMatchObject({ kind: 'linear-gradient', stops: [{ offset: 0, color: '#ffa500' }, { offset: 1, color: '#ffa500' }] });
    expect(byName('reverse')).toMatchObject({ type: 'shape', width: 15, height: 18, transform: { x: 20, y: 30, scaleX: 1, scaleY: 1, rotation: 180 } });
    expect(byName(longName.slice(0, 200))?.name).toHaveLength(200); const text = byName('bounded-font'); expect(text?.type === 'text' ? text.ranges[0].fontFamily : undefined).toHaveLength(200);
    expect(result.warnings).toContain('Unsupported SVG color was replaced with canonical black.');
    expect(result.warnings).toContain('SVG names longer than 200 characters were truncated for editable import.');
    expect(result.warnings).toContain('SVG font-family values longer than 200 characters were truncated for editable import.');
    expect(validateDocument(result.document)).toEqual(result.document);

    const invalid = [
      svg('<rect width="4" height="4" transform="scale(10001)"/>'),
      svg('<rect width="1000001" height="4"/>'),
      svg('<line x2="4" y2="4" stroke="#000" stroke-width="10001"/>'),
      svg('<defs><filter id="blur"><feGaussianBlur stdDeviation="4097"/></filter></defs><rect width="4" height="4" filter="url(#blur)"/>'),
      svg(`<defs><linearGradient id="many">${Array.from({ length: 33 }, (_, index) => `<stop offset="${index / 32}" stop-color="#000"/>`).join('')}</linearGradient></defs><rect width="4" height="4" fill="url(#many)"/>`),
      svg('<text y="10" font-size="501">x</text>'),
    ];
    for (const source of invalid) expect(() => importEditableSvg(source, 'Non-canonical SVG')).toThrow("SVG import produced content outside AIDraw's canonical illustration limits.");

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-svg-canonical-')); const filePath = join(directory, 'invalid.svg');
    try {
      await writeFile(filePath, invalid[0], 'utf8');
      await expect(importDocument(filePath)).rejects.toThrow("SVG import produced content outside AIDraw's canonical illustration limits.");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves centered and right-aligned AIDraw text boxes without shifting their transforms', () => {
    const document = createIllustrationDocument('SVG text boxes'); document.artboard = { ...document.artboard, width: 320, height: 180, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const text = (id: string, align: 'center' | 'right', x: number, y: number, width: number, height: number, lineHeight: number): TextObject => ({
      id, revision: 0, name: `${align} label`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id,
      visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'text', text: align === 'center' ? 'Centered' : 'Right', width, height, align, lineHeight,
      ranges: [{ start: 0, end: align === 'center' ? 8 : 5, fontFamily: 'Arial', fontSize: 20, fontWeight: 400, fontStyle: 'normal', color: '#224466', letterSpacing: 0 }],
    });
    const centered = text('centered-text', 'center', 30, 24, 180, 48, 1.4); const right = text('right-text', 'right', 45, 96, 120, 36, 1.1);
    document.objects[centered.id] = centered; document.objects[right.id] = right; vector.objectIds.push(centered.id, right.id);

    const svg = illustrationToSvg(document);
    expect(svg).toContain('x="90" y="20" text-anchor="middle" data-aidraw-text-box="1" data-aidraw-text-width="180" data-aidraw-text-height="48" data-aidraw-line-height="1.4"');
    expect(svg).toContain('x="120" y="20" text-anchor="end" data-aidraw-text-box="1" data-aidraw-text-width="120" data-aidraw-text-height="36" data-aidraw-line-height="1.1"');
    const reopened = importEditableSvg(svg, 'Reopened text boxes').document;
    const reopenedByText = (text: string) => Object.values(reopened.objects).find((object): object is TextObject => object.type === 'text' && object.text === text);
    expect(reopenedByText(centered.text)).toMatchObject({ width: 180, height: 48, align: 'center', lineHeight: 1.4, transform: { x: 30, y: 24 } });
    expect(reopenedByText(right.text)).toMatchObject({ width: 120, height: 36, align: 'right', lineHeight: 1.1, transform: { x: 45, y: 96 } });

    for (const [from, to] of [
      ['data-aidraw-line-height="1.4"', 'data-aidraw-line-height="99"'],
      ['data-aidraw-text-box="1"', 'data-aidraw-text-box="2"'],
      ['data-aidraw-text-width="180"', 'data-aidraw-text-width="true"'],
    ]) {
      const invalid = importEditableSvg(svg.replace(from, to), 'Invalid text metadata');
      expect(invalid.warnings).toContain('Invalid AIDraw SVG text-box metadata was ignored.');
      expect(Object.values(invalid.document.objects).find((object) => object.type === 'text' && object.text === centered.text)).toMatchObject({ lineHeight: 1.2 });
    }
  });

  it('restores an exact AIDraw image crop only when its standard SVG crop still matches', async () => {
    const document = createIllustrationDocument('SVG image crop'); document.artboard = { ...document.artboard, width: 240, height: 160, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const source = createCanvas(8, 6); const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 4, 3); sourceContext.fillStyle = '#00ff00'; sourceContext.fillRect(4, 0, 4, 3);
    sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(0, 3, 4, 3); sourceContext.fillStyle = '#ffff00'; sourceContext.fillRect(4, 3, 4, 3);
    const bytes = source.toBuffer('image/png'); source.width = 1; source.height = 1;
    const asset: DocumentAsset = { id: 'crop-source', name: 'Crop source', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') };
    const timestamp = nowIso(); const image: ImageObject = {
      id: 'cropped-image', revision: 0, name: 'Cropped image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id,
      visible: true, locked: false, opacity: 0.75, blendMode: 'multiply', transform: { ...IDENTITY_TRANSFORM, x: 30, y: 40 }, type: 'image', assetId: asset.id,
      width: 110, height: 85, sourceWidth: 8, sourceHeight: 6, crop: { x: 1.25, y: 0.5, width: 5.5, height: 4.25 }, filters: [],
    };
    document.assets[asset.id] = asset; document.objects[image.id] = image; vector.objectIds.push(image.id);
    const before = structuredClone(document); const svg = illustrationToSvg(document);
    expect(svg).toContain('data-aidraw-image-crop="1" data-aidraw-display-width="110" data-aidraw-display-height="85" data-aidraw-source-width="8" data-aidraw-source-height="6" data-aidraw-crop-x="1.25" data-aidraw-crop-y="0.5" data-aidraw-crop-width="5.5" data-aidraw-crop-height="4.25"');
    expect(svg).toContain('clip-path="url(#crop-cropped-image)" x="-25" y="-10" width="160" height="120" preserveAspectRatio="none"');

    const reopenedResult = importEditableSvg(svg, 'Reopened crop'); const reopened = reopenedResult.document;
    const reopenedImage = Object.values(reopened.objects).find((object): object is ImageObject => object.type === 'image');
    expect(reopenedResult.warnings).toEqual([]);
    expect(reopenedImage).toMatchObject({ width: 110, height: 85, sourceWidth: 8, sourceHeight: 6, crop: { x: 1.25, y: 0.5, width: 5.5, height: 4.25 }, opacity: 0.75, blendMode: 'multiply', transform: { x: 30, y: 40 } });
    expect(reopenedImage?.maskObjectId).toBeUndefined(); expect(document).toEqual(before);
    const originalCanvas = await renderIllustration(document); const reopenedCanvas = await renderIllustration(reopened);
    const originalPixels = Buffer.from(originalCanvas.getContext('2d').getImageData(0, 0, originalCanvas.width, originalCanvas.height).data);
    const reopenedPixels = Buffer.from(reopenedCanvas.getContext('2d').getImageData(0, 0, reopenedCanvas.width, reopenedCanvas.height).data);
    originalCanvas.width = 1; originalCanvas.height = 1; reopenedCanvas.width = 1; reopenedCanvas.height = 1;
    expect(reopenedPixels).toEqual(originalPixels);

    for (const [from, to, warning] of [
      ['data-aidraw-image-crop="1"', 'data-aidraw-image-crop="2"', 'Invalid AIDraw SVG image-crop metadata was ignored.'],
      ['data-aidraw-crop-width="5.5"', 'data-aidraw-crop-width="9"', 'Invalid AIDraw SVG image-crop metadata was ignored.'],
      ['x="-25" y="-10"', 'x="-24" y="-10"', 'AIDraw SVG image-crop metadata did not match its standard SVG crop and was ignored.'],
    ]) {
      const invalid = importEditableSvg(svg.replace(from, to), 'Invalid crop metadata');
      expect(invalid.warnings).toContain(warning);
      const genericImage = Object.values(invalid.document.objects).find((object): object is ImageObject => object.type === 'image');
      expect(genericImage?.crop).toBeUndefined(); expect(genericImage?.maskObjectId).toBeTruthy();
    }
  });
});
