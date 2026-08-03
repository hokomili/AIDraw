import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RendererErrorBoundary } from './RendererErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
