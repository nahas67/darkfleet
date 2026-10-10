import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedOperatorSettings, DEFAULT_OPERATOR_PREFERENCES,
  getOperatorSettings, saveOperatorSettings, resetOperatorSettings } from './operatorSettings';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

afterEach(() => vi.unstubAllGlobals());

describe('operator presentation preferences strict client contract', () => {
  it('enforces exactly three harmless booleans and one nonnegative safe revision', () => {
    const valid = { revision: 0, preferences: DEFAULT_OPERATOR_PREFERENCES };
    expect(checkedOperatorSettings(valid)).toEqual(valid);
    for (const bad of [
      { ...valid, revision: -1 },
      { ...valid, revision: 1.2 },
      { ...valid, revision: '1' },
      { ...valid, credentials: 'secret' },
      { ...valid, preferences: { ...valid.preferences, allow_external_network: true } },
      { ...valid, preferences: { ...valid.preferences, show_provider_details: 0 } },
      { ...valid, preferences: { show_keyboard_reference: true } },
    ]) expect(() => checkedOperatorSettings(bad)).toThrow();
  });

  it('uses real GET, revisioned PUT and reset POST API requests; does not invent success', async () => {
    const valid = { revision: 0, preferences: DEFAULT_OPERATOR_PREFERENCES };
    const saved = { revision: 1, preferences: { ...valid.preferences, show_keyboard_reference: false } };
    const reset = { revision: 2, preferences: DEFAULT_OPERATOR_PREFERENCES };
    const mock = vi.fn().mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply(saved)).mockResolvedValueOnce(reply(reset));
    vi.stubGlobal('fetch', mock);
    expect(await getOperatorSettings()).toEqual(valid);
    expect(await saveOperatorSettings(0, saved.preferences)).toEqual(saved);
    expect(await resetOperatorSettings(1)).toEqual(reset);
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      '/api/operator-settings', '/api/operator-settings', '/api/operator-settings/reset',
    ]);
    expect(mock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'PUT', 'POST']);
    expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({
      expected_revision: 0, preferences: saved.preferences,
    });
    expect(JSON.parse(mock.mock.calls[2][1].body)).toEqual({ expected_revision: 1 });
  });

  it('rejects real HTTP revision conflicts, notifies no synthetic save receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({
      error: 'OPERATOR_SETTINGS_REVISION_CONFLICT',
      message: 'Operator settings changed in another session.', status: 'OPERATOR_SETTINGS_REVISION_CONFLICT',
    }, 409)));
    await expect(saveOperatorSettings(3, DEFAULT_OPERATOR_PREFERENCES))
      .rejects.toMatchObject({ status: 409, code: 'OPERATOR_SETTINGS_REVISION_CONFLICT' });
  });
});
