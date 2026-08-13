import type { PixelTileset } from '@aidraw/core';

export interface TileTransformFlags {
  hFlip: boolean;
  vFlip: boolean;
  diagonal: boolean;
}

export interface TileTransformChoice {
  id: 'identity' | 'h' | 'v' | 'hv' | 'd' | 'dh' | 'dv' | 'dhv';
  shortLabel: string;
  label: string;
  flags: TileTransformFlags;
}

export const TILE_TRANSFORM_CHOICES: readonly TileTransformChoice[] = [
  { id: 'identity', shortLabel: '—', label: 'Original', flags: { hFlip: false, vFlip: false, diagonal: false } },
  { id: 'h', shortLabel: 'H', label: 'Horizontal', flags: { hFlip: true, vFlip: false, diagonal: false } },
  { id: 'v', shortLabel: 'V', label: 'Vertical', flags: { hFlip: false, vFlip: true, diagonal: false } },
  { id: 'hv', shortLabel: 'H+V', label: 'Horizontal + vertical', flags: { hFlip: true, vFlip: true, diagonal: false } },
  { id: 'd', shortLabel: 'D', label: 'Diagonal', flags: { hFlip: false, vFlip: false, diagonal: true } },
  { id: 'dh', shortLabel: 'D+H', label: 'Diagonal + horizontal', flags: { hFlip: true, vFlip: false, diagonal: true } },
  { id: 'dv', shortLabel: 'D+V', label: 'Diagonal + vertical', flags: { hFlip: false, vFlip: true, diagonal: true } },
  { id: 'dhv', shortLabel: 'D+H+V', label: 'Diagonal + horizontal + vertical', flags: { hFlip: true, vFlip: true, diagonal: true } },
] as const;

export function tileTransformChoiceAllowed(
  choice: TileTransformChoice,
  permissions: PixelTileset['transformations'],
): boolean {
  return tileTransformFlagsAllowed(choice.flags, permissions);
}

/**
 * Tiled exposes geometric capabilities, while its GID stores three rendering
 * flags. In particular, a quarter turn is encoded as diagonal + one flip and
 * a half turn as both flips. Treating each stored bit as an independent
 * permission would therefore reject permitted rotations and admit a diagonal
 * reflection when only rotation is enabled.
 */
export function tileTransformFlagsAllowed(
  flags: TileTransformFlags,
  permissions: PixelTileset['transformations'],
): boolean {
  const id = tileTransformChoiceId(flags);
  if (id === 'identity') return true;
  if (id === 'h') return permissions.hFlip || (permissions.rotate && permissions.vFlip);
  if (id === 'v') return permissions.vFlip || (permissions.rotate && permissions.hFlip);
  if (id === 'hv') return permissions.rotate || (permissions.hFlip && permissions.vFlip);
  if (id === 'dh' || id === 'dv') return permissions.rotate;
  return permissions.rotate && (permissions.hFlip || permissions.vFlip);
}

export function constrainTileTransformFlags(
  flags: TileTransformFlags,
  permissions?: PixelTileset['transformations'],
): TileTransformFlags {
  if (!permissions) return { hFlip: false, vFlip: false, diagonal: false };
  return tileTransformFlagsAllowed(flags, permissions)
    ? { ...flags }
    : { hFlip: false, vFlip: false, diagonal: false };
}

export function tileTransformChoiceId(flags: TileTransformFlags): TileTransformChoice['id'] {
  return TILE_TRANSFORM_CHOICES.find((choice) => choice.flags.hFlip === flags.hFlip
    && choice.flags.vFlip === flags.vFlip
    && choice.flags.diagonal === flags.diagonal)?.id ?? 'identity';
}
