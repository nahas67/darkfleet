/**
 * Generic runtime validation, driven by the GENERATED contract field lists.
 *
 * WHY THIS EXISTS RATHER THAN MORE HAND-WRITTEN VALIDATORS
 *
 * `validate.ts` establishes the right idea -- every response is checked before
 * the application is allowed to believe it -- but each validator is written by
 * hand against one type. The first time a key was renamed on the wire, `cls`
 * became `classification` and `t.classification` was `undefined` in every live
 * render path with no failing test, because nothing asserted which key should be
 * there.
 *
 * Writing eight more hand-written validators for the dossier's eight responses
 * would reproduce that exact hazard eight more times, and the copies would drift
 * from the contract the moment anyone edited one of them. So there is ONE
 * mechanism here, and the field list it checks comes from `contract.ts`, which is
 * generated from the backend's OpenAPI document.
 *
 * The consequence that matters: adding a field to a Pydantic model propagates to
 * the check automatically, because the list being checked is not written by hand.
 * A validator that cannot go stale is worth more than a precise one.
 *
 * NULL IS NOT MISSING
 *
 * The contract uses `null` to mean "measured as absent" (`hdg: null` = no heading
 * was measured) and omission to mean "not applicable to this variant". That
 * distinction is load-bearing across the whole evidence surface, so this module
 * reports a missing key and a null key as different failures rather than treating
 * a null as a missing field.
 *
 * WHAT IT DOES NOT CHECK
 *
 * Leaf types. This verifies key presence and shape, not that a `confidence` is a
 * number. That is a real limit and it is stated rather than implied: a response
 * with every key present but `sarConf: "high"` would pass. Checking leaf types
 * generically would need a schema library, and the house rule is that a 200-line
 * file anyone can read beats a dependency. The hand-written validators in
 * `validate.ts` remain for the types where leaf checking was worth it.
 */

import { ContractViolation } from './errors';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type FieldSpec = readonly string[];

/**
 * Assert that `value` is an object carrying exactly the contract's keys.
 *
 * Extra keys are a failure, not something to ignore. An unexpected key usually
 * means the frontend is reading a field the backend renamed or removed, and
 * quietly ignoring it is how that becomes a silently blank panel.
 */
export function validateShape<T>(
  value: unknown,
  fields: FieldSpec,
  label: string,
): T {
  if (!isPlainObject(value)) {
    throw new ContractViolation(label, `${label} was not an object (got ${typeName(value)}).`);
  }

  const present = new Set(Object.keys(value));
  const required = new Set(fields);

  for (const key of fields) {
    // `null` satisfies presence. It means the backend measured an absence and said
    // so, which is different from the key being absent.
    if (present.has(key)) continue;
    if (required.has(key)) {
      throw new ContractViolation(`${label}.${key}`, `${label} is missing required key "${key}".`);
    }
  }

  for (const key of present) {
    if (required.has(key)) continue;
    throw new ContractViolation(
      `${label}.${key}`,
      `${label} carries unexpected key "${key}". The contract does not declare it, so ` +
        'reading it would be reading a field the backend no longer promises.',
    );
  }

  return value as T;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Build a validator for one contract type.
 *
 * The returned function is what call sites use, so adding a field to the Pydantic
 * model needs no edit here and no edit at the call site: regenerate the contract
 * and the check already covers the new key.
 */
export function contractValidator<T>(fields: FieldSpec, label: string): (value: unknown) => T {
  return (value: unknown) => validateShape<T>(value, fields, label);
}

/**
 * Validate every entry of an array with the same validator.
 *
 * The index is put in the failure path so a violation inside item 7 of 200 names
 * item 7, rather than reporting a generic "array invalid" that sends the reader
 * to the wrong record.
 */
export function validateArray<T>(
  value: unknown,
  item: (v: unknown) => T,
  label: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation(label, `${label} was not an array (got ${typeName(value)}).`);
  }
  return value.map((entry, index) => {
    try {
      return item(entry);
    } catch (cause) {
      if (cause instanceof ContractViolation) {
        /*
         * The inner path is `<itemLabel>.<field>`, so the field suffix is everything
         * after the FIRST segment. Slicing by the ARRAY label's length instead --
         * which is the obvious way to write this -- silently corrupts the path
         * whenever the item validator uses a different label from the array's, and
         * the corruption is invisible: it still reads like a path.
         */
        const fieldPath = cause.path.includes('.')
          ? cause.path.slice(cause.path.indexOf('.'))
          : '';
        throw new ContractViolation(`${label}[${index}]${fieldPath}`, cause.message);
      }
      throw cause;
    }
  });
}

/**
 * Validate a field that must be present and must be an object, or must be null.
 *
 * Used for the nested evidence blocks. `null` is permitted because the contract
 * legitimately declares several of them nullable, and rejecting null here would
 * make the validator stricter than the backend.
 */
export function validateNullableObject<T>(
  value: unknown,
  fields: FieldSpec | null,
  label: string,
): T | null {
  if (value === null) return null;
  if (fields === null) return value as T;
  return validateShape<T>(value, fields, label);
}