import { describe, expect, it } from 'vitest';
import { hashPassword, hashSessionToken, randomSessionToken, verifyPassword } from '../lib/password';

describe('password authentication', () => {
  it('verifies the original password and rejects a different one', async () => {
    const digest = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('correct-horse-battery-staple', digest)).resolves.toBe(true);
    await expect(verifyPassword('wrong-horse-battery-staple', digest)).resolves.toBe(false);
  });

  it('creates random session tokens and stores only a stable digest', async () => {
    const first = randomSessionToken();
    const second = randomSessionToken();
    expect(first).toHaveLength(64);
    expect(second).not.toBe(first);
    await expect(hashSessionToken(first)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
