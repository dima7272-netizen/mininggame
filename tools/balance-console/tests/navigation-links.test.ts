import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accountSettings = readFileSync(new URL('../app/account/account-settings.tsx', import.meta.url), 'utf8');
const invitation = readFileSync(new URL('../app/invite/[token]/invite-client.tsx', import.meta.url), 'utf8');

describe('hosted navigation links', () => {
  it('uses native navigation for links that leave client-only screens', () => {
    expect(accountSettings).toContain('<a className="account-back" href="/">');
    expect(invitation).toContain('<a className="button primary invite-action" href="/">');
    expect(accountSettings).not.toContain("from 'next/link'");
    expect(invitation).not.toContain("from 'next/link'");
  });
});
