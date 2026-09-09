import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const SID_PATTERN = /^S-1-(?:\d+-){1,14}\d+$/u;
const VOLUME_IDENTITY_PATTERN = /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/iu;
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const CREATOR_OWNER_SID = 'S-1-3-0';
const OWNER_RIGHTS_SID = 'S-1-3-4';
const FILE_SYSTEM_RIGHTS_FULL_CONTROL = 2_032_127;
const ANCESTOR_REPLACEMENT_RIGHTS = 65_536 | 64 | 262_144 | 524_288;
const IMMEDIATE_PARENT_CREATION_RIGHTS = 2 | 4;
const MAX_ACL_REPORT_BYTES = 64 * 1024;
const MAX_PATH_COMPONENTS = 128;
const MAX_RULES_PER_COMPONENT = 64;

const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$mode = $args[0]
$path = [IO.Path]::GetFullPath($args[1])
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AIDrawNativeVolume {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetVolumeNameForVolumeMountPoint(string volumeMountPoint, StringBuilder volumeName, uint bufferLength);
}
'@
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$trustedOwnerSids = @(
  $current.Value,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$trustedRuleSids = @($trustedOwnerSids) + @('S-1-3-0', 'S-1-3-4')
$ancestorReplacementMask = [long]([Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
$parentCreationMask = [long]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData)

function Assert-AIDrawFixedLocalVolume([string]$candidate) {
  $root = [IO.Path]::GetPathRoot($candidate)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'AIDraw runtime path has no Windows volume root.' }
  $drive = New-Object IO.DriveInfo($root)
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or -not $drive.IsReady) {
    throw 'AIDraw runtime path must resolve to a ready fixed local Windows volume.'
  }
  $volumeName = New-Object Text.StringBuilder(128)
  if (-not [AIDrawNativeVolume]::GetVolumeNameForVolumeMountPoint($root, $volumeName, [uint32]$volumeName.Capacity)) {
    throw 'AIDraw runtime path uses a mapped, substituted, or otherwise non-volume drive alias.'
  }
  $identity = $volumeName.ToString()
  if ($identity -notmatch '^\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\$') {
    throw 'AIDraw runtime path returned an invalid local volume identity.'
  }
  [ordered]@{ driveType = $drive.DriveType.ToString(); volumeIdentity = $identity }
}

