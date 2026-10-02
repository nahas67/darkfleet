/**
 * DarkFleet entry point.
 *
 * One entry, one visible product generation. There is no legacy path and no
 * fallback shell: the retired UI was deleted rather than parked.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './design/tokens.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { DarkFleetCommandApp } from './command/DarkFleetCommandApp';
import { ErrorBoundary } from './command/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('DarkFleet: #root is missing from the document.');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <DarkFleetCommandApp />
    </ErrorBoundary>
  </StrictMode>,
);