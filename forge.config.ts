import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { SafeDmgMaker } from './scripts/safe-dmg-maker.mjs';
import { capturePackageBuildInput } from './scripts/package-build-input.mjs';
import { reservePackageGeneration, resolvePackageOutputRoot } from './scripts/package-output-policy.mjs';
import { resolve } from 'node:path';
import process from 'node:process';

const localElectronZipDirectory = process.env.AIDRAW_ELECTRON_ZIP_DIR;
const macSigningIdentity = process.env.AIDRAW_MACOS_SIGN_IDENTITY?.trim();
const macBundleIdentifier = 'com.electron.aidraw';
const packageOutputRoot = resolvePackageOutputRoot();

// Electron's downloaded macOS bundle is ad-hoc signed before Packager renames
// the app and rewrites Info.plist. Sign the completed bundle again so local
// unsigned builds still have a valid integrity seal. A release runner can opt
// into its Developer ID identity without changing this configuration.
const macSigningOptions = macSigningIdentity
  ? {
      identity: macSigningIdentity,
      identityValidation: true,
    }
  : {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      strictVerify: true,
      optionsForFile: (filePath: string) => ({
        hardenedRuntime: false,
        timestamp: 'none',
        // A default ad-hoc designated requirement is a changing CDHash. Keep a
        // stable identifier requirement so rebuilt development bundles retain
        // a predictable local code identity.
        ...(filePath.endsWith('/AIDraw.app')
          ? { requirements: `=designated => identifier "${macBundleIdentifier}"` }
          : {}),
      }),
    };

const packagedRuntimeRoots = [
  '/.vite',
  '/node_modules/@napi-rs/canvas',
  '/node_modules/ajv',
  '/node_modules/ajv-formats',
  '/node_modules/fast-deep-equal',
  '/node_modules/fast-uri',
  '/node_modules/json-schema-traverse',
  '/node_modules/paper',
  '/node_modules/require-from-string',
];

const config: ForgeConfig = {
  outDir: packageOutputRoot,
  packagerConfig: {
    asar: { unpack: '**/*.node' },
    extraResource: [resolve('resources/licenses/LiberationSans-OFL-1.1.txt')],
    prune: false,
    appBundleId: macBundleIdentifier,
    osxSign: macSigningOptions,
    ...(localElectronZipDirectory ? { electronZipDir: resolve(localElectronZipDirectory) } : {}),
    // Vite bundles the application graph. Keep the native raster binding,
    // Paper's deliberately externalized geometry runtime, and AJV helpers
    // referenced by generated standalone validator functions.
    ignore: (filePath) => {
      if (!filePath) return false;
      const keep = packagedRuntimeRoots.some((root) =>
        filePath === root || filePath.startsWith(`${root}/`) || root.startsWith(`${filePath}/`),
      ) || filePath.startsWith('/node_modules/@napi-rs/canvas-');
      return !keep;
    },
    download: {
      cacheRoot: resolve('.electron-cache'),
    },
  },
  // @napi-rs/canvas ships an Electron-compatible N-API binary. Rebuilding all
  // optional dependencies would incorrectly compile Fabric's unused `canvas`.
  rebuildConfig: { onlyModules: [] },
  makers: [
    new MakerSquirrel({
      name: 'aidraw',
      setupExe: 'AIDraw-Setup.exe',
    }),
    new SafeDmgMaker({ name: 'AIDraw' }, ['darwin']),
    new MakerDeb({
      options: {
        name: 'aidraw', productName: 'AIDraw', genericName: 'Drawing Studio',
        description: 'Agent-native mixed-media and pixel-art studio',
        maintainer: 'AIDraw contributors', homepage: 'https://github.com/hokomili/AIDraw',
        categories: ['Graphics'], mimeType: ['application/x-aidraw'],
      },
    }, ['linux']),
    new MakerRpm({
      options: {
        name: 'aidraw', productName: 'AIDraw', genericName: 'Drawing Studio',
        description: 'Agent-native mixed-media and pixel-art studio',
        license: 'MIT', homepage: 'https://github.com/hokomili/AIDraw',
        categories: ['Graphics'], mimeType: ['application/x-aidraw'],
      },
    }, ['linux']),
    new MakerZIP({}, ['win32', 'darwin', 'linux']),
  ],
  hooks: {
    prePackage: async (_forgeConfig, platform, arch) => {
      await reservePackageGeneration({ outputDirectory: packageOutputRoot, platform, architecture: arch });
      await capturePackageBuildInput({ outputDirectory: packageOutputRoot });
    },
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
      const electronBinary = platform === 'win32'
        ? resolve(buildPath, '..', '..', 'electron.exe')
        : platform === 'darwin'
          ? resolve(buildPath, '..', '..', 'MacOS', 'Electron')
          : resolve(buildPath, '..', '..', 'electron');
      await flipFuses(electronBinary, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
        resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64',
      });
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/utility-worker.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
