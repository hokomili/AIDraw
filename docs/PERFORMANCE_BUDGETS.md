# Windows v1 performance budgets

`npm run test:performance` is the repeatable non-GUI performance gate. It writes machine-readable evidence to `test-results/performance-gate.json` and fails when a measured budget is exceeded.

| Scenario | Budget |
| --- | ---: |
| Render 5,000 editable vector objects at 1280×720 | 3,000 ms |
| Render four populated 4096×4096 paint layers | 8,000 ms |
| Render a 256×256 map (65,536 visible 8 px tiles) | 5,000 ms |
| Atomically save and validate the 5,000-object native document | 5,000 ms |
| Export that document to PNG | 5,000 ms |
| Account for and slice one million compact playback samples | 500 ms |
| Peak process RSS growth across the gate | 1,200 MiB |

These thresholds are release tripwires, not product targets. The packaged Level 3 Computer Use pass separately measures pointer-to-preview latency, animation frame pacing, human input while four agent lanes are visible, 200% display scaling, and tablet latency; a headless Node test cannot honestly certify those interactions.

Run the gate on the representative Windows 11 x64 release machine with Node 24 and retain the JSON report beside the release evidence. Results from materially slower hardware may be recorded, but changing a budget requires an explicit tracker/documentation update rather than silently widening it in CI.
