# PDF fixture provenance

## `libreoffice-clipped-transparency.pdf`

This one-page fixture covers a single compatibility case: a LibreOffice Draw
PDF containing clipped overlapping transparency, a gradient, and three text
runs. The checked-in SVG is the project-owned authoring source; the PDF is the
unchanged output of the third-party producer.

- Producer: LibreOfficeDev 26.8.0.0.alpha0, AARCH64, Draw PDF export
- Generated offline: 2026-08-11
- PDF identity: 27,332 bytes, SHA-256
  `829ec316be8eddc2e35b9e88e232c3debc8776e573082f7bfe8c147d1c475e19`
- Page: one unrotated 240.746 x 150.746 pt page (241 x 151 pixels at 72 dpi)
- Reference renderer: Poppler `pdftoppm` 26.05.0, PNG at 72 dpi
- Golden identity: 21,887 bytes, SHA-256
  `44a8335475cac323623d9d99723d8519c8007cc7725dcfaf1523209e9a65eaa0`

The source was exported with:

```sh
soffice --headless --convert-to pdf --outdir tests/fixtures/pdf \
  tests/fixtures/pdf/libreoffice-clipped-transparency.svg
pdftoppm -png -r 72 -singlefile \
  tests/fixtures/pdf/libreoffice-clipped-transparency.pdf \
  tests/fixtures/pdf/libreoffice-clipped-transparency-poppler
```

The golden is an independent visual oracle, not an expected byte-for-byte
pdf.js rendering. The regression uses bounded per-channel differences to allow
renderer antialiasing while still detecting lost clipping, alpha compositing,
geometry, or page-background fidelity. It does not claim editable PDF operator
import, other LibreOffice versions, multi-page behavior, or broad PDF fidelity.

The same fixture also gates AIDraw PDF re-export. The importer marks only its
hidden extracted-text layer with the typed `pdf-extracted-text` interchange
role. Supported runs from that layer are written once as invisible searchable
text; a same-named hidden layer without the role stays omitted, and unsupported
glyphs or transforms produce explicit loss warnings instead of visible raster
duplicates. The runtime re-export is checked semantically and visually rather
than by byte hash because `pdf-lib` writes creation/modification timestamps.
