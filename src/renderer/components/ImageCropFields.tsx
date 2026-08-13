import { useState, type FormEvent } from 'react';
import type { ImageObject } from '@aidraw/core';
import { imageSourceBounds, setImageSourceCrop, type CropRectangle } from '../../common/image-crop';

type CropField = keyof CropRectangle;

export function ImageCropFields({ object, onApply }: { object: ImageObject; onApply: (object: ImageObject) => void }) {
  const bounds = imageSourceBounds(object);
  const initial = object.crop ?? bounds;
  const [draft, setDraft] = useState<Record<CropField, string>>({
    x: String(initial.x),
    y: String(initial.y),
    width: String(initial.width),
    height: String(initial.height),
  });
  const [error, setError] = useState<string>();
  const update = (field: CropField, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const value = (field: CropField) => draft[field].trim() === '' ? Number.NaN : Number(draft[field]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    try {
      onApply(setImageSourceCrop(object, {
        x: value('x'),
        y: value('y'),
        width: value('width'),
        height: value('height'),
      }));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <form className="crop-numeric-form" aria-label="Numeric source image crop" noValidate onSubmit={apply}>
      <div className="crop-numeric-grid">
        {([['x', 'Source X'], ['y', 'Source Y'], ['width', 'Source width'], ['height', 'Source height']] as const).map(([field, label]) => (
          <label key={field}>
            <span>{label}</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={draft[field]}
              onChange={(event) => update(field, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="crop-numeric-actions">
        <small>Full source: {bounds.width} × {bounds.height} px · fractional coordinates are preserved.</small>
        <button type="submit">Apply source crop</button>
      </div>
      {error && <small className="crop-numeric-error" role="alert">{error}</small>}
    </form>
  );
}
