import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EDITOR_DENSITY } from '../../src/common/editor-layout';
import { DEFAULT_ONION_SKIN_SETTINGS, MAX_ONION_SKIN_FRAMES_PER_SIDE } from '../../src/common/onion-skin';
import { OnionSkinSettingsPanel } from '../../src/renderer/components/OnionSkinSettingsPanel';

describe('onion skin settings', () => {
  it('renders bounded independent controls and states their session-only effect', () => {
    const markup = renderToStaticMarkup(createElement(OnionSkinSettingsPanel, {
      settings: { ...DEFAULT_ONION_SKIN_SETTINGS },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('aria-label="Onion skin settings"');
    expect(markup).toContain('Session preview · use Onion to show · document pixels do not change');
    expect(markup).toContain('Previous onion tint');
    expect(markup).toContain('Next onion tint');
    expect(markup).toContain('Previous onion opacity');
    expect(markup).toContain('Next onion opacity');
    expect(markup.match(/<option/g)).toHaveLength((MAX_ONION_SKIN_FRAMES_PER_SIDE + 1) * 2);
    expect(markup).toContain('Farther frames fade as base opacity ÷ distance and render behind nearer frames.');
    expect(markup).toContain('Reset');
    expect(markup.match(new RegExp(`width="${EDITOR_DENSITY.secondaryIcon}"`, 'g'))).toHaveLength(2);
    expect(markup).not.toMatch(/width="(?:11|13)"/);
  });

  it('wires the bounded planner and session panel without the former hard-coded neighbor draws', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onionSkinLayers(sprite.frameIds, activeFrameId, onionSettings)');
    expect(source).toContain('const [onionSettings, setOnionSettings] = useState<OnionSkinSettings>');
    expect(source).toContain('<OnionSkinSettingsPanel settings={onionSettings}');
    expect(source).toContain('onChange={setOnionSettings}');
    expect(source).toContain('Configure bounded onion skin frames, tint, and opacity');
    expect(source).toContain('setExposureGridOpen(false)');
    expect(source).toContain('setOnionSettingsOpen(false)');
    expect(source).not.toContain("drawFrame(sprite.frameIds[index - 1], 0.22");
    expect(source).not.toContain("drawFrame(sprite.frameIds[index + 1], 0.18");
  });
});
