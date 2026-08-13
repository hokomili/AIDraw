import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
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
import { inspectPackagedFontLicense } from './packaged-font-license.mjs';
import { assertPackagedElectronVersion, inspectDependencySecurityPolicy } from './dependency-security.mjs';

const execute = promisify(execFile);

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
const runtime = platform === 'darwin'
  ? join(packageDir, 'AIDraw.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
  : undefined;
const appBundle = platform === 'darwin' ? join(packageDir, 'AIDraw.app') : undefined;

try {
  let executable;
  for (const candidate of executableCandidates) {
    if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; }
  }
  if (!executable) throw new Error(`Packaged executable is missing (${executableCandidates.join(', ')}).`);
  await access(executable);
  await access(archive);
  if (runtime) await access(runtime);
  const executableBytes = await readFile(executable);
  const archiveBytes = await readFile(archive);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  const runtimeInfo = runtime ? await stat(runtime) : executableInfo;
  const minimumExecutableBytes = platform === 'darwin' ? 10_000 : 1_000_000;
  if (executableInfo.size < minimumExecutableBytes || runtimeInfo.size < 1_000_000 || archiveInfo.size < 1_000) throw new Error('Packaged files are unexpectedly small.');
  let macosCodeSignature;
  if (appBundle) {
    if (process.platform !== 'darwin') throw new Error('Darwin bundle integrity verification requires a native macOS host.');
    await execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const signatureDetails = await execute('codesign', ['-dv', '--verbose=4', appBundle], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const details = `${signatureDetails.stdout}\n${signatureDetails.stderr}`;
    const requirementDetails = await execute('codesign', ['-d', '-r-', appBundle], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const designatedRequirement = `${requirementDetails.stdout}\n${requirementDetails.stderr}`.match(/^designated => (.+)$/m)?.[1];
    if (!designatedRequirement?.includes(`identifier "com.electron.aidraw"`)) throw new Error('macOS package has no stable AIDraw designated requirement.');
    macosCodeSignature = {
      verified: true,
      identifier: details.match(/^Identifier=(.+)$/m)?.[1],
      signature: details.match(/^Signature=(.+)$/m)?.[1],
      teamIdentifier: details.match(/^TeamIdentifier=(.+)$/m)?.[1],
      designatedRequirement,
    };
  }
  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  const buildOnlyAuditDependencyRoots = [
    '/node_modules/@electron-forge/',
    '/node_modules/@electron/node-gyp/',
    '/node_modules/@electron/rebuild/',
    '/node_modules/@inquirer/',
    '/node_modules/@listr2/prompt-adapter-inquirer/',
    '/node_modules/appdmg/',
    '/node_modules/cacache/',
    '/node_modules/electron-installer-dmg/',
    '/node_modules/external-editor/',
    '/node_modules/image-size/',
    '/node_modules/make-fetch-happen/',
    '/node_modules/tar/',
    '/node_modules/tmp/',
  ];
  const packagedBuildOnlyAuditDependencies = archiveFiles.filter((entry) => buildOnlyAuditDependencyRoots.some((root) => entry.startsWith(root)));
  if (packagedBuildOnlyAuditDependencies.length) throw new Error(`Build-only audit dependencies leaked into the runtime archive: ${packagedBuildOnlyAuditDependencies.slice(0, 5).join(', ')}.`);
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
  const packagedFontLicense = await inspectPackagedFontLicense({ packageDirectory: packageDir, platform });
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  const dependencySecurity = inspectDependencySecurityPolicy({ packageJson, lockJson: packageLock });
  const packagedElectronVersion = assertPackagedElectronVersion(
    dependencySecurity.electron,
    await readFile(join(packageDir, 'version'), 'utf8'),
  );
  process.stdout.write(`${JSON.stringify({
    verified: true,
    node: process.version,
    platform,
    architecture,
    packagedElectronVersion,
    dependencySecurity,
    packageDir,
    executable,
    executableBytes: executableInfo.size,
    runtimeBytes: runtimeInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
    appAsarSha256: createHash('sha256').update(archiveBytes).digest('hex').toUpperCase(),
    macosCodeSignature,
    buildOnlyAuditDependenciesAbsent: true,
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
    packagedFontLicense,
    packagedSecurity,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIDraw package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
