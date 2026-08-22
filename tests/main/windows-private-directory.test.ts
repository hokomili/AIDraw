import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('Windows private MCP runtime directory', () => {
  it('uses actual fixed-volume identity and checks every ancestor before and after exact leaf enforcement', async () => {
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      expect(args).toContain('-NoProfile');
      expect(args).toContain('-NonInteractive');
      const script = args[args.indexOf('-Command') + 1];
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
      expect(args.at(-1)).toBe('C:\\Users\\Artist\\AIDraw Profile\\runtime');
      return { stdout: JSON.stringify(safeReport) };
    });
    const options = { platform: 'win32' as const, environment: { SystemRoot: 'C:\\Windows' }, execute };
    await ensureWindowsPrivateDirectory('C:\\Users\\Artist\\AIDraw Profile\\runtime', options);
    await validateWindowsPrivateDirectory('C:\\Users\\Artist\\AIDraw Profile\\runtime', options);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1].at(-2)).toBe('ensure');
    expect(execute.mock.calls[1][1].at(-2)).toBe('validate');
  });

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
      expect(args.at(-1)).toBe('Z:\\MappedShare\\Artist\\runtime');
      return { stdout: JSON.stringify({ ...safeReport, driveType: 'Network', volumeIdentity: '' }) };
    });
    await expect(validateWindowsPrivateDirectory('Z:\\MappedShare\\Artist\\runtime', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      execute: networkExecute,
    })).rejects.toThrow('fixed local Windows volume');
    expect(networkExecute).toHaveBeenCalledOnce();
    expect(networkExecute.mock.calls[0][1].at(-1)).toBe('Z:\\MappedShare\\Artist\\runtime');

    const aliasExecute = vi.fn(async (command: string, args: readonly string[]) => {
      expect(command).toContain('powershell.exe');
      expect(args.at(-1)).toBe('S:\\Substituted\\Artist\\runtime');
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
