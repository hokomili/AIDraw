import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';
import { inspectPackagedSecurity } from './packaged-security.mjs';
import { assertPackagedUtilityContainmentSources, findPackagedUtilityWorkerBundle } from './packaged-utility-containment.mjs';
import { assertPackagedUtilityPressureSources } from './packaged-utility-pressure.mjs';
import { assertPackagedGenerationNormalizationSources } from './packaged-generation-normalization.mjs';
import { assertPackagedUtilityObservationCodecSources } from './packaged-utility-observation-codec.mjs';
import { assertPackagedUtilityQuantizationResultSources } from './packaged-utility-quantization-result.mjs';
import { assertPackagedUtilityExportResultSources } from './packaged-utility-export-result.mjs';
import { assertPackagedUtilityImportResultSources } from './packaged-utility-import-result.mjs';
import { assertPackagedUtilityGenerationResultSources } from './packaged-utility-generation-result.mjs';

const outDir = resolve(process.env.AIDRAW_FORGE_OUT_DIR || 'out');
const platform = process.env.AIDRAW_PACKAGE_PLATFORM || process.platform;
const architecture = process.env.AIDRAW_PACKAGE_ARCH || process.arch;
const packageDir = join(outDir, `AIDraw-${platform}-${architecture}`);
const executableCandidates = platform === 'win32'
  ? [join(packageDir, 'AIDraw.exe')]
  : platform === 'darwin'
    ? [join(packageDir, 'AIDraw.app', 'Contents', 'MacOS', 'AIDraw')]
    : [join(packageDir, 'AIDraw'), join(packageDir, 'aidraw')];
const archive = platform === 'darwin'
  ? join(packageDir, 'AIDraw.app', 'Contents', 'Resources', 'app.asar')
  : join(packageDir, 'resources', 'app.asar');

try {
  let executable;
  for (const candidate of executableCandidates) {
    if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; }
  }
  if (!executable) throw new Error(`Packaged executable is missing (${executableCandidates.join(', ')}).`);
  await access(executable);
  await access(archive);
  const executableBytes = await readFile(executable);
  const archiveBytes = await readFile(archive);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  if (executableInfo.size < 1_000_000 || archiveInfo.size < 1_000) throw new Error('Packaged files are unexpectedly small.');
  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  if (!archiveFiles.includes('/.vite/build/utility-worker.js')) throw new Error('Packaged raster utility worker is missing.');
  const utilityWorkerBundle = findPackagedUtilityWorkerBundle(archiveFiles);
  const utilityWorkerPath = utilityWorkerBundle.slice(1).split('/').join(sep);
  const utilityWorkerSource = extractFile(archive, utilityWorkerPath).toString('utf8');
  const importerBundles = archiveFiles.filter((entry) => /^\/\.vite\/build\/import-document-[^/]+\.js$/.test(entry));
  if (importerBundles.length !== 1) throw new Error(`Packaged raster utility importer count is ${importerBundles.length}; expected exactly one.`);
  const importerPath = importerBundles[0].slice(1).split('/').join(sep);
  const importerSource = extractFile(archive, importerPath).toString('utf8');
  if (/\bnativeImage\b/.test(importerSource)) throw new Error('Packaged raster utility importer must not depend on Electron nativeImage, which is unavailable in utilityProcess.');
  if (!archiveFiles.includes('/.vite/build/main.js')) throw new Error('Packaged main process bundle is missing.');
  const mainSource = extractFile(archive, join('.vite', 'build', 'main.js')).toString('utf8');
  const mcpDiscoveryMarkers = ['aidraw_help', 'aidraw://guide', 'AIDraw agent protocol guide'];
  const missingMcpDiscoveryMarkers = mcpDiscoveryMarkers.filter((marker) => !mainSource.includes(marker));
  if (missingMcpDiscoveryMarkers.length) throw new Error(`Packaged main process is missing current MCP discovery markers: ${missingMcpDiscoveryMarkers.join(', ')}.`);
  if (!archiveFiles.includes('/.vite/build/preload.js')) throw new Error('Packaged preload bundle is missing.');
  const preloadSource = extractFile(archive, join('.vite', 'build', 'preload.js')).toString('utf8');
  const rendererBundles = archiveFiles.filter((entry) => /^\/\.vite\/renderer\/main_window\/assets\/[^/]+\.js$/.test(entry));
  if (!rendererBundles.length) throw new Error('Packaged renderer implementation bundle is missing.');
  const rendererSource = rendererBundles
    .map((entry) => extractFile(archive, entry.slice(1).split('/').join(sep)).toString('utf8'))
    .join('\n');
  const packagedUtilityContainment = assertPackagedUtilityContainmentSources({ mainSource, workerSource: utilityWorkerSource });
  const packagedUtilityPressure = assertPackagedUtilityPressureSources({ mainSource, workerSource: utilityWorkerSource });
  const buildSource = archiveFiles
    .filter((entry) => /^\/\.vite\/build\/[^/]+\.js$/.test(entry))
    .map((entry) => extractFile(archive, entry.slice(1).split('/').join(sep)).toString('utf8'))
    .join('\n');
  const packagedGenerationNormalization = assertPackagedGenerationNormalizationSources({ mainSource, workerSource: utilityWorkerSource, buildSource });
  const packagedUtilityObservationCodec = assertPackagedUtilityObservationCodecSources({
    mainSource,
    workerSource: utilityWorkerSource,
    preloadSource,
    rendererSource,
  });
  const packagedUtilityQuantizationResult = assertPackagedUtilityQuantizationResultSources({
    mainSource,
    workerSource: utilityWorkerSource,
    preloadSource,
    rendererSource,
  });
  const packagedUtilityExportResult = assertPackagedUtilityExportResultSources({
    mainSource,
    workerSource: utilityWorkerSource,
    preloadSource,
    rendererSource,
  });
  const packagedUtilityImportResult = assertPackagedUtilityImportResultSources({
    mainSource,
    workerSource: utilityWorkerSource,
    preloadSource,
    rendererSource,
  });
  const packagedUtilityGenerationResult = assertPackagedUtilityGenerationResultSources({
    mainSource,
    workerSource: utilityWorkerSource,
    preloadSource,
    rendererSource,
  });
  const packagedSecurity = await inspectPackagedSecurity({ executable, archive });
  process.stdout.write(`${JSON.stringify({
    verified: true,
    node: process.version,
    platform,
    architecture,
    packageDir,
    executable,
    executableBytes: executableInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
    appAsarSha256: createHash('sha256').update(archiveBytes).digest('hex').toUpperCase(),
    rasterUtilityWorker: true,
    rasterUtilityImporterNativeImageFree: true,
    mcpSelfDocumentation: true,
    packagedUtilityContainment,
    packagedUtilityPressure,
    packagedGenerationNormalization,
    packagedUtilityObservationCodec,
    packagedUtilityQuantizationResult,
    packagedUtilityExportResult,
    packagedUtilityImportResult,
    packagedUtilityGenerationResult,
    packagedSecurity,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIDraw package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
