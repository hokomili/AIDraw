import { describe, expect, it } from 'vitest';
import { assertTrustedRendererInvocation, isTrustedRendererUrl } from '../../src/main/renderer-security';

describe('sandboxed renderer origin and IPC boundary', () => {
  it('accepts only the packaged app or the exact configured loopback development origin', () => {
    expect(isTrustedRendererUrl('aidraw://app/index.html')).toBe(true);
    expect(isTrustedRendererUrl('aidraw://app/editor?document=one#canvas')).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/editor', 'http://localhost:5173')).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:4173/@vite/client', 'http://127.0.0.1:4173/')).toBe(true);
  });

  it.each([
    ['arbitrary loopback service', 'http://localhost:7331/editor', 'http://localhost:5173'],
    ['configured-port prefix lookalike', 'http://localhost:51730/editor', 'http://localhost:5173'],
    ['alternate loopback host', 'http://127.0.0.1:5173/editor', 'http://localhost:5173'],
    ['prefix-lookalike hostname', 'http://localhost:5173.attacker.test/editor', 'http://localhost:5173'],
    ['credentialed host confusion', 'http://localhost:5173@attacker.test/editor', 'http://localhost:5173'],
    ['non-loopback configured server', 'https://editor.example.test/', 'https://editor.example.test/'],
    ['packaged host suffix', 'aidraw://app.attacker.test/index.html', undefined],
    ['malformed URL', 'not a renderer URL', 'http://localhost:5173'],
  ])('rejects %s', (_label, candidate, developmentServer) => {
    expect(isTrustedRendererUrl(candidate, developmentServer)).toBe(false);
  });

  it('rejects a wrong webContents, a subframe, and an exact-window main frame on the wrong origin', () => {
    const mainFrame = { url: 'aidraw://app/index.html' };
    const trustedWebContents = { mainFrame };

    expect(() => assertTrustedRendererInvocation({ sender: trustedWebContents, senderFrame: mainFrame }, trustedWebContents)).not.toThrow();
    expect(() => assertTrustedRendererInvocation({ sender: { mainFrame }, senderFrame: mainFrame }, trustedWebContents)).toThrow('Rejected IPC from an untrusted renderer.');
    expect(() => assertTrustedRendererInvocation({ sender: trustedWebContents, senderFrame: { url: mainFrame.url } }, trustedWebContents)).toThrow('Rejected IPC from an untrusted renderer.');
    expect(() => assertTrustedRendererInvocation({ sender: trustedWebContents, senderFrame: null }, trustedWebContents)).toThrow('Rejected IPC from an untrusted renderer.');

    mainFrame.url = 'http://127.0.0.1:7331/hostile';
    expect(() => assertTrustedRendererInvocation({ sender: trustedWebContents, senderFrame: mainFrame }, trustedWebContents, 'http://127.0.0.1:5173')).toThrow('Rejected IPC from an unexpected origin.');
  });
});
