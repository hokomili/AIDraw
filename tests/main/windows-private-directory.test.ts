import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWindowsPrivateDirectoryReport,
  ensureWindowsPrivateDirectory,
  validateWindowsPrivateDirectory,
} from '@main/windows-private-directory';
import {
  mcpRunStatePaths,
  publishMcpEngineRunState,
  readCurrentMcpEngineRunState,
  type McpEngineRunState,
} from '@main/mcp-run-state';

const temporaryDirectories: string[] = [];
const currentSid = 'S-1-5-21-100-200-300-1001';
const systemSid = 'S-1-5-18';
const administratorsSid = 'S-1-5-32-544';
const trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const usersSid = 'S-1-5-32-545';
const authenticatedUsersSid = 'S-1-5-11';
const fullControl = 2_032_127;
const readAndExecute = 131_241;

function rule(
  sid: string,
  rights: number,
  overrides: Partial<{
    accessType: 'Allow' | 'Deny';
    inherited: boolean;
    inheritanceFlags: string;
    propagationFlags: string;
  }> = {},
) {
  return {
    sid,
    accessType: 'Allow' as const,
    rights,
    inherited: false,
    inheritanceFlags: 'ContainerInherit, ObjectInherit',
    propagationFlags: 'None',
    ...overrides,
  };
}

const safeReport = {
  currentSid,
  driveType: 'Fixed',
  initialVolumeIdentity: '\\\\?\\Volume{11111111-2222-4333-8444-555555555555}\\',
  volumeIdentity: '\\\\?\\Volume{11111111-2222-4333-8444-555555555555}\\',
  components: [
    {
      depth: 0,
      leaf: true,
      ownerSid: currentSid,
      protected: true,
      rules: [rule(currentSid, fullControl), rule(systemSid, fullControl, { inheritanceFlags: 'ObjectInherit, ContainerInherit' })],
    },
    {
      depth: 1,
      leaf: false,
      ownerSid: currentSid,
      protected: false,
      rules: [
        rule(currentSid, fullControl),
        rule(systemSid, fullControl),
        rule(usersSid, readAndExecute, { inherited: true, inheritanceFlags: 'ContainerInherit' }),
      ],
    },
    {
      depth: 2,
      leaf: false,
      ownerSid: systemSid,
      protected: false,
      rules: [
        rule(systemSid, fullControl),
        // Ordinary C:\Users-like ancestry may let authenticated users create
        // siblings. That is not enough to replace an already protected child
        // below the current user's immediate parent.
        rule(authenticatedUsersSid, 4, { inherited: true, inheritanceFlags: 'None' }),
      ],
    },
    {
      depth: 3,
      leaf: false,
      ownerSid: trustedInstallerSid,
      protected: false,
      rules: [
        rule(administratorsSid, fullControl),
        rule(usersSid, readAndExecute, { inherited: true, inheritanceFlags: 'None' }),
      ],
    },
  ],
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});


function decodedInvocation(args: readonly string[]): string {
  expect(args).not.toContain('-Command');
  expect(args.at(-2)).toBe('-EncodedCommand');
  return Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
}

function expectedInvocationSuffix(mode: string, directory: string): string {
  const argument = (value: string) => `([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}')))`;
  return `} ${argument(mode)} ${argument(directory)}`;
}