function Get-AIDrawPathComponents([string]$candidate) {
  $components = @()
  $cursor = $candidate
  $depth = 0
  while ($true) {
    $component = Get-Item -LiteralPath $cursor -Force
    if (-not $component.PSIsContainer) { throw 'AIDraw runtime path contains a non-directory component.' }
    if (($component.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'AIDraw runtime path cannot contain a reparse point.' }
    $acl = Get-Acl -LiteralPath $cursor
    $rules = @($acl.Access | ForEach-Object {
      [ordered]@{
        sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        accessType = $_.AccessControlType.ToString()
        rights = [long]$_.FileSystemRights
        inherited = $_.IsInherited
        inheritanceFlags = $_.InheritanceFlags.ToString()
        propagationFlags = $_.PropagationFlags.ToString()
      }
    })
    $components += [pscustomobject][ordered]@{
      depth = $depth
      leaf = ($depth -eq 0)
      ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      protected = $acl.AreAccessRulesProtected
      rules = $rules
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
    $depth += 1
  }
  @($components)
}

function Assert-AIDrawSafeAncestors([object[]]$components) {
  foreach ($component in @($components | Where-Object { -not $_.leaf })) {
    if ($trustedOwnerSids -notcontains $component.ownerSid) {
      throw 'AIDraw runtime path has an ancestor owned by an unrelated Windows principal.'
    }
    foreach ($rule in @($component.rules)) {
      if ($rule.accessType -ne 'Allow' -or $trustedRuleSids -contains $rule.sid) { continue }
      $propagation = @($rule.propagationFlags -split ',' | ForEach-Object { $_.Trim() })
      if ($propagation -contains 'InheritOnly') { continue }
      $unsafeMask = $ancestorReplacementMask
      if ($component.depth -eq 1) { $unsafeMask = $unsafeMask -bor $parentCreationMask }
      if (([long]$rule.rights -band $unsafeMask) -ne 0) {
        throw 'AIDraw runtime path grants an unrelated Windows principal replacement authority over protected runtime state.'
      }
    }
  }
}

function Assert-AIDrawExactLeaf([string]$candidate) {
  $acl = Get-Acl -LiteralPath $candidate
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current.Value -or -not $acl.AreAccessRulesProtected) {
    throw 'AIDraw runtime directory is not owned and protected for the current Windows user.'
  }
  $rules = @($acl.Access)
  if ($rules.Count -ne 2) { throw 'AIDraw runtime directory has an unexpected Windows ACL rule count.' }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if (($sid -ne $current.Value -and $sid -ne $system.Value) -or $seen.ContainsKey($sid) -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      [long]$rule.FileSystemRights -ne [long][Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.IsInherited -or
      [int]$rule.InheritanceFlags -ne ([int][Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [int][Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
      $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      throw 'AIDraw runtime directory has an unsafe Windows ACL rule.'
    }
    $seen[$sid] = $true
  }
  if (-not $seen.ContainsKey($current.Value) -or -not $seen.ContainsKey($system.Value)) {
    throw 'AIDraw runtime directory lacks a required Windows ACL principal.'
  }
}

$volume = Assert-AIDrawFixedLocalVolume $path
$initialComponents = Get-AIDrawPathComponents $path
Assert-AIDrawSafeAncestors $initialComponents
if ($mode -eq 'ensure') {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
  Set-Acl -LiteralPath $path -AclObject $acl
} elseif ($mode -ne 'validate') {
  throw 'Unknown AIDraw ACL operation.'
}
$verifiedVolume = Assert-AIDrawFixedLocalVolume $path
if ($volume.volumeIdentity -cne $verifiedVolume.volumeIdentity) {
  throw 'AIDraw runtime path changed physical Windows volumes during ACL validation.'
}
$components = Get-AIDrawPathComponents $path
Assert-AIDrawSafeAncestors $components
Assert-AIDrawExactLeaf $path
[ordered]@{
  currentSid = $current.Value
  driveType = $verifiedVolume.driveType
  initialVolumeIdentity = $volume.volumeIdentity
  volumeIdentity = $verifiedVolume.volumeIdentity
  components = $components
} | ConvertTo-Json -Compress -Depth 6
`.trim();

export interface WindowsAclRuleReport {
  sid: string;
  accessType: 'Allow' | 'Deny';
  rights: number;
  inherited: boolean;
  inheritanceFlags: string;
  propagationFlags: string;
}

export interface WindowsPathComponentReport {
  depth: number;
  leaf: boolean;
  ownerSid: string;
  protected: boolean;
  rules: WindowsAclRuleReport[];
}

export interface WindowsPrivateDirectoryReport {
  currentSid: string;
  driveType: string;
  initialVolumeIdentity: string;
  volumeIdentity: string;
  components: WindowsPathComponentReport[];
}

export type WindowsAclExecutor = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export interface WindowsPrivateDirectoryOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execute?: WindowsAclExecutor;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseRule(value: unknown): WindowsAclRuleReport | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['sid', 'accessType', 'rights', 'inherited', 'inheritanceFlags', 'propagationFlags'])
    || typeof value.sid !== 'string' || !SID_PATTERN.test(value.sid)
    || (value.accessType !== 'Allow' && value.accessType !== 'Deny')
    || !Number.isSafeInteger(value.rights) || Number(value.rights) < -2_147_483_648 || Number(value.rights) > 2_147_483_647
    || typeof value.inherited !== 'boolean' || typeof value.inheritanceFlags !== 'string'
    || value.inheritanceFlags.length > 64 || typeof value.propagationFlags !== 'string'
    || value.propagationFlags.length > 64) return undefined;
  return {
    sid: value.sid,
    accessType: value.accessType,
    rights: Number(value.rights),
    inherited: value.inherited,
    inheritanceFlags: value.inheritanceFlags,
    propagationFlags: value.propagationFlags,
  };
}

function parseComponent(value: unknown): WindowsPathComponentReport | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['depth', 'leaf', 'ownerSid', 'protected', 'rules'])
    || !Number.isSafeInteger(value.depth) || Number(value.depth) < 0 || Number(value.depth) >= MAX_PATH_COMPONENTS
    || typeof value.leaf !== 'boolean' || typeof value.ownerSid !== 'string' || !SID_PATTERN.test(value.ownerSid)
    || typeof value.protected !== 'boolean' || !Array.isArray(value.rules)
    || value.rules.length > MAX_RULES_PER_COMPONENT) return undefined;
  const rules = value.rules.map(parseRule);
  if (rules.some((rule) => !rule)) return undefined;
  return {
    depth: Number(value.depth),
    leaf: value.leaf,
    ownerSid: value.ownerSid,
    protected: value.protected,
    rules: rules as WindowsAclRuleReport[],
  };
}

export function parseWindowsPrivateDirectoryReport(value: unknown): WindowsPrivateDirectoryReport | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['currentSid', 'driveType', 'initialVolumeIdentity', 'volumeIdentity', 'components'])
    || typeof value.currentSid !== 'string' || !SID_PATTERN.test(value.currentSid)
    || typeof value.driveType !== 'string' || value.driveType.length > 32
    || typeof value.initialVolumeIdentity !== 'string' || value.initialVolumeIdentity.length > 128
    || typeof value.volumeIdentity !== 'string' || value.volumeIdentity.length > 128
    || !Array.isArray(value.components) || value.components.length < 2 || value.components.length > MAX_PATH_COMPONENTS) return undefined;
  const components = value.components.map(parseComponent);
  if (components.some((component) => !component)) return undefined;
  return {
    currentSid: value.currentSid,
    driveType: value.driveType,
    initialVolumeIdentity: value.initialVolumeIdentity,
    volumeIdentity: value.volumeIdentity,
    components: components as WindowsPathComponentReport[],
  };
}

function flagSet(value: string, allowed: ReadonlySet<string>): Set<string> | undefined {
  const flags = value.split(',').map((flag) => flag.trim()).filter(Boolean);
  if (flags.length < 1 || flags.some((flag) => !allowed.has(flag)) || new Set(flags).size !== flags.length) return undefined;
  return new Set(flags);
}

function hasExactChildInheritance(flags: string): boolean {
  const values = flagSet(flags, new Set(['None', 'ContainerInherit', 'ObjectInherit']));
  return values?.size === 2 && values.has('ContainerInherit') && values.has('ObjectInherit');
}

function ruleAppliesToComponent(rule: WindowsAclRuleReport): boolean {
  const propagation = flagSet(rule.propagationFlags, new Set(['None', 'NoPropagateInherit', 'InheritOnly']));
  const inheritance = flagSet(rule.inheritanceFlags, new Set(['None', 'ContainerInherit', 'ObjectInherit']));
  if (!propagation || !inheritance) throw new Error('AIDraw rejected unknown Windows ACL inheritance or propagation flags.');
  return !propagation.has('InheritOnly');
}

export function assertWindowsPrivateDirectoryReport(value: unknown): WindowsPrivateDirectoryReport {
  const report = parseWindowsPrivateDirectoryReport(value);
  if (!report) throw new Error('AIDraw could not validate the Windows runtime-directory ACL report.');
  if (report.driveType !== 'Fixed' || !VOLUME_IDENTITY_PATTERN.test(report.initialVolumeIdentity)
    || !VOLUME_IDENTITY_PATTERN.test(report.volumeIdentity)) {
    throw new Error('AIDraw MCP runtime state does not resolve to a fixed local Windows volume.');
  }
  if (report.initialVolumeIdentity !== report.volumeIdentity) {
    throw new Error('AIDraw MCP runtime state changed physical Windows volumes during ACL validation.');
  }
  if (report.components.some((component, index) => component.depth !== index || component.leaf !== (index === 0))) {
    throw new Error('AIDraw MCP runtime state returned an ambiguous Windows path-component order.');
  }

  const leaf = report.components[0];
  if (!leaf.protected || leaf.ownerSid !== report.currentSid) {
    throw new Error('AIDraw MCP runtime state is not owned and protected for the current Windows user.');
  }
  const permittedLeaf = new Set([report.currentSid, SYSTEM_SID]);
  if (leaf.rules.length !== permittedLeaf.size || new Set(leaf.rules.map((rule) => rule.sid)).size !== permittedLeaf.size
    || leaf.rules.some((rule) => !permittedLeaf.has(rule.sid) || rule.accessType !== 'Allow'
      || rule.rights !== FILE_SYSTEM_RIGHTS_FULL_CONTROL || rule.inherited
      || !hasExactChildInheritance(rule.inheritanceFlags) || rule.propagationFlags !== 'None')) {
    throw new Error('AIDraw MCP runtime state grants an unsafe Windows leaf ACL trustee, access right, or inheritance rule.');
  }
  if (!leaf.rules.some((rule) => rule.sid === report.currentSid)
    || !leaf.rules.some((rule) => rule.sid === SYSTEM_SID)) {
    throw new Error('AIDraw MCP runtime state lacks the required current-user or SYSTEM Windows ACL.');
  }

  const trustedOwners = new Set([report.currentSid, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID]);
  const trustedRules = new Set([...trustedOwners, CREATOR_OWNER_SID, OWNER_RIGHTS_SID]);
  for (const component of report.components.slice(1)) {
    if (!trustedOwners.has(component.ownerSid)) {
      throw new Error('AIDraw MCP runtime state has a Windows ancestor owned by an unrelated principal.');
    }
    for (const rule of component.rules) {
      const applies = ruleAppliesToComponent(rule);
      if (!applies || rule.accessType !== 'Allow' || trustedRules.has(rule.sid)) continue;
      const unsafeMask = ANCESTOR_REPLACEMENT_RIGHTS
        | (component.depth === 1 ? IMMEDIATE_PARENT_CREATION_RIGHTS : 0);
      if ((rule.rights & unsafeMask) !== 0) {
        throw new Error('AIDraw MCP runtime state grants an unrelated principal Windows ancestor replacement authority.');
      }
    }
  }
  return report;
}

async function runWindowsAcl(
  mode: 'ensure' | 'validate',
  directory: string,
  options: WindowsPrivateDirectoryOptions,
): Promise<WindowsPrivateDirectoryReport | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const normalizedDirectory = win32.normalize(directory);
  const unsafeControl = [...normalizedDirectory].some((character) => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f);
  if (!win32.isAbsolute(normalizedDirectory) || !/^[A-Za-z]:\\/u.test(normalizedDirectory) || unsafeControl) {
    throw new Error('AIDraw Windows runtime state requires a safe absolute directory.');
  }
  const systemRoot = options.environment?.SystemRoot ?? options.environment?.windir ?? process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('AIDraw could not resolve Windows PowerShell for private runtime-state validation.');
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executor: WindowsAclExecutor = options.execute ?? (async (command, args) => executeFile(command, [...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_ACL_REPORT_BYTES,
  }));
  // -Command joins trailing argv into source instead of binding $args. Invoke
  // a script block explicitly and transport it without Windows quoting loss.
  // Keep path data out of source: PowerShell recognizes smart quotes as string
  // delimiters too. Base64's alphabet cannot terminate the fixed literal below.
  const argument = (value: string) => `([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}')))`;
  const invocation = `& {\n${WINDOWS_PRIVATE_DIRECTORY_SCRIPT}\n} ${argument(mode)} ${argument(normalizedDirectory)}`;
  const { stdout } = await executor(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(invocation, 'utf16le').toString('base64'),
  ]);
  const text = stdout.toString();
  if (Buffer.byteLength(text, 'utf8') > MAX_ACL_REPORT_BYTES) throw new Error('AIDraw rejected an oversized Windows ACL report.');
  return assertWindowsPrivateDirectoryReport(JSON.parse(text) as unknown);
}

export async function ensureWindowsPrivateDirectory(
  directory: string,
  options: WindowsPrivateDirectoryOptions = {},
): Promise<void> {
  await runWindowsAcl('ensure', directory, options);
}

export async function validateWindowsPrivateDirectory(
  directory: string,
  options: WindowsPrivateDirectoryOptions = {},
): Promise<void> {
  await runWindowsAcl('validate', directory, options);
}
