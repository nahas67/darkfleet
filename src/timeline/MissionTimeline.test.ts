import { describe, expect, it } from 'vitest';

import { chronologicalEvents, missionInstantIndex } from './MissionTimeline';

describe('mission timeline chronology and selection', () => {
  it('orders real instants by UTC epoch, including offset and fractional timestamp variants', () => {
    const rows = [
      { at: '2026-10-11T11:00:00+05:30', id: 'early' },
      { at: '2026-10-11T06:00:00.500Z', id: 'middle' },
      { at: '2026-10-11T06:00:01Z', id: 'late' },
      { at: 'not-an-instant', id: 'invalid' },
    ];
    expect(chronologicalEvents(rows).map((row) => row.id)).toEqual(['early', 'middle', 'late']);
  });

  it('tracks the same event through appended or reordered instants and resets on replacement', () => {
    const original = ['2026-10-11T06:00:00Z', '2026-10-11T06:00:02Z'];
    expect(missionInstantIndex(original, original[0])).toBe(0);
    const appended = [...original, '2026-10-11T06:00:03Z'];
    expect(missionInstantIndex(appended, original[0])).toBe(0);
    expect(missionInstantIndex(appended, '2020-01-01T00:00:00Z')).toBe(2);
    expect(missionInstantIndex(['2026-10-11T07:00:00Z'], original[0])).toBe(0);
  });
});