describe('Windows private MCP runtime directory', () => {
  it('uses actual fixed-volume identity and checks every ancestor before and after exact leaf enforcement', async () => {
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      expect(args).toContain('-NoProfile');
      expect(args).toContain('-NonInteractive');
      const script = decodedInvocation(args);
      expect(script).toMatch(/^& \{\n/);
      expect(script).not.toMatch(/^[ \t]+-(?:or|and)\b/m);
      expect(script.indexOf("$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')")).toBeLessThan(script.indexOf('Add-Type'));
      expect(script).toContain('New-Object IO.DriveInfo($root)');
      expect(script).toContain('[IO.DriveType]::Fixed');
      expect(script).toContain('GetVolumeNameForVolumeMountPoint');
      expect(script).toContain('Get-AIDrawPathComponents');
      expect(script).toContain('[IO.Directory]::GetParent($cursor)');
      expect(script).toContain('[IO.FileAttributes]::ReparsePoint');
      expect(script).toContain('Assert-AIDrawSafeAncestors $initialComponents');
      expect(script).toContain('Assert-AIDrawSafeAncestors $components');
      expect(script).toContain('$volume.volumeIdentity -cne $verifiedVolume.volumeIdentity');
      expect(script).toContain('[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles');
      expect(script).toContain('[Security.AccessControl.FileSystemRights]::WriteData');
      expect(script).toContain('rights = [long]$_.FileSystemRights');
      expect(script).not.toContain('C:\\Users\\Artist\\AIDraw Profile\\runtime');
      return { stdout: JSON.stringify(safeReport) };
    });
    const options = { platform: 'win32' as const, environment: { SystemRoot: 'C:\\Windows' }, execute };
    await ensureWindowsPrivateDirectory('C:\\Users\\Artist\\AIDraw Profile\\runtime', options);
    await validateWindowsPrivateDirectory('C:\\Users\\Artist\\AIDraw Profile\\runtime', options);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(decodedInvocation(execute.mock.calls[0][1])).toContain(expectedInvocationSuffix('ensure', 'C:\\Users\\Artist\\AIDraw Profile\\runtime'));
    expect(decodedInvocation(execute.mock.calls[1][1])).toContain(expectedInvocationSuffix('validate', 'C:\\Users\\Artist\\AIDraw Profile\\runtime'));
  });

  it.each(["QA '畫圖' $(throw 'unexpected')", "Artist’s work", "QA ‘ $(throw 'unexpected') ’ “畫圖”"])(
    'keeps the directory argument as data through PowerShell transport: %s', async (name) => {
    const directory = `C:\\Users\\Artist\\${name}\\runtime`;
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      const invocation = decodedInvocation(args);
      expect(invocation).toContain(expectedInvocationSuffix('ensure', directory));
      expect(invocation).not.toContain(name);
      const encodedArguments = [...invocation.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)];
      expect(encodedArguments.map((match) => Buffer.from(match[1], 'base64').toString('utf16le'))).toEqual(['ensure', directory]);
      return { stdout: JSON.stringify(safeReport) };
    });
    await ensureWindowsPrivateDirectory(directory, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, execute });
  });

  it.skipIf(process.platform !== 'win32')('enforces and validates a real private directory through native PowerShell argument transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-native-acl-'));
    temporaryDirectories.push(root);
    const directory = join(root, "QA '畫圖' ‘ $(throw 'unexpected') ’ “畫圖”");
    await mkdir(directory);
    await ensureWindowsPrivateDirectory(directory);
    await validateWindowsPrivateDirectory(directory);

    // A caller's module search path must not select its Get-Acl implementation.
    const moduleRoot = join(root, 'foreign-modules');
    const moduleDirectory = join(moduleRoot, 'Microsoft.PowerShell.Security');
    await mkdir(moduleDirectory, { recursive: true });
    await writeFile(join(moduleDirectory, 'Microsoft.PowerShell.Security.psm1'), "throw 'Unexpected caller-owned security module import'", 'utf8');
    const execute = async (command: string, args: readonly string[]) => promisify(execFile)(command, [...args], {
      env: { ...process.env, PSModulePath: moduleRoot }, encoding: 'utf8', windowsHide: true,
    });
    await ensureWindowsPrivateDirectory(directory, { execute });
    await validateWindowsPrivateDirectory(directory, { execute });
  }, 30_000);

  it('accepts ordinary safe profile ancestry but rejects unsafe owner, replacement, and immediate-parent creation authority', () => {
    expect(assertWindowsPrivateDirectoryReport(safeReport)).toEqual(safeReport);
    const withComponent = (depth: number, update: (component: typeof safeReport.components[number]) => typeof safeReport.components[number]) => ({
      ...safeReport,
      components: safeReport.components.map((component) => component.depth === depth ? update(component) : component),
    });
    for (const unsafe of [
      withComponent(2, (component) => ({ ...component, ownerSid: 'S-1-5-21-900-800-700-1002' })),
      withComponent(2, (component) => ({ ...component, rules: [...component.rules, rule(usersSid, 64, { inheritanceFlags: 'None' })] })),
      withComponent(2, (component) => ({ ...component, rules: [...component.rules, rule(usersSid, 262_144, { inheritanceFlags: 'None' })] })),
      withComponent(1, (component) => ({ ...component, rules: [...component.rules, rule(usersSid, 2, { inheritanceFlags: 'None' })] })),
    ]) expect(() => assertWindowsPrivateDirectoryReport(unsafe)).toThrow(/ancestor|principal|Windows/i);
  });

  it('rejects mapped-network and substituted drive reports through the production call boundary', async () => {
    const networkExecute = vi.fn(async (command: string, args: readonly string[]) => {
      expect(command).toContain('powershell.exe');
      expect(decodedInvocation(args)).toContain(expectedInvocationSuffix('validate', 'Z:\\MappedShare\\Artist\\runtime'));
      return { stdout: JSON.stringify({ ...safeReport, driveType: 'Network', volumeIdentity: '' }) };
    });
    await expect(validateWindowsPrivateDirectory('Z:\\MappedShare\\Artist\\runtime', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      execute: networkExecute,
    })).rejects.toThrow('fixed local Windows volume');
    expect(networkExecute).toHaveBeenCalledOnce();
    expect(decodedInvocation(networkExecute.mock.calls[0][1])).toContain(expectedInvocationSuffix('validate', 'Z:\\MappedShare\\Artist\\runtime'));

    const aliasExecute = vi.fn(async (command: string, args: readonly string[]) => {
      expect(command).toContain('powershell.exe');
      expect(decodedInvocation(args)).toContain(expectedInvocationSuffix('validate', 'S:\\Substituted\\Artist\\runtime'));
      return { stdout: JSON.stringify({ ...safeReport, volumeIdentity: 'C:\\' }) };
    });
    await expect(validateWindowsPrivateDirectory('S:\\Substituted\\Artist\\runtime', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      execute: aliasExecute,
    })).rejects.toThrow('fixed local Windows volume');
    expect(aliasExecute).toHaveBeenCalledOnce();
  });

  it('rejects two individually valid but unequal pre/post volume identities through the production call boundary', async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        ...safeReport,
        volumeIdentity: '\\\\?\\Volume{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}\\',
      }),
    }));
    await expect(validateWindowsPrivateDirectory('C:\\Users\\Artist\\runtime', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      execute,
    })).rejects.toThrow('changed physical Windows volumes');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects an unsafe ancestor DELETE_CHILD report through the production call boundary', async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        ...safeReport,
        components: safeReport.components.map((component) => component.depth === 2
          ? { ...component, rules: [...component.rules, rule(usersSid, 64, { inheritanceFlags: 'None' })] }
          : component),
      }),
    }));
    await expect(validateWindowsPrivateDirectory('C:\\Users\\Artist\\runtime', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      execute,
    })).rejects.toThrow('ancestor replacement authority');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unsafe final owner, trustee, access, and child inheritance reports', () => {
    const leaf = safeReport.components[0];
    const withLeaf = (updated: typeof leaf) => ({ ...safeReport, components: [updated, ...safeReport.components.slice(1)] });
    for (const unsafeLeaf of [
      { ...leaf, protected: false },
      { ...leaf, ownerSid: 'S-1-5-21-100-200-300-1002' },
      { ...leaf, rules: leaf.rules.map((entry, index) => index === 0 ? { ...entry, inherited: true } : entry) },
      { ...leaf, rules: leaf.rules.map((entry, index) => index === 0 ? { ...entry, inheritanceFlags: 'ContainerInherit' } : entry) },
      { ...leaf, rules: leaf.rules.map((entry, index) => index === 0 ? { ...entry, propagationFlags: 'InheritOnly' } : entry) },
      { ...leaf, rules: leaf.rules.map((entry, index) => index === 0 ? { ...entry, rights: fullControl - 1 } : entry) },
      { ...leaf, rules: [...leaf.rules, rule(usersSid, fullControl)] },
      { ...leaf, rules: [leaf.rules[0], { ...leaf.rules[0] }] },
      { ...leaf, rules: leaf.rules.filter((entry) => entry.sid !== systemSid) },
    ]) expect(() => assertWindowsPrivateDirectoryReport(withLeaf(unsafeLeaf))).toThrow(/Windows|ACL|runtime state/i);
    const missingInheritance = { ...leaf.rules[0] } as Record<string, unknown>;
    delete missingInheritance.inheritanceFlags;
    expect(() => assertWindowsPrivateDirectoryReport(withLeaf({
      ...leaf,
      rules: [missingInheritance, leaf.rules[1]] as typeof leaf.rules,
    }))).toThrow(/Windows|ACL|runtime state/i);
  });

  it('rejects UNC and device-style caller-selected roots before invoking PowerShell', async () => {
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(safeReport) }));
    const options = { platform: 'win32' as const, environment: { SystemRoot: 'C:\\Windows' }, execute };
    await expect(validateWindowsPrivateDirectory('\\\\server\\profile\\runtime', options)).rejects.toThrow('safe absolute directory');
    await expect(validateWindowsPrivateDirectory('\\\\?\\C:\\Users\\Artist\\runtime', options)).rejects.toThrow('safe absolute directory');
    expect(execute).not.toHaveBeenCalled();
  });

  it('secures and validates the product-owned run-state root even below a caller-selected profile', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'aidraw-explicit-windows-profile-'));
    temporaryDirectories.push(profile);
    const instanceId = '3f389a8e-e6d7-4f26-93d5-72233592bc83';
    const state: McpEngineRunState = {
      version: 1,
      instanceId,
      pid: 4321,
      authority: 'engine-run',
      url: 'http://127.0.0.1:48200/mcp',
      token: 'B'.repeat(43),
      startedAt: '2026-08-21T00:00:00.000Z',
    };
    const ensure = vi.fn(async () => undefined);
    const validate = vi.fn(async () => undefined);
    const security = {
      platform: 'win32' as const,
      ensureWindowsDirectory: ensure,
      validateWindowsDirectory: validate,
    };
    await publishMcpEngineRunState(profile, state, security);
    expect(ensure).toHaveBeenCalledWith(mcpRunStatePaths(profile).directory);
    await expect(readCurrentMcpEngineRunState(profile, security)).resolves.toEqual(state);
    expect(validate).toHaveBeenCalled();

    await expect(readCurrentMcpEngineRunState(profile, {
      ...security,
      validateWindowsDirectory: async () => { throw new Error('Injected unsafe Windows ACL identity.'); },
    })).resolves.toBeUndefined();
  });
});
