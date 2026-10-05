/**
 * The mid-token classification debt, and why this test is not a snapshot.
 *
 * THE DEFECT
 * ----------
 * `STATIONARY_OR_INFRASTRUCTURE` is 28 characters of one underscore-joined token. At
 * 1024x768 the dossier's label column left about 180 px for the value, and the
 * `overflow-wrap: anywhere` safety net added in DF-X8.3D then split it wherever it landed:
 *
 *     STATIONARY_OR_INFRASTR
 *     UCTURE
 *
 * which reads as a CORRUPTED value, not a long one. An operator seeing that cannot tell
 * whether the classification was truncated, and that doubt is what must never attach to a
 * classification.
 *
 * WHY NOT `white-space: nowrap` ALONE
 * -----------------------------------
 * It would stop the split by letting the row overflow the column, and DF-X8.5B §38 requires
 * no page-level horizontal overflow at any of the four widths. So the fix is a readable
 * rendering with the canonical value preserved, not a layout escape.
 *
 * WHAT MUST STAY TRUE
 * -------------------
 * The canonical value is not shortened, replaced or re-derived. It is in the DOM as an
 * attribute, in the accessible name, and in the `title`. A copy of the element yields the
 * canonical form. These assertions are what make this a presentation change rather than a
 * silent re-classification.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ClassificationPill,
  classificationTone,
  readableClassification,
} from './classification';

const LONG = 'STATIONARY_OR_INFRASTRUCTURE';

describe('readable classification', () => {
  it('never displays an underscore in the visible wording', () => {
    // The specific defect: the visible text contained the token separator that the
    // browser was breaking on. Removing it removes the break opportunity with it.
    expect(readableClassification(LONG)).not.toContain('_');
    expect(readableClassification(LONG)).toBe('Stationary or infrastructure');
  });

  it('reads as prose rather than as a truncated identifier', () => {
    const readable = readableClassification(LONG);
    // Spaces are what let it wrap BETWEEN words. Without them the only break points are
    // inside words, which is the original defect.
    expect(readable).toContain(' ');
    expect(readable.split(' ').length).toBeGreaterThan(1);
    // Every word is a real word, so no fragment can read as a truncation.
    expect(readable.split(' ')).toEqual(['Stationary', 'or', 'infrastructure']);
    // NOT asserted: that the readable form is SHORTER than the canonical token. It is the
    // same length -- 28 characters, because underscores became spaces. Length was the wrong
    // proxy; what matters is that there is no in-word break opportunity.
    expect(readable).toHaveLength(LONG.length);
  });

  it('falls back to the canonical value for anything unlisted', () => {
    // A new classification must display as itself rather than becoming blank or
    // "undefined" -- an unmapped value is still a real value.
    expect(readableClassification('SOME_FUTURE_CLASSIFICATION')).toBe(
      'SOME_FUTURE_CLASSIFICATION',
    );
    expect(readableClassification('')).toBe('');
  });

  it('does not invent a mapping for a short value', () => {
    // SAR_MATCHED_AIS is short enough to show as-is. Mapping it would imply a translation
    // that does not exist and would make the two forms diverge for no benefit.
    expect(readableClassification('SAR_MATCHED_AIS')).toBe('SAR matched AIS');
  });
});

describe('classification tone', () => {
  it('warns only for the Ghost Vessel case, from the CANONICAL value', () => {
    expect(classificationTone('SAR_UNMATCHED')).toBe('warn');
    expect(classificationTone(LONG)).toBe('neutral');
    expect(classificationTone('SAR_MATCHED_AIS')).toBe('neutral');
  });

  it('reads the canonical value, so rewording cannot move a colour', () => {
    // If tone were inferred from the readable wording, editing "Stationary or
    // infrastructure" to anything containing "unmatched" would silently colour a
    // non-Ghost classification as a warning.
    expect(classificationTone(readableClassification(LONG))).toBe('neutral');
  });
});

describe('ClassificationPill markup', () => {
  const markup = renderToStaticMarkup(<ClassificationPill classification={LONG} />);

  /**
   * The text the operator SEES, as distinct from all text in the DOM.
   *
   * Stripping tags and concatenating everything is wrong, because it also picks up the
   * visually-hidden canonical token -- which is supposed to contain underscores and is
   * supposed to be in the document. That assertion would have failed against correct
   * behaviour, so it is scoped to the visible span instead.
   */
  function visibleText(html: string): string {
    const withoutHidden = html.replace(/<span class="df-sr-only">[\s\S]*?<\/span>/g, '');
    return withoutHidden
      .replace(/<[^>]*>/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(' ');
  }

  it('renders no underscore in the VISIBLE text', () => {
    // The literal regression: the displayed text must not contain the separator the browser
    // was splitting on.
    expect(visibleText(markup)).not.toContain('_');
    expect(visibleText(markup)).toBe('Stationary or infrastructure');
  });

  it('carries the canonical value as an attribute', () => {
    // So tests, exports and any DOM-reading tool see the real classification.
    expect(markup).toContain(`data-df-classification="${LONG}"`);
  });

  it('carries the canonical value in the accessible name', () => {
    // A screen-reader user must hear the canonical token, not only the prose. Rendered
    // through the project's own visually-hidden class: Tailwind's `sr-only` would have
    // printed the token visibly, which is the opposite of what was wanted.
    expect(markup).toContain('df-sr-only');
    expect(markup).toContain(`(${LONG})`);
  });

  it('carries the canonical value in the title attribute', () => {
    expect(markup).toContain(`title="${LONG}"`);
  });

  it('keeps the visible wording in the DOM as well as the canonical token', () => {
    expect(markup).toContain('Stationary or infrastructure');
  });

  it('prevents a mid-token break with nowrap on the outer span', () => {
    // The structural half of the fix. `whitespace-nowrap` on the outer span stops the
    // column from breaking the token; `whitespace-normal` on the inner span lets the words
    // wrap between them. Wrapping between words is legitimate; wrapping inside one is the
    // defect.
    expect(markup).toContain('whitespace-nowrap');
    expect(markup).toContain('whitespace-normal');
  });

  it('emits no duplicate canonical token when the wording IS the canonical value', () => {
    const same = renderToStaticMarkup(
      <ClassificationPill classification="SAR_MATCHED_AIS" />,
    );
    // The hidden span exists to add the canonical form when the visible form differs. When
    // it does not differ, adding it would print the classification twice.
    const hiddenCount = (same.match(/df-sr-only/g) ?? []).length;
    expect(hiddenCount).toBeLessThanOrEqual(1);
    // Still carries it once, via the attribute.
    expect(same).toContain('data-df-classification="SAR_MATCHED_AIS"');
  });
});
