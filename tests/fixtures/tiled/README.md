# Tiled interchange fixtures

These small, hand-authored Tiled 1.10 / Tiled 1.11.2 fixtures are deterministic regression inputs, not exports certified by a particular Tiled binary.

- `isometric-external.tmj` references `terrain.tsj` and covers external JSON tileset loading, typed properties, ordered three-frame tile animation, probability, collision metadata, Wang metadata, transforms, and nested layers.
- `orthogonal-external.tmx` references `terrain.tsx.fixture` and covers the corresponding inline-XML parser path with an ordered two-frame animation. Tests copy the latter to `terrain.tsx`; the `.fixture` suffix keeps repository TypeScript tooling from treating XML as source code.

Neither tileset declares a source image. AIDraw therefore builds the bounded blank source sprite defined by the tileset geometry, and production re-export writes its normal PNG companion. Round-trip tests assert the exact supported metadata order/types and collision geometry after re-import. They do not establish image-collection tilesets, arbitrary Tiled extensions, packaged editor interaction, or broad Tiled compatibility.
