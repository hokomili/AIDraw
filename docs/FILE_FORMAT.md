# Native file format

An `.aidraw` file is a ZIP container. Paths are UTF-8 and schema migrations are application-owned.

| Entry | Purpose |
| --- | --- |
| `manifest.json` | Format/schema identity, document metadata, revision, asset count, saving app version |
| `document.json` | Illustration or pixel document model without machine-local `filePath` or inline asset bytes |
| `assets/<sha256>` | Deduplicated imported/generated/rendered bytes, including sparse illustration paint tiles |
| `activity.json` | Persistent attribution/activity summary |
| `trace/transactions.jsonl` | Complete append-only attributed transactions for inspection and replay |
| `checkpoints/index.json` | Ordered summaries for at most the newest 32 named checkpoints |
| `checkpoints/<id>.json` | One attributed checkpoint summary plus its captured editable document |
| `preview.png` | Rendered current-document preview |

`document.json` is canonical; `manifest.json` is an integrity summary, not a second source of document truth. Native readers require the manifest's supported schema, document identity, kind, name, revision, timestamps, and generic asset count to match the persisted document exactly. A malformed or contradictory pair is rejected. A matched schema-1 pair remains supported and migrates to the current schema. Inline asset bytes in `document.json` are ignored: data is hydrated only from its exact `assets/<sha256>` entry after both declared length and SHA-256 match. Missing or corrupt payloads retain their editable metadata with a warning, while invalid asset metadata rejects the container. Writers likewise refuse non-canonical or hash/length-contradictory supplied bytes before atomic replacement; deliberately absent payloads remain recoverable metadata.

Each `trace/transactions.jsonl` record is one compact version-1 writer envelope containing exact document/revision/timestamp/outcome metadata and one canonical transaction for the same document. Trace transactions retain the editor's existing 2 MiB serialized ceiling. Native and local-store readers ignore malformed, cross-document, or oversized records before inspection/replay; native open emits one aggregate warning without rejecting otherwise recoverable artwork. Writers reject an invalid supplied trace before atomic replacement. Valid history is not truncated by this policy and native import appends accepted records to the durable store in one batch.

The reader considers only the newest 32 checkpoint summaries. Each selected summary and its named payload must independently match the exact seven-field metadata contract—safe ID, current document ID, nonblank name, canonical UTC timestamp, schema-valid actor, nonnegative safe source revision, and manual/automatic kind—and those values must agree exactly. The migrated checkpoint document must carry the same document ID and source revision. Duplicate selected IDs and malformed summaries are ignored with an entry warning; missing or corrupt payloads exclude only that checkpoint so the main document and valid siblings remain recoverable. The writer applies the same checks and rejects invalid, inconsistent, or duplicate supplied checkpoints before atomic replacement. Persisted names deliberately do not inherit the 80-character manual-entry limit because repeated restore-generated safety names can be longer.

Pixel indices and tile GIDs are packed in 32×32 chunks inside `document.json`; ZIP compression makes them compact while keeping migration logic deterministic. Linked project assets store a portable relative path, SHA-256, and embedded cached source. The editor can embed one link, extract an embedded cache to a user-approved relative file, relink to a replacement source, or **Pack Project** to mark every healthy cache embedded. Hash mismatches and missing caches fail closed rather than silently changing project content.

Writers create an exclusive temporary file, flush and close it, reopen and validate the archive and document migration, then atomically rename it over the destination. Detailed undo stacks are session-only; activity, provenance, and transaction traces persist. A separate per-user trace store continues recording while a document is dirty or the editor window is closed, and is merged when the native document is saved or opened.
