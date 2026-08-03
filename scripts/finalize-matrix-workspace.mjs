import { Buffer } from 'node:buffer';
import { readFile, readdir, mkdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const APPLY = process.argv.includes('--apply');
const VERIFY_EXISTING = process.argv.includes('--verify-existing');
const TARGET_DIR = process.env.AIDRAW_MATRIX_DIR ?? 'C:\\Users\\hokom\\Desktop\\AI Generated';
const CODEX_CONFIG = process.env.CODEX_CONFIG_PATH ?? 'C:\\Users\\hokom\\.codex\\config.toml';
const APP_VERSION = '1.0.0';
const TRANSPARENT_PREVIEW = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+Q5ZkAAAAAElFTkSuQmCC',
  'base64',
));

const definitions = [
  ['01', 'Bubble Axolotl', '5.6-sol low'],
  ['02', 'Clockwork Beetle', '5.6-sol medium'],
  ['03', 'Ember Fox', '5.6-sol high'],
  ['04', 'Moon Owl', '5.6-sol xhigh'],
  ['05', 'Crystal Dragon Whelp', '5.6-sol max'],
  ['06', 'Cosmic Manta', '5.6-sol ultra'],
  ['07', 'Moss Turtle', '5.6-terra low'],
  ['08', 'Lantern Frog', '5.6-terra medium'],
  ['09', 'Thunder Ram', '5.6-terra high'],
  ['10', 'Coral Seahorse', '5.6-terra xhigh'],
  ['11', 'Forest Stag', '5.6-terra max'],
  ['12', 'Aurora Whale', '5.6-terra ultra'],
  ['13', 'Jelly Slime', '5.6-luna low'],
  ['14', 'Star Bunny', '5.6-luna medium'],
  ['15', 'Shadow Bat', '5.6-luna high'],
  ['16', 'Cloud Alpaca', '5.6-luna xhigh'],
  ['17', 'Lunar Kirin', '5.6-luna max'],
  ['18', 'Pocket Penguin', '5.5 low'],
  ['19', 'Neon Gecko', '5.5 medium'],
  ['20', 'Phoenix Chick', '5.5 high'],
  ['21', 'Deep-Sea Angler', '5.5 xhigh'],
  ['22', 'Acorn Mouse', '5.4 low'],
  ['23', 'Honey Bee', '5.4 medium'],
  ['24', 'Marsh Crocodile', '5.4 high'],
  ['25', 'Rune Golem', '5.4 xhigh'],
  ['26', 'Sprout Snail', '5.4-mini low'],
  ['27', 'Candy Crab', '5.4-mini medium'],
  ['28', 'Snow Ferret', '5.4-mini high'],
  ['29', 'Tiny Triceratops', '5.4-mini xhigh'],
  ['30', 'Toast Capybara', '5.3-codex-spark low'],
  ['31', 'Electric Eel', '5.3-codex-spark medium'],
  ['32', 'Comet Hamster', '5.3-codex-spark high'],
  ['33', 'Prism Chameleon', '5.3-codex-spark xhigh'],
].map(([number, creature, setting]) => ({
  number,
  creature,
  setting,
  name: `Matrix ${number} · ${creature} · ${setting}`,
  fileName: `Matrix ${number} · ${creature} · ${setting}.aidraw`,
}));

const openSources = new Map(Object.entries({
  '05': 'doc_505d0e62-',
  '12': 'doc_05188cc1-',
  '16': 'doc_51132f9e-',
  '17': 'doc_23636078-',
  '18': 'doc_4ac5439b-',
  '23': 'doc_022a0665-',
  '24': 'doc_2af83700-',
  '25': 'doc_5ca9aa81-',
  '27': 'doc_57f05913-',
  '28': 'doc_3ee57114-',
  '29': 'doc_12ef7b85-',
  '30': 'doc_45b60be9-',
}));

