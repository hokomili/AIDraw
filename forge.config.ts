import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { resolve } from 'node:path';
import process from 'node:process';

const packagedRuntimeRoots = [
  '/.vite',
  '/node_modules/@napi-rs/canvas',
  '/node_modules/@napi-rs/canvas-win32-x64-msvc',
  '/node_modules/ajv',
  '/node_modules/ajv-formats',
  '/node_modules/fast-deep-equal',
  '/node_modules/fast-uri',
  '/node_modules/json-schema-traverse',
  '/node_modules/require-from-string',
];

const config: ForgeConfig = {
  outDir: process.env.AIDRAW_FORGE_OUT_DIR || 'out',
  packagerConfig: {
    asar: { unpack: '**/*.node' },
    prune: false,
    // Vite bundles the application graph. Keep only the native raster binding
    // and AJV helpers referenced by generated standalone validator functions.
    ignore: (filePath) => {
      if (!filePath) return false;
      const keep = packagedRuntimeRoots.some((root) =>
        filePath === root || filePath.startsWith(`${root}/`) || root.startsWith(`${filePath}/`),
      );
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
    new MakerZIP({}, ['win32']),
  ],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      if (platform !== 'win32') return;
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
      await flipFuses(resolve(buildPath, '..', '..', 'electron.exe'), {
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
