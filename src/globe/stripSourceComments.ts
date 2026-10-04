/**
 * Strip comments from source text before a pattern assertion.
 *
 * THE TRAP THIS EXISTS TO AVOID
 *
 * A module docstring that explains a defect necessarily QUOTES the code it removed --
 * the whole point of the comment is to record what was deleted. So a regex over raw
 * source matches the historical example inside its own explanation and reports the
 * defect forever, in a file whose comment is proof the defect was fixed.
 *
 * That has bitten this repository twice: `correlationCase.test.ts` and
 * `test_wake_scoring_authority.py`. Both were "failing" against text that described the
 * fix. The correction in each case was to strip comments first, so the pin operates on
 * CODE rather than on prose about code.
 *
 * STRING LITERALS ARE PRESERVED
 *
 * `//` appears inside URLs -- `https://tile.openstreetmap.org/` is the basemap source --
 * and treating that as a comment opener would truncate the line and turn a real URL
 * into a match. Escape sequences and template literals are handled so a `//` inside a
 * quoted string is never mistaken for a comment.
 *
 * The Python equivalent lives in `tools/strip_source_comments.py`; keep them in step.
 */

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Remove block comments, preserving newlines so reported line numbers stay true. */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));
}

/**
 * Remove `//` comments, skipping string literals.
 *
 * Single pass with a small state machine: inside a quote, everything is literal,
 * including `//`; outside one, `//` starts a comment.
 */
function stripLineComments(text: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    out += ch;
  }
  return out;
}

/** Read a repository file with comments removed. */
export function stripComments(relativePath: string): string {
  const path = join(__dirname, '..', relativePath);
  const raw = readFileSync(path, 'utf8');
  switch (extname(path).toLowerCase()) {
    case '.css':
      return stripBlockComments(raw);
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
      return stripLineComments(stripBlockComments(raw));
    default:
      return raw;
  }
}