# Security policy

## Supported version

AIDraw is currently pre-v1. Security fixes target the latest published prerelease on Windows 11 x64; once v1 ships, the latest stable release becomes the supported line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for the `aidraw` repository, or contact the repository owner through the private address listed in the GitHub security advisory form. Include the affected version, impact, reproduction, and whether credentials or local files may be exposed. You should receive an acknowledgement within three business days.

## Security model

- Renderer processes are sandboxed, context-isolated, denied permissions, and limited to a typed preload API.
- MCP binds only to `127.0.0.1`, requires a random bearer token, validates localhost host/origin, caps bodies, and uses stateful sessions.
- MCP and hosted-provider secrets are encrypted with Windows DPAPI. They are never stored in `.aidraw` documents.
- Agent file tools accept exact paths only. They cannot list or delete files; approvals cover untrusted access and all overwrites.
- Exact paths are canonicalized through existing ancestors so junctions/symlinks cannot disguise a target. Session and persistent folder trust never covers an overwrite, including export companion files.
- Committed entity attribution and timestamps are server-owned. Renderer submissions are always human-authored, MCP submissions use the authenticated session actor, and only the generation engine may create verified provider provenance.
- Inline MCP assets are data-only raster images (PNG/APNG/JPEG/WebP/GIF). AIDraw checks canonical base64, decoded length, SHA-256, MIME/header agreement, actual decode, an 8192 px side limit, and a 16 MP pixel limit; SVG and other active/dangerous inline formats are rejected.
- Agent generation always requires an in-app approval. AIDraw does not automatically retry an ambiguous paid POST.

Local malware running as the same Windows user, a compromised generation provider, unsafe user-supplied ComfyUI workflows, and files deliberately exported to other applications are outside the trust boundary. Treat third-party workflows and imported documents as untrusted.
