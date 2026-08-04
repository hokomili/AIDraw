import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { createCanvas } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import gifuct from 'gifuct-js';
import { strFromU8, unzipSync } from 'fflate';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { parseGIF, decompressFrames } = gifuct;
const APPLY = process.argv.includes('--apply');
const INPUT_DIR = resolve(process.env.AIDRAW_MATRIX_DIR ?? 'C:\\Users\\hokom\\Desktop\\AI Generated');
const OUTPUT_DIR = resolve(process.env.AIDRAW_GIF_DIR ?? join(INPUT_DIR, 'GIF exports'));

function celChunks(cel, cels, visited = new Set()) {
  if (!cel || visited.has(cel.id)) return {};
  visited.add(cel.id);
  return cel.linkedToCelId ? celChunks(cels[cel.linkedToCelId], cels, visited) : (cel.chunks ?? {});
}

function renderFrame(document, sprite, frameId) {
  const canvas = createCanvas(sprite.width, sprite.height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  const visibleLayers = [];
  const visit = (layerId, opacity = 1, visited = new Set()) => {
    if (visited.has(layerId)) return;
    visited.add(layerId);
    const layer = sprite.layers[layerId];
    if (!layer?.visible) return;
    const combinedOpacity = opacity * layer.opacity;
    if (layer.type === 'group') {
      for (const childId of layer.childIds ?? []) visit(childId, combinedOpacity, visited);
    } else {
      visibleLayers.push({ layer, opacity: combinedOpacity });
    }
  };
  for (const layerId of sprite.layerIds) visit(layerId);

  for (const { layer, opacity } of visibleLayers) {
    if (layer.type !== 'pixel') continue;
    const directCel = Object.values(sprite.cels).find((cel) => cel.layerId === layer.id && cel.frameId === frameId);
    if (!directCel) continue;
    context.globalAlpha = opacity;
    context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
    const palette = sprite.paletteOverrides?.[frameId] ?? document.palette;
    for (const chunk of Object.values(celChunks(directCel, sprite.cels))) {
      const values = Buffer.from(chunk.data ?? '', 'base64');
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const documentX = chunk.x + x;
          const documentY = chunk.y + y;
          if (documentX < 0 || documentY < 0 || documentX >= sprite.width || documentY >= sprite.height) continue;
          const paletteIndex = values[y * 32 + x] ?? 0;
          if (paletteIndex === 0) continue;
          context.fillStyle = palette[paletteIndex]?.color ?? '#ff00ff';
          context.fillRect(documentX, documentY, 1, 1);
        }
      }
    }
  }
  return context.getImageData(0, 0, sprite.width, sprite.height).data;
}

function encodeGif(document, sprite) {
  const encoder = GIFEncoder();
  const delays = [];
  for (const [index, frameId] of sprite.frameIds.entries()) {
    const rgba = renderFrame(document, sprite, frameId);
    const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true });
    const indexed = applyPalette(rgba, palette, 'rgba4444');
    const delay = sprite.frames[frameId]?.durationMs ?? 100;
    delays.push(delay);
    encoder.writeFrame(indexed, sprite.width, sprite.height, {
      palette,
      transparent: true,
      transparentIndex: 0,
      delay,
      repeat: 0,
    });
    if (index === 0 && palette.length < 2) throw new Error(`${document.name}: first frame produced an unusable GIF palette.`);
  }
  encoder.finish();
  return { bytes: Buffer.from(encoder.bytes()), delays };
}

function validateGif(bytes, expected) {
  if (bytes.subarray(0, 6).toString('ascii') !== 'GIF89a') throw new Error(`${expected.name}: missing GIF89a header.`);
  if (bytes.at(-1) !== 0x3b) throw new Error(`${expected.name}: missing GIF trailer.`);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = parseGIF(arrayBuffer);
  const frames = decompressFrames(parsed, true);
  if (parsed.lsd.width !== expected.width || parsed.lsd.height !== expected.height) {
    throw new Error(`${expected.name}: decoded dimensions are ${parsed.lsd.width}x${parsed.lsd.height}, expected ${expected.width}x${expected.height}.`);
  }
  if (frames.length !== expected.frameCount) throw new Error(`${expected.name}: decoded ${frames.length} frames, expected ${expected.frameCount}.`);
  const expectedDelays = expected.delays.map((delay) => Math.round(delay / 10) * 10);
  const decodedDelays = frames.map((frame) => frame.delay);
  if (JSON.stringify(decodedDelays) !== JSON.stringify(expectedDelays)) {
    throw new Error(`${expected.name}: decoded delays ${decodedDelays.join(',')} differ from ${expectedDelays.join(',')}.`);
  }
  const emptyFrames = frames.filter((frame) => {
    for (let index = 3; index < frame.patch.length; index += 4) if (frame.patch[index] > 0) return false;
    return true;
  });
  if (emptyFrames.length) throw new Error(`${expected.name}: ${emptyFrames.length} decoded GIF frame(s) are empty.`);
  return { width: parsed.lsd.width, height: parsed.lsd.height, frameCount: frames.length, delaysMs: decodedDelays, byteLength: bytes.byteLength };
}

async function prepare(fileName) {
  const sourcePath = join(INPUT_DIR, fileName);
  const archive = unzipSync(new Uint8Array(await readFile(sourcePath)));
  if (!archive['document.json']) throw new Error(`${fileName} is not a native AIDraw file.`);
  const document = JSON.parse(strFromU8(archive['document.json']));
  if (document.kind !== 'pixel') throw new Error(`${fileName} is not a pixel document.`);
  const sprite = document.pixelAssets?.[document.activeAssetId];
  if (!sprite || sprite.type !== 'sprite') throw new Error(`${fileName} does not have an active sprite.`);
  if (sprite.frameIds.length < 2) throw new Error(`${fileName} is not animated.`);
  const encoded = encodeGif(document, sprite);
  const outputName = `${basename(fileName, '.aidraw')}.gif`;
  const expected = { name: document.name, width: sprite.width, height: sprite.height, frameCount: sprite.frameIds.length, delays: encoded.delays };
  return { sourcePath, outputName, bytes: encoded.bytes, validation: validateGif(encoded.bytes, expected) };
}

async function main() {
  const sourceFiles = (await readdir(INPUT_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^Matrix \d{2} .+\.aidraw$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (sourceFiles.length !== 33) throw new Error(`Expected 33 canonical Matrix files, found ${sourceFiles.length}.`);
  if (sourceFiles.some((name) => /retry|recovery|recovered|compact/i.test(name))) throw new Error('The canonical source set still contains a retry/recovery filename.');

  const prepared = [];
  for (const fileName of sourceFiles) prepared.push(await prepare(fileName));
  const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    sourceDir: INPUT_DIR,
    outputDir: OUTPUT_DIR,
    applied: APPLY,
    exportCount: prepared.length,
    exports: prepared.map(({ sourcePath, outputName, validation }) => ({ sourcePath, outputName, ...validation })),
  };
  if (!APPLY) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: false });
  for (const result of prepared) {
    const destination = join(OUTPUT_DIR, result.outputName);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, result.bytes, { flag: 'wx' });
    validateGif(await readFile(temporary), {
      name: result.outputName,
      width: result.validation.width,
      height: result.validation.height,
      frameCount: result.validation.frameCount,
      delays: result.validation.delaysMs,
    });
    await rename(temporary, destination);
  }
  await writeFile(join(OUTPUT_DIR, 'export-report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
