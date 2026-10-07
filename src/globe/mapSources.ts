/**
 * The configured basemap source registry.
 *
 * ONE LIST, ONE OWNER
 *
 * Previously `cesiumViewer.ts` hardcoded a single OpenStreetMap provider inline and
 * kept its own separate list from any controller, which is how the product ended up
 * with a `MapSourceController` in tests and a different basemap in the application.
 * The registry is now declared once here, in preference order, and the controller
 * consumes exactly this list.
 *
 * NO CREDENTIAL IS REQUIRED TO START (§27)
 *
 * The first entry is keyless. A commercial or token source is an ADDITION: it is
 * marked `configured: false` when its key is absent, the controller skips it, and
 * DarkFleet still opens a usable globe. Nothing here can make a paid provider
 * load-bearing, because `configured` is derived from the key's presence rather than
 * from a flag someone has to remember to flip.
 *
 * ATTRIBUTION IS PART OF THE SPEC, NOT A STRING (§21)
 *
 * Every source carries the credit its terms require, and the credit travels with the
 * source. `cesiumViewer` renders the ACTIVE source's credit, so a provider swap cannot
 * leave the previous provider's name on screen.
 */

import type { MapSourceSpec } from './MapSourceController';

/** Reads a key from the environment, tolerating an absent import.meta.env. */
function key(name: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * OpenStreetMap standard tiles -- the required keyless fallback.
 *
 * ODbL. The attribution is required by the licence and is the reason the credit
 * container is restored in `cesiumViewer.ts`; `creditContainer: undefined` was
 * disabling it, which is a licence failure rather than a missing nicety.
 *
 * Tile usage policy: fine for local, low-volume use. Not a production traffic
 * target.
 */
const OPENSTREETMAP = 'https://tile.openstreetmap.org/';

/**
 * Esri World Imagery -- stronger satellite context, no key required for the public
 * endpoint.
 *
 * Secondary by policy (§10): a better basemap where licence and access allow, never a
 * prerequisite. Its terms are not a Creative Commons licence, so its credit is carried
 * verbatim and it is not redistributed or cached.
 */
const ESRI_WORLD_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/**
 * Build the source registry.
 *
 * Provider CONSTRUCTION is injected as a factory so this module declares intent --
 * order, availability, credit -- while `cesiumViewer.ts` supplies the Cesium objects.
 * That split is what lets the controller be tested without Cesium and keeps this file
 * free of an import that cannot resolve in a node test environment.
 */
export function buildMapSources(
  create: (kind: 'OSM' | 'ESRI' | 'ION') => unknown,
): MapSourceSpec[] {
  const ionKey = key('VITE_CESIUM_ION_TOKEN');

  return [
    {
      id: 'OSM',
      label: 'OpenStreetMap',
      // Required by ODbL. Rendered by the credit container.
      attribution: '© OpenStreetMap contributors',
      configured: true,
      create: () => create('OSM'),
    },
    {
      id: 'ESRI',
      label: 'Esri World Imagery',
      attribution: 'Esri, Maxar, Earthstar Geographics',
      configured: true,
      create: () => create('ESRI'),
    },
    {
      id: 'ION',
      label: 'Cesium ion',
      // Absent a token this is NOT_CONFIGURED, not UNAVAILABLE: it was never
      // available to be unavailable. The distinction is preserved in the notice.
      configured: ionKey !== undefined,
      attribution: 'Cesium ion',
      create: () => create('ION'),
    },
  ];
}

/** Tile template per provider, for the viewer to build its imagery provider. */
export const MAP_SOURCE_URLS: Readonly<Record<'OSM' | 'ESRI' | 'ION', string>> = {
  OSM: OPENSTREETMAP,
  ESRI: ESRI_WORLD_IMAGERY,
  // Keep the optional ion endpoint in the SAME owner registry as the URL passed to Cesium.
  // An egress classifier copying the wrong SDK endpoint would classify the real provider as
  // undeclared even though the product intentionally configured it.
  ION: 'https://assets.cesium.com/us/rest/1.0/assets/2/imagery/2023_07_28',
};

/** Fallback order, asserted against the controller's own behaviour in tests. */
export const MAP_SOURCE_ORDER = ['OSM', 'ESRI', 'ION'] as const;

export type MapSourceId = (typeof MAP_SOURCE_ORDER)[number];

/**
 * Narrow an arbitrary string to a declared source id.
 *
 * The runtime guard the UI needs. A source id that reaches the controller undeclared
 * would be silently ignored, so a typo in a selector would look like a dead control.
 */
export function isMapSourceId(id: string): id is MapSourceId {
  return (MAP_SOURCE_ORDER as readonly string[]).includes(id);
}