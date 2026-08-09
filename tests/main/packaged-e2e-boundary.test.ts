import { describe, expect, it } from 'vitest';
import {
  assertPackagedE2eLaunchBoundary,
  PACKAGED_E2E_LAUNCH_CONTEXT_ENV,
} from '../../scripts/packaged-e2e-boundary.mjs';

describe('packaged Playwright execution boundary', () => {
  it('refuses an unacknowledged Windows launch with actionable sandbox guidance', () => {
    expect(() => assertPackagedE2eLaunchBoundary({}, 'win32')).toThrow(/explicit shell sandbox escalation/);
    expect(() => assertPackagedE2eLaunchBoundary({
      [PACKAGED_E2E_LAUNCH_CONTEXT_ENV]: 'sandboxed',
    }, 'win32')).toThrow(/exit_code=-1073741515/);
  });

  it('accepts only the explicit unsandboxed Windows launch declaration', () => {
    expect(assertPackagedE2eLaunchBoundary({
      [PACKAGED_E2E_LAUNCH_CONTEXT_ENV]: ' UNSANDBOXED-GUI ',
    }, 'win32')).toEqual({ platform: 'win32', launchContext: 'unsandboxed-gui' });
  });

  it('does not impose the Windows-specific boundary on other platforms', () => {
    expect(assertPackagedE2eLaunchBoundary({}, 'linux')).toEqual({ platform: 'linux', launchContext: 'not-required' });
  });
});
