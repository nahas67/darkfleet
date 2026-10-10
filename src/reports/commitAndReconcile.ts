/**
 * Do not confuse a completed server write with its subsequent library read.
 * A failed GET cannot roll back a successful POST/PUT/DELETE. Returning the
 * distinction prevents an operator from repeating a write because refresh failed.
 */
export type CommitAndReconcileResult<T> =
  | { readonly kind: 'CONFIRMED'; readonly value: T }
  | { readonly kind: 'PERSISTED_LIST_UNVERIFIED'; readonly reason: unknown };

export async function commitAndReconcile<T>(
  commit: () => Promise<unknown>,
  reconcile: () => Promise<T>,
): Promise<CommitAndReconcileResult<T>> {
  // A write error propagates: nothing here asserts the server committed it.
  await commit();
  try {
    return { kind: 'CONFIRMED', value: await reconcile() };
  } catch (reason) {
    return { kind: 'PERSISTED_LIST_UNVERIFIED', reason };
  }
}
