import { useId, type CSSProperties } from "react";
import type { WangSet } from "@aidraw/core";
import {
  WANG_SIGNATURE_SLOTS,
  wangColorChoiceLabel,
  type WangSignatureSlotIndex,
} from "../wang-signature";

interface WangSignatureEditorProps {
  tileId: number;
  wangId: WangSet["tiles"][number]["wangId"];
  colors: WangSet["colors"];
  onChange: (slot: WangSignatureSlotIndex, colorId: number) => void;
}

function signatureSelections(wangId: WangSignatureEditorProps["wangId"], colors: WangSignatureEditorProps["colors"]) {
  return WANG_SIGNATURE_SLOTS.map((slot) => {
    const colorId = wangId[slot.index];
    const color = colors.find((entry) => entry.id === colorId);
    return {
      color,
      colorId,
      label: colorId === 0
        ? "None"
        : color
          ? wangColorChoiceLabel(color)
          : `Unavailable color ${colorId}`,
    };
  });
}

export function WangSignatureFields({ tileId, wangId, colors, onChange }: WangSignatureEditorProps) {
  const selectedColors = signatureSelections(wangId, colors);
  return (
    <div className="wang-signature-fields" role="group" aria-label={`Tile ${tileId} Wang signature colors`}>
      {WANG_SIGNATURE_SLOTS.map((slot) => {
        const selection = selectedColors[slot.index];
        return (
          <label className={`wang-signature-slot is-${slot.kind}`} key={slot.index}>
            <span className="wang-signature-slot-heading">
              <strong>{slot.index + 1}. {slot.label}</strong>
              <em>{slot.kind === "edge" ? "Edge" : "Corner"}</em>
            </span>
            <select
              aria-label={`Tile ${tileId}, slot ${slot.index + 1}, ${slot.label}, Wang color`}
              title={`Current choice: ${selection.label}`}
              value={selection.colorId}
              onChange={(event) => onChange(slot.index, Number(event.currentTarget.value))}
            >
              <option value={0}>None</option>
              {colors.map((color) => <option key={color.id} value={color.id}>{wangColorChoiceLabel(color)}</option>)}
            </select>
            <span className="wang-signature-current">
              <i
                aria-hidden="true"
                className={selection.colorId === 0 ? "is-none" : ""}
                style={{ "--wang-slot-color": selection.color?.color ?? "transparent" } as CSSProperties}
              />
              <span>Current: {selection.label}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function WangSignatureEditor({
  tileId,
  wangId,
  colors,
  onChange,
}: WangSignatureEditorProps) {
  const headingId = useId();
  const helpId = useId();
  const selectedColors = signatureSelections(wangId, colors);

  return (
    <section className="wang-signature-editor" aria-labelledby={headingId} aria-describedby={helpId}>
      <div className="section-heading wang-signature-heading">
        <span id={headingId}>Tile {tileId} Wang signature</span>
        <small>8 slots · clockwise</small>
      </div>
      <figure className="wang-signature-figure">
        <div
          className="wang-signature-diagram"
          role="img"
          aria-label={`Tile ${tileId} Wang signature diagram. Line markers are edges, diamond markers are corners, and slots 1 through 8 run clockwise from the top edge.`}
        >
          {WANG_SIGNATURE_SLOTS.map((slot) => {
            const selection = selectedColors[slot.index];
            return (
              <span
                aria-hidden="true"
                className={`wang-signature-node is-${slot.kind} is-${slot.position}${selection.colorId === 0 ? " is-none" : ""}`}
                key={slot.index}
                style={{ "--wang-slot-color": selection.color?.color ?? "transparent" } as CSSProperties}
              >
                <i className="wang-signature-marker" />
                <strong>{slot.index + 1}</strong>
                <small>{slot.kind === "edge" ? "Edge" : "Corner"}</small>
              </span>
            );
          })}
          <span className="wang-signature-legend" aria-hidden="true">
            <strong>Signature</strong>
            <span><i className="is-edge" /> Edge</span>
            <span><i className="is-corner" /> Corner</span>
          </span>
        </div>
        <figcaption id={helpId}>Line markers identify edges; diamond markers identify corners. Slots 1–8 run clockwise from the top edge.</figcaption>
      </figure>
      <WangSignatureFields tileId={tileId} wangId={wangId} colors={colors} onChange={onChange} />
    </section>
  );
}
