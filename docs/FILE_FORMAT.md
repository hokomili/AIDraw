# Native file format

An `.aidraw` file is a ZIP container. Paths are UTF-8 and schema migrations are application-owned.

| Entry | Purpose |
| --- | --- |
| `manifest.json` | Format/schema identity, document metadata, revision, asset count, saving app version |
| `document.json` | Illustration or pixel document model without machine-local `filePath` or inline asset bytes |
| `assets/<sha256>` | Deduplicated imported/generated/rendered bytes, including sparse illustration paint tiles |
| `activity.json` | Persistent attribution/activity summary |
| `trace/transactions.jsonl` | Complete append-only attributed transactions for inspection and replay |
| `preview.png` | Rendered current-document preview |

`document.json` is canonical; `manifest.json` is an integrity summary, not a second source of document truth. Native readers require the manifest's supported schema, document identity, kind, name, revision, timestamps, and generic asset count to match the persisted document exactly. A malformed or contradictory pair is rejected. A matched schema-1 pair remains supported and migrates to the current schema. Inline asset bytes in `document.json` are ignored: data is hydrated only from its exact `assets/<sha256>` entry after both declared length and SHA-256 match. Missing or corrupt payloads retain their editable metadata with a warning, while invalid asset metadata rejects the container. Writers likewise refuse non-canonical or hash/length-contradictory supplied bytes before atomic replacement; deliberately absent payloads remain recoverable metadata.

Pixel indices and tile GIDs are packed in 32×32 chunks inside `document.json`; ZIP compression makes them compact while keeping migration logic deterministic. Linked project assets store a portable relative path, SHA-256, and embedded cached source. The editor can embed one link, extract an embedded cache to a user-approved relative file, relink to a replacement source, or **Pack Project** to mark every healthy cache embedded. Hash mismatches and missing caches fail closed rather than silently changing project content.

Writers create an exclusive temporary file, flush and close it, reopen and validate the archive and document migration, then atomically rename it over the destination. Detailed undo stacks are session-only; activity, provenance, and transaction traces persist. A separate per-user trace store continues recording while a document is dirty or the editor window is closed, and is merged when the native document is saved or opened.
