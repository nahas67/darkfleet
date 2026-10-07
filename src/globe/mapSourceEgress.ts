import type { MapSourceSpec, MapSourceStatus } from './MapSourceController';
import { MAP_SOURCE_URLS } from './mapSources';

/** Classification describes product ownership, not whether a request succeeded. */
export type EgressClass =
  | 'DECLARED_PROVIDER'
  | 'OPTIONAL_CONFIGURED_PROVIDER'
  | 'UNDECLARED_DEPENDENCY'
  | 'FORBIDDEN';

export type EgressDecision = {
  classification: EgressClass;
  provider: string | null;
  purpose: 'BASEMAP' | null;
  configured: boolean;
  /** The shipped UI where operational provider failures are meant to be reported. */
  statusSurface: 'SYSTEM' | null;
  /** A request is not proof of success; omit a verdict when no controller status was measured. */
  failureState: 'ACTIVE' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'NOT_MEASURED';
};

const undeclared: EgressDecision = {
  classification: 'UNDECLARED_DEPENDENCY',
  provider: null,
  purpose: null,
  configured: false,
  statusSurface: null,
  failureState: 'NOT_MEASURED',
};

/**
 * Attribute a request to a registered *product source*, not a domain whitelist.
 * A request to another service at the same host is still undeclared. A request to
 * a configured provider over plaintext is forbidden even if its path looks right.
 * The browser census supplies the URL, while the source registry supplies ownership.
 */
export function classifyMapEgress(
  rawUrl: string,
  sources: readonly MapSourceSpec[],
  status?: MapSourceStatus | null,
): EgressDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undeclared;
  }

  const source = sources.find((candidate) => {
    if (candidate.id === 'OSM') {
      const registered = new URL(MAP_SOURCE_URLS.OSM);
      return url.hostname === registered.hostname && url.port === registered.port &&
        /^\/[0-9]+\/[0-9]+\/[0-9]+\.png$/.test(url.pathname);
    }
    if (candidate.id === 'ESRI') {
      const registered = new URL(MAP_SOURCE_URLS.ESRI);
      return url.hostname === registered.hostname && url.port === registered.port &&
        /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/[0-9]+\/[0-9]+\/[0-9]+$/.test(url.pathname);
    }
    if (candidate.id === 'ION') {
      // Only the exact asset endpoint configured in mapSources (the same URL the Cesium viewer
      // constructs), not every URL on a Cesium host or an assumed SDK endpoint.
      const registered = new URL(MAP_SOURCE_URLS.ION);
      return url.hostname === registered.hostname && url.port === registered.port &&
        (url.pathname === registered.pathname || url.pathname.startsWith(`${registered.pathname}/`));
    }
    return false;
  });

  if (!source) return undeclared;

  const failureState: EgressDecision['failureState'] = !source.configured
    ? 'NOT_CONFIGURED'
    : !status
      ? 'NOT_MEASURED'
      : status.activeId === source.id
        ? 'ACTIVE'
        : status.attempted.includes(source.id)
          ? 'UNAVAILABLE'
          : 'NOT_MEASURED';

  return {
    classification: url.protocol !== 'https:'
      ? 'FORBIDDEN'
      : !source.configured
        ? 'UNDECLARED_DEPENDENCY'
        : source.id === 'ION'
          ? 'OPTIONAL_CONFIGURED_PROVIDER'
          : 'DECLARED_PROVIDER',
    provider: source.id,
    purpose: 'BASEMAP',
    configured: source.configured,
    statusSurface: 'SYSTEM',
    failureState,
  };
}
