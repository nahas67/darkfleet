/**
 * How a local reference dataset's state should READ.
 *
 * PURE FORMATTERS. The fetching lives in `client.loadDatasetHealth` and the value lives in
 * `store.datasetHealth`, because TWO panels need it and as two independent hook instances they
 * issued two requests for one fact -- and could disagree.
 *
 * That disagreement was observed, not theorised: the DF-X8.5 browser E2E opened LAYERS
 * immediately after SYSTEM and found the coastline toggle disabled with "the store has not
 * been read yet" while the system panel had rendered the whole dataset list seconds earlier.
 * An operator seeing both panels would conclude the console was broken.
 *
 * Mirrors `providers` / `loadProviders`, which already work this way for remote source health.
 *
 * WHY THREE AXES AND NOT ONE WORD
 * ------------------------------
 *   install_status   what is on disk
 *   usable           whether a query may read it
 *   blocker_reason   why it is absent, when it is
 *
 * A single merged word would have to say either "OK" for a dataset with no publisher checksum
 * recorded, or "unverified" for one that answers correctly. Both are wrong.
 */

import type { DatasetHealthEntry } from '../api/contract';

/**
 * How an entry's install state should read.
 *
 * `CHECKSUM_UNRECORDED` is deliberately NOT collapsed into "verified". The data parses and
 * answers correctly, and the publisher published no checksum to check against -- which is a
 * weaker guarantee that must stay legible, because "unverified" read as "verified" is exactly
 * the substitution this product refuses.
 */
export function installStatusLabel(entry: DatasetHealthEntry): string {
  switch (entry.install_status) {
    case 'READY':
      return 'INSTALLED / VERIFIED';
    case 'CHECKSUM_UNRECORDED':
      return 'INSTALLED / NO PUBLISHER CHECKSUM';
    case 'NOT_INSTALLED':
      return entry.optional ? 'NOT INSTALLED (OPTIONAL)' : 'NOT INSTALLED';
    case 'CHECKSUM_MISMATCH':
      return 'CHECKSUM MISMATCH';
    case 'INVALID':
      return 'PRESENT BUT UNREADABLE';
    case 'VERSION_UNKNOWN':
      return 'UNKNOWN VERSION ON DISK';
    default:
      return entry.install_status.replace(/_/g, ' ');
  }
}

/**
 * The version string to display, or null when it was never established.
 *
 * A null here is meaningful, and the caller must then show the retrieval timestamp instead. A
 * service snapshot whose publisher publishes no per-layer version must not be labelled with
 * one -- and specifically must not inherit "v12" from a separate bulk release, which is a
 * different product from a different URL.
 */
export function versionLabel(entry: DatasetHealthEntry): string | null {
  return entry.version_established ? entry.version : null;
}
