# Windows v1 performance budgets

`npm run test:performance` is the repeatable non-GUI performance gate. It writes machine-readable evidence to `test-results/performance-gate.json` and fails when a measured budget is exceeded.

| Scenario | Budget |
| --- | ---: |
| Render 5,000 editable vector objects at 1280×720 | 3,000 ms |
| Select those 5,000 vector objects through canonical lasso geometry | 1,000 ms |
| Render four populated 4096×4096 paint layers | 8,000 ms |
| Cold-render four materialized sparse 4096×4096 paint layers | 8,000 ms |
| Warm-render four materialized sparse 4096×4096 paint layers | 3,000 ms |
| Render a 256×256 map (65,536 visible 8 px tiles from an 8192×8192 sparse source) | 5,000 ms |
| Render one requested pixel from a map with 4,096 stored chunks | 100 ms |
| Composite one requested pixel from a sprite cel with 4,096 stored chunks | 100 ms |
| Filter 100,000 projected map objects to one requested raster region | 500 ms |
| Atomically save and validate the 5,000-object native document | 5,000 ms |
| Export that document to PNG | 5,000 ms |
| Account for and slice one million compact playback samples | 500 ms |
| Find and compact a one-million-cell flood-fill region | 2,000 ms |
| Peak process RSS growth across the gate | 1,200 MiB |

The illustration-lasso scenario reuses the exact 5,000-object vector fixture, encloses every object with one four-point polygon, and requires the canonical geometry planner to return all 5,000 IDs in document order. It includes Paper.js fill-geometry construction/intersection and project cleanup, but not dynamic module loading or packaged pointer dispatch. The regional-map scenario builds 4,096 canonical 32×32 chunks spread across a 2,048×2,048 nominal map, requests the one-pixel region containing the final stored cell, and measures only production regional rendering. It trips if bounded observation regresses toward decoding/scanning every stored chunk payload; the deliberate O(total chunks) geometry scan remains inside the measurement and is not represented as a spatial index. The regional-sprite scenario builds the same 4,096-chunk distribution in one canonical cel and measures the shared production compositor used by editor base/onion/wrap frames. The object scenario constructs the canonical 100,000-object ceiling as spaced rectangles and requires the shared projected-bounds filter to retain only the final object, preserving order. All retain setup memory inside RSS; these Node metrics do not certify browser paint or packaged frame pacing. The flood scenario builds a real 1,000×1,000 indexed cel through canonical row-run storage, reads it through the cached production chunk reader, and requires exactly 1,000 output runs and 1,000,000 changed cells. Setup is outside each timing, but its memory remains inside the RSS gate.

These thresholds are release tripwires, not product targets. The packaged Level 3 Computer Use pass separately measures pointer-to-preview latency, animation frame pacing, human input while four agent lanes are visible, 200% display scaling, and tablet latency; a headless Node test cannot honestly certify those interactions.

The gate samples RSS after each completed scenario, then releases that scenario's returned native canvas before beginning the next independent workload. This preserves the completed-operation high-water while avoiding an artificial accumulation of unused 4096×4096 outputs. The report includes stage-level RSS, heap, external, array-buffer, and process-high-water diagnostics so a budget failure can be attributed instead of hidden by a threshold change.

Apple Silicon investigation on 2026-08-09 reproduced the former failure at 1,378.50 MiB. Stage diagnostics showed native canvas allocation growth while JavaScript heap stayed below 60 MiB. Reusing bounded scratch/tile canvases and releasing each completed scenario's returned native canvas reduced five fresh-process runs to 744.98, 753.14, 737.78, 736.13, and 744.58 MiB. Every run and timing passed. This is useful local macOS evidence against the existing gate; it does not redefine the Windows budget or replace packaged interaction measurements.

Run the gate on the representative Windows 11 x64 release machine with Node 24 and retain the JSON report beside the release evidence. Results from materially slower hardware may be recorded, but changing a budget requires an explicit tracker/documentation update rather than silently widening it in CI.
