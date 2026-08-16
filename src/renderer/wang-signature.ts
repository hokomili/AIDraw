import type { WangSet } from "@aidraw/core";

export type WangSignatureSlotIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WANG_SIGNATURE_SLOTS: ReadonlyArray<{
  index: WangSignatureSlotIndex;
  label: string;
  kind: "edge" | "corner";
  position: string;
}> = [
  { index: 0, label: "Top edge", kind: "edge", position: "top" },
  { index: 1, label: "Top-right corner", kind: "corner", position: "top-right" },
  { index: 2, label: "Right edge", kind: "edge", position: "right" },
  { index: 3, label: "Bottom-right corner", kind: "corner", position: "bottom-right" },
  { index: 4, label: "Bottom edge", kind: "edge", position: "bottom" },
  { index: 5, label: "Bottom-left corner", kind: "corner", position: "bottom-left" },
  { index: 6, label: "Left edge", kind: "edge", position: "left" },
  { index: 7, label: "Top-left corner", kind: "corner", position: "top-left" },
];

export function withWangSignatureSlot(
  wangId: WangSet["tiles"][number]["wangId"],
  slot: WangSignatureSlotIndex,
  colorId: number,
): WangSet["tiles"][number]["wangId"] {
  const next = [...wangId] as WangSet["tiles"][number]["wangId"];
  next[slot] = colorId;
  return next;
}

export function wangColorChoiceLabel(color: WangSet["colors"][number]): string {
  return `${color.name} · color ${color.id}`;
}
