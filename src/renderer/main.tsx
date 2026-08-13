import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RendererErrorBoundary } from './RendererErrorBoundary';
import { ensureBundledBrowserCanvasFonts } from './canvas-fonts';
import './styles.css';

const nativeTitlebar = new URL(window.location.href).searchParams.get('native-titlebar');
if (nativeTitlebar === 'hidden-inset') document.documentElement.dataset.nativeTitlebar = nativeTitlebar;

async function bootstrap(): Promise<void> {
  try { await ensureBundledBrowserCanvasFonts(); }
  catch (error) { console.error('Could not load AIDraw bundled Canvas fonts.', error); }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RendererErrorBoundary>
        <App />
      </RendererErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
