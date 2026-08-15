import type { SpriteSymmetryMode } from '../../common/sprite-symmetry';

interface SpriteSymmetrySettingsPanelProps {
  mode: SpriteSymmetryMode;
  horizontalAxis: number;
  verticalAxis: number;
  width: number;
  height: number;
  source: 'saved' | 'centered-default';
  onModeChange(mode: SpriteSymmetryMode): void;
  onAxesChange(horizontalAxis: number, verticalAxis: number): void;
  onClose(): void;
}

export function SpriteSymmetrySettingsPanel({
  mode,
  horizontalAxis,
  verticalAxis,
  width,
  height,
  source,
  onModeChange,
  onAxesChange,
  onClose,
}: SpriteSymmetrySettingsPanelProps) {
  const centeredHorizontal = (width - 1) / 2;
  const centeredVertical = (height - 1) / 2;
  const updateAxis = (axis: 'horizontal' | 'vertical', input: HTMLInputElement) => {
    const value = input.value;
    const parsed = Number(value);
    const limit = axis === 'horizontal' ? width - 1 : height - 1;
    if (!value.trim() || !Number.isFinite(parsed) || !Number.isSafeInteger(parsed * 2) || parsed < 0 || parsed > limit) {
      input.value = String(axis === 'horizontal' ? horizontalAxis : verticalAxis);
      return;
    }
    onAxesChange(axis === 'horizontal' ? parsed : horizontalAxis, axis === 'vertical' ? parsed : verticalAxis);
  };
  return (
    <section id="sprite-symmetry-settings" className="sprite-symmetry-settings" aria-label="Sprite symmetry settings">
      <header><span><strong>Symmetry axes</strong><small>Human-local · half-pixel grid</small></span><button type="button" onClick={onClose} aria-label="Close symmetry settings">×</button></header>
      <label><span>Mode</span><select aria-label="Sprite symmetry mode" value={mode} onChange={(event) => onModeChange(event.target.value as SpriteSymmetryMode)}><option value="none">None</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option><option value="both">Both</option></select></label>
      <label><span>Horizontal axis X</span><input aria-label="Horizontal symmetry axis X" type="number" min={0} max={width - 1} step={0.5} value={horizontalAxis} onChange={(event) => updateAxis('horizontal', event.currentTarget)} /></label>
      <label><span>Vertical axis Y</span><input aria-label="Vertical symmetry axis Y" type="number" min={0} max={height - 1} step={0.5} value={verticalAxis} onChange={(event) => updateAxis('vertical', event.currentTarget)} /></label>
      <button type="button" onClick={() => onAxesChange(centeredHorizontal, centeredVertical)} disabled={horizontalAxis === centeredHorizontal && verticalAxis === centeredVertical}>Center both axes</button>
      <p>{source === 'saved' ? `Custom axes for this ${width} × ${height} sprite.` : `Centered defaults for this ${width} × ${height} sprite.`} Axes use pixel-center coordinates and do not change artwork; a warning reports any save failure.</p>
    </section>
  );
}
