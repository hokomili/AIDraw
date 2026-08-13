# Raster interchange fixture

`exif-orientation-6.jpeg.base64` is a locally generated 24×16 baseline JPEG
containing four solid quadrants, followed by one bounded EXIF APP1 segment whose
IFD0 orientation is `6` (90° clockwise for display). The decoded display is
16×24 with blue, red, yellow, and green quadrants in reading order.

- Encoded JPEG bytes: 948
- SHA-256: `127b13e4ae8a15d43738a0c221d364b019bfb548b66f01c7cdb1e40bc599a3a6`
- Generator: pinned `@napi-rs/canvas` 1.0.3 JPEG encoder at quality 100; the EXIF
  segment is the fixed byte sequence asserted in `raster-interchange.test.ts`
- Storage: canonical base64 text so the fixture remains patch-reviewable; tests
  remove ASCII whitespace before decoding it to a temporary `.jpg`

This fixture proves only AIDraw's standalone JPEG import behavior for one
well-formed EXIF orientation-6 file and the shared bounded orientation parser.
It is not a camera/vendor color-management corpus, malformed-EXIF policy,
metadata-preserving JPEG exporter, sprite-sheet/Tiled coordinate convention, or
broad JPEG compatibility certificate.