const diskSources = new Map(Object.entries({
  '01': 'Matrix 01 · Bubble Axolotl · 5.6-sol low.aidraw',
  '02': 'Matrix 02 · Clockwork Beetle · 5.6-sol medium.aidraw',
  '03': 'Matrix 03 · Ember Fox · 5.6-sol high.aidraw',
  '04': 'Matrix 04 · Moon Owl · 5.6-sol xhigh.aidraw',
  '06': 'Matrix 06 · Cosmic Manta · 5.6-sol ultra.aidraw',
  '07': 'Matrix 07 · Moss Turtle · 5.6-terra low.aidraw',
  '08': 'Matrix 08 · Lantern Frog · 5.6-terra medium.aidraw',
  '09': 'Matrix 09 · Thunder Ram · 5.6-terra high.aidraw',
  '10': 'Matrix 10 · Coral Seahorse · 5.6-terra xhigh.aidraw',
  '11': 'Matrix 11 · Forest Stag · 5.6-terra max.aidraw',
  '13': 'Matrix 13 · Jelly Slime · 5.6-luna low.aidraw',
  '14': 'Matrix 14 · Star Bunny · 5.6-luna medium.aidraw',
  '15': 'Matrix 15 · Shadow Bat · 5.6-luna high.aidraw',
  '19': 'Recovery 19 · Neon Gecko · gpt-5.5 medium.aidraw',
  '20': 'Matrix 20 · Phoenix Chick · 5.5 high.aidraw',
  '21': 'Recovery 21 · Deep-Sea Angler · gpt-5.5 xhigh.aidraw',
  '22': 'Matrix 22 · Acorn Mouse · 5.4 low.aidraw',
  '26': 'Recovery 26 · Sprout Snail · gpt-5.4-mini low.aidraw',
  '31': 'Matrix 31 · Electric Eel · 5.3-codex-spark medium · retry.aidraw',
  '32': 'Matrix 32 · Comet Hamster · 5.3-codex-spark high · retry.aidraw',
  '33': 'Matrix 33 · Prism Chameleon · 5.3-codex-spark xhigh · retry.aidraw',
}));

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`Unrecognized MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1));
}

async function connectMcp() {
  const config = await readFile(CODEX_CONFIG, 'utf8');
  const section = config.match(/\[mcp_servers\.aidraw\]([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  const url = section?.match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1];
  const token = section?.match(/Authorization\s*=\s*"Bearer\s+([^"]+)"/i)?.[1];
  if (!url || !token) throw new Error('Codex does not contain a usable [mcp_servers.aidraw] URL and bearer token.');
  const baseHeaders = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  let rpcId = 0;
  async function rpc(headers, method, params = {}) {
    const response = await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const body = parseRpcPayload(await response.text());
    if (!response.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? body)}`);
    return { response, body };
  }
  const initialized = await rpc(baseHeaders, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'AIDraw final-results consolidator', version: APP_VERSION } });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('The live AIDraw engine did not return an MCP session ID.');
  const headers = { ...baseHeaders, 'mcp-session-id': sessionId };
  await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return {
    async tool(name, args) {
      const { body } = await rpc(headers, 'tools/call', { name, arguments: args });
      if (body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body.result)}`);
      const value = body.result?.content?.find((entry) => entry.type === 'text')?.text;
      if (!value) throw new Error(`${name} returned no JSON content.`);
      const parsed = JSON.parse(value);
      if (parsed?.error) throw new Error(`${name}: ${parsed.error}`);
      return parsed;
    },
    async resource(uri) {
      const { body } = await rpc(headers, 'resources/read', { uri });
      return body.result?.contents?.[0]?.text ?? '';
    },
  };
}

function resolvedChunks(cel, cels, visited = new Set()) {
  if (!cel || visited.has(cel.id)) return {};
  visited.add(cel.id);
  if (cel.linkedToCelId) return resolvedChunks(cels[cel.linkedToCelId], cels, visited);
  return cel.chunks ?? {};
}

function animationMetrics(document) {
  if (document.kind !== 'pixel') throw new Error(`${document.name} is not a pixel document.`);
  const sprite = document.pixelAssets?.[document.activeAssetId];
  if (!sprite || sprite.type !== 'sprite') throw new Error(`${document.name} does not have an active sprite.`);
  const framePixelCounts = sprite.frameIds.map((frameId) => {
    let count = 0;
    for (const cel of Object.values(sprite.cels ?? {}).filter((entry) => entry.frameId === frameId)) {
      for (const chunk of Object.values(resolvedChunks(cel, sprite.cels ?? {}))) {
        for (const index of Buffer.from(chunk.data ?? '', 'base64')) if (index !== 0) count += 1;
      }
    }
    return count;
  });
  return {
    width: sprite.width,
    height: sprite.height,
    frameCount: sprite.frameIds.length,
    populatedFrameCount: framePixelCounts.filter((count) => count > 0).length,
    framePixelCounts,
    totalIndexedPixels: framePixelCounts.reduce((sum, count) => sum + count, 0),
    tagCount: Array.isArray(sprite.tags) ? sprite.tags.length : 0,
    paletteEntries: Array.isArray(document.palette) ? document.palette.length : 0,
  };
}

function assertComplete(definition, document) {
  const metrics = animationMetrics(document);
  if (metrics.frameCount < 4) throw new Error(`${definition.name} has only ${metrics.frameCount} frames.`);
  if (metrics.populatedFrameCount !== metrics.frameCount) throw new Error(`${definition.name} has ${metrics.frameCount - metrics.populatedFrameCount} empty frame(s).`);
  if (metrics.tagCount < 1) throw new Error(`${definition.name} has no animation tag.`);
  if (metrics.paletteEntries < 2) throw new Error(`${definition.name} has no usable indexed palette.`);
  return metrics;
}

function canonicalize(document, definition) {
  const result = globalThis.structuredClone(document);
  result.name = definition.name;
  result.dirty = false;
  delete result.filePath;
  return result;
}

function archiveFromDocument(document, definition, sourceFiles = {}, preview, traceText = '') {
  const persisted = canonicalize(document, definition);
  const files = { ...sourceFiles };
  const assets = {};
  for (const asset of Object.values(persisted.assets ?? {})) {
    const metadata = globalThis.structuredClone(asset);
    if (metadata.data) {
      files[`assets/${metadata.sha256}`] = Uint8Array.from(Buffer.from(metadata.data, 'base64'));
      delete metadata.data;
    }
    assets[metadata.id] = metadata;
  }
  persisted.assets = assets;
  const manifest = {
    format: 'AIDraw',
    schemaVersion: 1,
    documentId: persisted.id,
    documentKind: persisted.kind,
    name: persisted.name,
    revision: persisted.revision,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    assetCount: Object.keys(persisted.assets).length,
    savedBy: { application: 'AIDraw', version: APP_VERSION },
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['document.json'] = strToU8(JSON.stringify(persisted));
  files['activity.json'] = strToU8(JSON.stringify(persisted.activity ?? []));
  files['trace/transactions.jsonl'] = strToU8(traceText ? `${traceText.trimEnd()}\n` : '');
  files['preview.png'] = preview ?? files['preview.png'] ?? TRANSPARENT_PREVIEW;
  return { bytes: zipSync(files, { level: 6 }), document: persisted };
}

function inspectArchive(bytes, definition) {
  const files = unzipSync(bytes);
  for (const required of ['manifest.json', 'document.json', 'activity.json', 'trace/transactions.jsonl', 'preview.png']) {
    if (!files[required]) throw new Error(`${definition.name} is missing ${required}.`);
  }
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const document = JSON.parse(strFromU8(files['document.json']));
  if (manifest.format !== 'AIDraw' || manifest.schemaVersion !== 1) throw new Error(`${definition.name} has an invalid native manifest.`);
  if (manifest.name !== definition.name || document.name !== definition.name) throw new Error(`${definition.name} was not canonicalized.`);
  return { document, metrics: assertComplete(definition, document) };
}

async function loadDiskSource(definition, fileName) {
  const sourcePath = join(TARGET_DIR, fileName);
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  const sourceFiles = unzipSync(sourceBytes);
  if (!sourceFiles['document.json']) throw new Error(`${sourcePath} is not a native AIDraw file.`);
  const document = JSON.parse(strFromU8(sourceFiles['document.json']));
  const traceText = sourceFiles['trace/transactions.jsonl'] ? strFromU8(sourceFiles['trace/transactions.jsonl']) : '';
  const output = archiveFromDocument(document, definition, sourceFiles, sourceFiles['preview.png'], traceText);
  return { ...output, source: { kind: 'saved-file', path: sourcePath } };
}

async function loadOpenSource(mcp, definition, documentId) {
  const observed = await mcp.tool('canvas_observe', { documentId, includePng: true });
  if (!observed.document) throw new Error(`${definition.name}: live document ${documentId} is unavailable.`);
  const traceText = await mcp.resource(`aidraw://documents/${documentId}/trace`);
  const preview = observed.png?.data ? Uint8Array.from(Buffer.from(observed.png.data, 'base64')) : TRANSPARENT_PREVIEW;
  const output = archiveFromDocument(observed.document, definition, {}, preview, traceText);
  return { ...output, source: { kind: 'live-engine', documentId, originalName: observed.document.name } };
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function commit(finals, report) {
  const target = resolve(TARGET_DIR);
  const stamp = timestampForPath();
  const archiveDir = join(target, `AIDraw duplicate archive ${stamp}`);
  const stagingDir = join(target, `.aidraw-finalize-staging-${stamp}`);
  await mkdir(archiveDir, { recursive: false });
  await mkdir(stagingDir, { recursive: false });

  for (const final of finals) {
    const stagedPath = join(stagingDir, final.definition.fileName);
    await writeFile(stagedPath, final.bytes, { flag: 'wx' });
    inspectArchive(new Uint8Array(await readFile(stagedPath)), final.definition);
  }

  const existing = (await readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(Matrix|Recovery) .+\.aidraw$/i.test(entry.name))
    .map((entry) => entry.name);
  const archived = [];
  const placed = [];
  try {
    for (const fileName of existing) {
      await rename(join(target, fileName), join(archiveDir, fileName));
      archived.push(fileName);
    }
    for (const final of finals) {
      await rename(join(stagingDir, final.definition.fileName), join(target, final.definition.fileName));
      placed.push(final.definition.fileName);
    }
    await rmdir(stagingDir);
  } catch (error) {
    for (const fileName of placed.reverse()) {
      await rename(join(target, fileName), join(stagingDir, fileName)).catch(() => undefined);
    }
    for (const fileName of archived.reverse()) {
      await rename(join(archiveDir, fileName), join(target, fileName)).catch(() => undefined);
    }
    throw error;
  }

  const committedReport = {
    ...report,
    applied: true,
    archiveDir,
    archivedFiles: archived,
    canonicalFiles: placed,
  };
  await writeFile(join(archiveDir, 'cleanup-report.json'), `${JSON.stringify(committedReport, null, 2)}\n`, 'utf8');
  return committedReport;
}

async function main() {
  for (const definition of definitions) {
    if (!openSources.has(definition.number) && !diskSources.has(definition.number)) throw new Error(`No selected source for ${definition.name}.`);
  }
  if (VERIFY_EXISTING) {
    const entries = (await readdir(TARGET_DIR, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const matrixFiles = entries.filter((name) => /^Matrix .+\.aidraw$/i.test(name)).sort();
    const strayFiles = entries.filter((name) => /^(Recovery .+|Matrix .+(retry|recovered|compact)).*\.aidraw$/i.test(name)).sort();
    const expected = definitions.map((definition) => definition.fileName).sort();
    if (JSON.stringify(matrixFiles) !== JSON.stringify(expected)) throw new Error(`Canonical filename set differs from the expected 33 files. Found ${matrixFiles.length}.`);
    if (strayFiles.length) throw new Error(`Retry/recovery files remain at the top level: ${strayFiles.join(', ')}`);
    const results = [];
    for (const definition of definitions) {
      const bytes = new Uint8Array(await readFile(join(TARGET_DIR, definition.fileName)));
      results.push({ number: definition.number, name: definition.name, metrics: inspectArchive(bytes, definition).metrics });
    }
    process.stdout.write(`${JSON.stringify({ verified: true, canonicalFileCount: matrixFiles.length, strayFileCount: strayFiles.length, results }, null, 2)}\n`);
    return;
  }
  const mcp = await connectMcp();
  const workspace = await mcp.tool('document_manage', { action: 'list' });
  const finals = [];
  for (const definition of definitions) {
    const documentIdPrefix = openSources.get(definition.number);
    const documentId = documentIdPrefix
      ? workspace.documents?.find((document) => document.id.startsWith(documentIdPrefix))?.id
      : undefined;
    if (documentIdPrefix && !documentId) throw new Error(`${definition.name}: no live document matches ${documentIdPrefix}.`);
    const output = documentId
      ? await loadOpenSource(mcp, definition, documentId)
      : await loadDiskSource(definition, diskSources.get(definition.number));
    const verified = inspectArchive(output.bytes, definition);
    finals.push({ definition, ...output, metrics: verified.metrics });
  }

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    applied: false,
    targetDir: resolve(TARGET_DIR),
    finalCount: finals.length,
    validation: 'Every result has at least four frames, every frame contains indexed pixels, and every sprite has an animation tag.',
    results: finals.map(({ definition, source, metrics }) => ({ number: definition.number, name: definition.name, fileName: definition.fileName, source, metrics })),
  };
  if (finals.length !== 33) throw new Error(`Expected 33 canonical results, prepared ${finals.length}.`);
  const output = APPLY ? await commit(finals, report) : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

await main();
