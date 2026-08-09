import { describe, expect, it } from 'vitest';
import {
  assertPackagedE2eLaunchBoundary,
  PACKAGED_E2E_LAUNCH_CONTEXT_ENV,
} from '../../scripts/packaged-e2e-boundary.mjs';

describe('packaged Playwright execution boundary', () => {
  it('refuses unacknowledged Windows and macOS launches with actionable sandbox guidance', () => {
    expect(() => assertPackagedE2eLaunchBoundary({}, 'win32')).toThrow(/explicit shell sandbox escalation/);
    expect(() => assertPackagedE2eLaunchBoundary({
      [PACKAGED_E2E_LAUNCH_CONTEXT_ENV]: 'sandboxed',
    }, 'win32')).toThrow(/exit_code=-1073741515/);
    expect(() => assertPackagedE2eLaunchBoundary({}, 'darwin')).toThrow(/blocked native services, process inspection, or DevTools startup/);
  });

  it('accepts only the explicit unsandboxed native user-session declaration', () => {
    expect(assertPackagedE2eLaunchBoundary({
      [PACKAGED_E2E_LAUNCH_CONTEXT_ENV]: ' UNSANDBOXED-GUI ',
    }, 'win32')).toEqual({ platform: 'win32', launchContext: 'unsandboxed-gui' });
    expect(assertPackagedE2eLaunchBoundary({
      [PACKAGED_E2E_LAUNCH_CONTEXT_ENV]: 'unsandboxed-gui',
    }, 'darwin')).toEqual({ platform: 'darwin', launchContext: 'unsandboxed-gui' });
  });

  it('does not impose the desktop user-session boundary on Linux', () => {
    expect(assertPackagedE2eLaunchBoundary({}, 'linux')).toEqual({ platform: 'linux', launchContext: 'not-required' });
  });
});
