import { describe, expect, it } from 'vitest';
import { persistentEngineTarget, targetedPersistentEngineRequest } from '@main/single-instance-request';

describe('persistent-engine singleton requests', () => {
  it('normalizes the target profile deterministically and case-folds only Windows', () => {
    expect(persistentEngineTarget('/tmp/AIDraw/../Profile', 'darwin'))
      .toBe(persistentEngineTarget('/tmp/Profile', 'darwin'));
    expect(persistentEngineTarget('C:\\Users\\Artist\\Profile', 'win32'))
      .toBe(persistentEngineTarget('c:\\users\\artist\\profile', 'win32'));
    expect(persistentEngineTarget('/tmp/Profile', 'darwin'))
      .not.toBe(persistentEngineTarget('/tmp/profile', 'darwin'));
  });

  it.each(['show', 'headless', 'quit-engine'] as const)('accepts an exact %s request for the addressed profile', (command) => {
    expect(targetedPersistentEngineRequest({ command, target: 'profile-a' }, 'profile-a')).toBe(command);
  });

  it('fails closed for missing, mistargeted, or unrecognized secondary data', () => {
    expect(targetedPersistentEngineRequest(undefined, 'profile-a')).toBeUndefined();
    expect(targetedPersistentEngineRequest({ command: 'show' }, 'profile-a')).toBeUndefined();
    expect(targetedPersistentEngineRequest({ command: 'show', target: 'profile-b' }, 'profile-a')).toBeUndefined();
    expect(targetedPersistentEngineRequest({ command: 'activate', target: 'profile-a' }, 'profile-a')).toBeUndefined();
    expect(targetedPersistentEngineRequest({ command: { toString: () => 'show' }, target: 'profile-a' }, 'profile-a')).toBeUndefined();
  });
});
