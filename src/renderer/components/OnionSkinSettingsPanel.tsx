import { RotateCcw, X } from 'lucide-react';
import { EDITOR_DENSITY } from '../../common/editor-layout';
import { DEFAULT_ONION_SKIN_SETTINGS, MAX_ONION_SKIN_FRAMES_PER_SIDE, type OnionSkinSettings } from '../../common/onion-skin';

interface OnionSkinSettingsPanelProps {
  settings: OnionSkinSettings;
  onChange(settings: OnionSkinSettings): void;
  onClose(): void;
}

export function OnionSkinSettingsPanel({ settings, onChange, onClose }: OnionSkinSettingsPanelProps) {
  const countOptions = Array.from({ length: MAX_ONION_SKIN_FRAMES_PER_SIDE + 1 }, (_, value) => value);
  const update = <K extends keyof OnionSkinSettings>(key: K, value: OnionSkinSettings[K]) => onChange({ ...settings, [key]: value });
  return <section id="onion-skin-settings" className="onion-settings-panel" aria-label="Onion skin settings">
    <header><span><strong>Onion skin</strong><small>Saved locally across restarts · shared by pixel documents · document pixels do not change</small></span><button type="button" aria-label="Close onion skin settings" onClick={onClose}><X size={EDITOR_DENSITY.secondaryIcon} /></button></header>
    <div className="onion-settings-columns">
      <fieldset><legend>Previous frames</legend>
        <label><span>Count</span><select value={settings.previousFrames} onChange={(event) => update('previousFrames', Number(event.target.value))}>{countOptions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Tint</span><input aria-label="Previous onion tint" type="color" value={settings.previousTint} onChange={(event) => update('previousTint', event.target.value)} /></label>
        <label className="onion-opacity"><span>Opacity</span><input aria-label="Previous onion opacity" type="range" min="0" max="1" step="0.01" value={settings.previousOpacity} onChange={(event) => update('previousOpacity', Number(event.target.value))} /><output>{Math.round(settings.previousOpacity * 100)}%</output></label>
      </fieldset>
      <fieldset><legend>Next frames</legend>
        <label><span>Count</span><select value={settings.nextFrames} onChange={(event) => update('nextFrames', Number(event.target.value))}>{countOptions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Tint</span><input aria-label="Next onion tint" type="color" value={settings.nextTint} onChange={(event) => update('nextTint', event.target.value)} /></label>
        <label className="onion-opacity"><span>Opacity</span><input aria-label="Next onion opacity" type="range" min="0" max="1" step="0.01" value={settings.nextOpacity} onChange={(event) => update('nextOpacity', Number(event.target.value))} /><output>{Math.round(settings.nextOpacity * 100)}%</output></label>
      </fieldset>
    </div>
    <footer><small>Farther frames fade as base opacity ÷ distance and render behind nearer frames.</small><button type="button" onClick={() => onChange({ ...DEFAULT_ONION_SKIN_SETTINGS })}><RotateCcw size={EDITOR_DENSITY.secondaryIcon} /> Reset</button></footer>
  </section>;
}
