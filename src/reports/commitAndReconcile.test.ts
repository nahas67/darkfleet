import { describe, expect, it, vi } from 'vitest';
import { commitAndReconcile } from './commitAndReconcile';

describe('operator persistence and reconciliation truth', () => {
  it('reports committed data only after a successful backend write and list reread', async () => {
    const order: string[] = [];
    const result = await commitAndReconcile(
      async () => { order.push('POST'); },
      async () => { order.push('GET'); return [{ id: 'saved-1' }]; },
    );
    expect(order).toEqual(['POST', 'GET']);
    expect(result).toEqual({ kind: 'CONFIRMED', value: [{ id: 'saved-1' }] });
  });

  it('does not claim a failed library read means a successful write failed', async () => {
    const post = vi.fn().mockResolvedValue({ id: 'server-id' });
    const get = vi.fn().mockRejectedValue(new Error('GET unavailable'));
    await expect(commitAndReconcile(post, get)).resolves.toMatchObject({
      kind: 'PERSISTED_LIST_UNVERIFIED', reason: new Error('GET unavailable'),
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not list a write as committed if it failed before the library read', async () => {
    const get = vi.fn();
    await expect(commitAndReconcile(
      async () => { throw new Error('POST rejected'); }, get,
    )).rejects.toThrow('POST rejected');
    expect(get).not.toHaveBeenCalled();
  });
});
