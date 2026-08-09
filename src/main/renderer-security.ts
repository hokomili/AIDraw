interface RendererFrameIdentity {
  readonly url: string;
}

interface RendererWebContentsIdentity {
  readonly mainFrame: RendererFrameIdentity;
}

interface RendererInvokeIdentity {
  readonly sender: object;
  readonly senderFrame: RendererFrameIdentity | null;
}

function parsedUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isPackagedRendererUrl(candidate: URL): boolean {
  return candidate.protocol === 'aidraw:'
    && candidate.hostname === 'app'
    && candidate.port === ''
    && candidate.username === ''
    && candidate.password === '';
}

function isLoopbackDevelopmentOrigin(candidate: URL): boolean {
  return candidate.protocol === 'http:'
    && (candidate.hostname === 'localhost' || candidate.hostname === '127.0.0.1')
    && candidate.port !== ''
    && candidate.username === ''
    && candidate.password === '';
}

export function isTrustedRendererUrl(value: string, developmentServerUrl?: string): boolean {
  const candidate = parsedUrl(value);
  if (!candidate) return false;
  if (isPackagedRendererUrl(candidate)) return true;

  const developmentServer = parsedUrl(developmentServerUrl);
  return Boolean(
    developmentServer
    && isLoopbackDevelopmentOrigin(developmentServer)
    && isLoopbackDevelopmentOrigin(candidate)
    && candidate.origin === developmentServer.origin,
  );
}

export function assertTrustedRendererInvocation(
  event: RendererInvokeIdentity,
  trustedWebContents: RendererWebContentsIdentity | undefined,
  developmentServerUrl?: string,
): void {
  const senderFrame = event.senderFrame;
  if (!trustedWebContents || event.sender !== trustedWebContents || !senderFrame || senderFrame !== trustedWebContents.mainFrame) {
    throw new Error('Rejected IPC from an untrusted renderer.');
  }
  if (!isTrustedRendererUrl(senderFrame.url, developmentServerUrl)) {
    throw new Error('Rejected IPC from an unexpected origin.');
  }
}
