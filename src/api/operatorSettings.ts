/** Persisted presentation-only System preferences. Not env/server configuration. */
import { api, ContractViolation, request } from './errors';

export type OperatorPreferences = Readonly<{
  show_provider_details: boolean;
  show_keyboard_reference: boolean;
  show_provenance_summary: boolean;
}>;

export type OperatorSettings = Readonly<{
  revision: number;
  preferences: OperatorPreferences;
}>;

export const DEFAULT_OPERATOR_PREFERENCES: OperatorPreferences = Object.freeze({
  show_provider_details: true,
  show_keyboard_reference: true,
  show_provenance_summary: true,
});

const KEYS = Object.keys(DEFAULT_OPERATOR_PREFERENCES);

export function checkedOperatorSettings(raw: unknown): OperatorSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractViolation('OperatorSettingsOut', 'Expected an object.');
  }
  const object = raw as Record<string, unknown>;
  const prefs = object.preferences;
  if (!Number.isSafeInteger(object.revision) || (object.revision as number) < 0 ||
      Object.keys(object).length !== 2 || !('revision' in object) || !('preferences' in object) ||
      !prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw new ContractViolation('OperatorSettingsOut', 'Missing or unexpected settings fields.');
  }
  const record = prefs as Record<string, unknown>;
  if (Object.keys(record).length !== KEYS.length || KEYS.some((key) =>
    typeof record[key] !== 'boolean' || !Object.hasOwn(record, key))) {
    throw new ContractViolation('OperatorSettingsOut.preferences',
      'The presentation preferences must contain only three boolean fields.');
  }
  return raw as OperatorSettings;
}

export async function getOperatorSettings(signal?: AbortSignal): Promise<OperatorSettings> {
  return checkedOperatorSettings(await api.get<unknown>('/api/operator-settings', signal));
}

export async function saveOperatorSettings(
  revision: number, preferences: OperatorPreferences,
): Promise<OperatorSettings> {
  return checkedOperatorSettings(await request<unknown>('/api/operator-settings', {
    method: 'PUT', body: JSON.stringify({ expected_revision: revision, preferences }),
  }));
}

export async function resetOperatorSettings(revision: number): Promise<OperatorSettings> {
  return checkedOperatorSettings(await api.post<unknown>('/api/operator-settings/reset', {
    expected_revision: revision,
  }));
}
