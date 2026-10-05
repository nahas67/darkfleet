/**
 * The canonical classification, rendered so it can never break mid-token.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * `STATIONARY_OR_INFRASTRUCTURE` is 28 characters of a single underscore-joined token. At
 * 1024x768 the dossier's label column left roughly 180 px for the value, and CSS
 * `overflow-wrap: anywhere` -- added in DF-X8.3D as a safety net -- then split the token
 * wherever it happened to land:
 *
 *     STATIONARY_OR_INFRASTR
 *     UCTURE
 *
 * That reads as a corrupted value, not a long one. An operator reading that would have to
 * decide whether the classification had been truncated, which is exactly the doubt a
 * classification must never create.
 *
 * WHY A READABLE LABEL RATHER THAN ONLY nowrap
 * --------------------------------------------
 * `white-space: nowrap` alone would fix the split by letting the row overflow -- and the
 * brief already ruled that out: no page-level horizontal overflow at any of the four
 * widths. Longest-value rows are four-character-per-digit tables that must stay inside the
 * column.
 *
 * So the value is presented in the form that fits: readable words on screen, with the
 * CANONICAL value carried as the accessible name. The underscore token is not "displayed
 * differently" in any sense that could hide it -- it is the value, it is in the DOM, it is
 * what a copy-paste and what a screen reader get, and it is what the analytical delta
 * compares. Nothing downstream re-derives it.
 *
 * WHAT IS NOT DONE
 * ----------------
 * The classification is NOT shortened. `STATIONARY OR INFRASTRUCTURE` is not an abbreviation
 * of the canonical value; it is the same value with the token separator rendered as a space,
 * and the canonical form remains available at every point of use.
 */

import type { PillTone } from './primitives';
import { Pill } from './primitives';

/**
 * Canonical classifications, in the product's own words.
 *
 * Declared rather than derived so a new classification is a type error or a visible test
 * failure rather than a value that silently falls back to the raw token. `SAR_MATCHED_AIS`
 * is deliberately absent: it is short enough to display as-is and is shown verbatim, so
 * listing it here would imply a mapping that does not exist.
 */
const READABLE: Record<string, string> = {
  STATIONARY_OR_INFRASTRUCTURE: 'Stationary or infrastructure',
  SAR_UNMATCHED: 'SAR unmatched',
  SAR_MATCHED_AIS: 'SAR matched AIS',
  MOVING: 'Moving',
};

export type ClassificationTone = PillTone;

/**
 * The tone for a classification, chosen from the canonical value.
 *
 * Read from the canonical value rather than the rendered label, so a change to the readable
 * wording cannot silently move a warning colour. `SAR_UNMATCHED` is the Ghost Vessel case
 * and carries `warn`; everything else is neutral. Nothing here infers intent from a
 * substring -- an earlier version keyed on "UNMATCHED" appearing in the text, which would
 * have mis-coloured any future classification containing that word.
 */
export function classificationTone(classification: string): ClassificationTone {
  return classification === 'SAR_UNMATCHED' ? 'warn' : 'neutral';
}

/** The on-screen wording. Falls back to the canonical value for anything unlisted. */
export function readableClassification(classification: string): string {
  return READABLE[classification] ?? classification;
}

/**
 * A classification pill that cannot break mid-token.
 *
 * `title` carries the canonical value so hovering or long-pressing reveals it, and the
 * `data-df-classification` attribute carries it in the DOM for tests and for any export
 * that reads attributes rather than text.
 *
 * `inline-block` with `whitespace-normal` inside a `nowrap` outer span: the outer span
 * prevents the token from being broken by the column, and the inner span allows the readable
 * words to wrap between them. Wrapping BETWEEN WORDS is legitimate; wrapping INSIDE a word
 * is what produced the defect.
 */
export function ClassificationPill({ classification }: { classification: string }) {
  const readable = readableClassification(classification);
  const differs = readable !== classification;

  return (
    <span className="inline-block whitespace-nowrap align-baseline" title={classification}>
      <Pill tone={classificationTone(classification)}>
        <span
          data-df-classification={classification}
          className="inline-block whitespace-normal tracking-normal normal-case"
        >
          {readable}
        </span>
      </Pill>
      {/*
        The canonical token is present in the accessible name whenever the on-screen wording
        differs. Without this, a screen-reader user would hear only "Stationary or
        infrastructure" and a copy of the element would yield the readable form -- and the
        canonical value would be reachable only by inspecting an attribute.
      */}
      {differs ? <span className="df-sr-only"> ({classification})</span> : null}
    </span>
  );
}
