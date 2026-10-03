# Ghost Vessel semantics

The single authority for how DarkFleet talks about a vessel-like SAR return that
AIS does not confidently explain. Implemented in
`backend/darkfleet/ghost_vessel.py` (source of truth) and
`src/ghost_vessel.ts` (frontend mirror + fallback).

## The two names

| | |
|---|---|
| `SAR_UNMATCHED` | The **analytical classification**. What the correlation determined. Never renamed. |
| `GHOST VESSEL` | The **product designation**. Rendered *above* the analytical class, never instead of it. |

Both are always visible together. A reader who sees only "Ghost Vessel" has been
given a question, not an answer.

## Definition

> A vessel-like SAR return for which DarkFleet found no sufficiently confident AIS
> association in the available observations and correlation window.

## What a Ghost Vessel does NOT mean

Not established, not implied, not suggested:

- a transponder was intentionally disabled
- AIS was never transmitted
- sanctions evasion, smuggling, or criminal activity
- hostile or deceptive behaviour
- identity concealment
- illegal fishing
- military intent

None of these are measurable from a radar return plus an absence of association.
The correlation established exactly one thing: **no candidate cleared a
threshold.**

`FORBIDDEN_INFERENCES` lists these phrases in code, and tests assert the emitted
and rendered strings are clean — 17 backend tests over
`backend/darkfleet/ghost_vessel.py`, 8 frontend over `src/ghost_vessel.ts`. A
future surface cannot quietly rephrase the warning into an accusation without
failing a gate.

## The mandatory warning

Rendered undismissable on every Ghost Vessel surface:

> No sufficiently confident AIS association was found in the available
> observations and correlation window. This alone does not establish why.

## Structural separation

Three blocks, never merged into prose. A reader who skims cannot take a hypothesis
for a measurement. Each renders **even when empty**, so "nothing found" is never
mistaken for "not examined".

### OBSERVED

Measured only: position, SAR confidence, apparent footprint, length uncertainty,
orientation, mean/max backscatter, wake detection (when measured), geolocation
uncertainty.

### HYPOTHESES

Every entry is a **coverage or detection** explanation:

- AIS coverage gap — no receiver covered this position at acquisition time
- stale observation — the nearest AIS report was too old to associate
- not broadcasting a position report at that moment
- outside reliable reception for its class and heading
- not a vessel — clutter, a structure, or a processing artefact over threshold
- incidence angle or radar geometry degraded detectability or association

No hypothesis is about intent, because intent is not observable here. An analyst
who wants intent hypotheses must reason from evidence; the product does not
pre-supply them.

### UNKNOWNS

Identity · flag or registry · destination · cargo · intent · whether any AIS
transmission exists at all · whether the vessel is crewed · **whether the return
is a vessel at all**.

## Making the decision inspectable

"No association was accepted" is unfalsifiable without the arithmetic behind it.
Every target carries:

| Field | Meaning |
|---|---|
| `candidatesConsidered` | How many AIS candidates were evaluated |
| `acceptanceThreshold` | Composite score needed to accept one |
| `closestRejected` | Best candidate **not** accepted: score, separation, Δt, shortfall |

An empty search and a rejected near miss are **different findings** and are never
collapsed: `closestRejected: null` with `candidatesConsidered: 0` means nothing
was available to correlate, which is not the same as "something was close and did
not qualify".

## Operator questions this must answer

> Why was this target matched?
> Why was this target NOT matched?

Both are answered from measured fields, not from prose. The Ghost Vessel tab
renders the decision block with the threshold and the rejected candidate's
numbers.

## Non-negotiable

A watchlist membership must never change classification. A Ghost Vessel is a
correlation outcome; watchlisting is an organisational act. Confusing the two
would let an analyst's own note become evidence.