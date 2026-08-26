import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildConfigFiles, buildConfigZip } from '../lib/config-export';
import { seedConfigText } from '../lib/generated/seed-configs';
import {
  assertProdEligibility,
  mergeRemoteConfigBundle,
  MockPublisher,
  nextStatus,
  resolveLatestPublishVersion,
} from '../lib/publishing';
import { hasPermission, permissionLabels, permissions, roleDescriptions, roleLabels, rolePermissions } from '../lib/rbac';
import { redactSecrets } from '../lib/security';

describe('RBAC', () => {
  it('gives the owner every atomic permission and keeps observer read-only', () => {
    expect(rolePermissions.owner).toEqual(permissions);
    expect(hasPermission('observer', 'configs:view')).toBe(true);
    expect(hasPermission('observer', 'reward-map:view')).toBe(true);
    expect(hasPermission('observer', 'reward-map:edit')).toBe(false);
    expect(hasPermission('balancer', 'reward-map:generate')).toBe(true);
    expect(hasPermission('observer', 'configs:edit')).toBe(false);
    expect(hasPermission('balancer', 'publish:prod')).toBe(false);
    expect(hasPermission('prod_publisher', 'publish:prod')).toBe(true);
  });

  it('supports per-user permission additions', () => {
    expect(hasPermission('observer', 'publish:dev', ['publish:dev'])).toBe(true);
  });

  it('has clear interface copy for every role and permission', () => {
    expect(Object.keys(permissionLabels).sort()).toEqual([...permissions].sort());
    expect(Object.keys(roleDescriptions).sort()).toEqual(Object.keys(roleLabels).sort());
    expect(Object.values(permissionLabels).every((label) => label.length >= 5)).toBe(true);
  });
});

describe('publishing workflow', () => {
  it('enforces draft → ready → DEV → tested → PROD', () => {
    expect(nextStatus('draft', 'mark_ready')).toBe('ready_dev');
    expect(nextStatus('ready_dev', 'publish_dev')).toBe('published_dev');
    expect(nextStatus('published_dev', 'approve_testing')).toBe('tested');
    expect(nextStatus('tested', 'publish_prod')).toBe('published_prod');
    expect(() => nextStatus('draft', 'publish_prod')).toThrow('недоступно');
  });

  it('blocks PROD unless the exact tested version was verified in DEV', () => {
    expect(() => assertProdEligibility({
      versionId: 'v2', devVersionId: 'v1', testedVersionId: 'v2', status: 'tested',
    })).toThrow('тот же неизменяемый набор JSON');
    expect(() => assertProdEligibility({
      versionId: 'v2', devVersionId: 'v2', testedVersionId: null, status: 'published_dev',
    })).toThrow('не подтверждена');
    expect(() => assertProdEligibility({
      versionId: 'v2', devVersionId: 'v2', testedVersionId: 'v2', status: 'tested',
    })).not.toThrow();
  });

  it('runs a full mock publish without external writes', async () => {
    const publisher = new MockPublisher();
    const dev = await publisher.publish('DEV', 'v-test', seedConfigText);
    const prod = await publisher.publish('PROD', 'v-test', seedConfigText);
    expect(dev.verified).toBe(true);
    expect(prod.verified).toBe(true);
    expect(dev.checksum).toBe(prod.checksum);
    expect(dev.operationId).toMatch(/^mock-dev-v-test-/);
    expect(dev.detail).toContain('внешние системы не изменялись');
  });

  it('preserves unrelated newer GitHub configs while keeping user changes', () => {
    const result = mergeRemoteConfigBundle({
      base: { Pickaxes: '[1]', Spiders: '{"speed":1}' },
      remote: { Pickaxes: '[1]', Spiders: '{"speed":2}' },
      target: { Pickaxes: '[2]', Spiders: '{"speed":1}' },
    });
    expect(result.configs.Pickaxes).toBe('[\n  2\n]\n');
    expect(result.configs.Spiders).toContain('"speed": 2');
    expect(result.userChanged).toEqual(['Pickaxes']);
    expect(result.remoteChanged).toEqual(['Spiders']);
  });

  it('blocks an automatic rebase when both sides changed the same config', () => {
    expect(() => mergeRemoteConfigBundle({
      base: { Pickaxes: '[1]' },
      remote: { Pickaxes: '[3]' },
      target: { Pickaxes: '[2]' },
    })).toThrow('одновременно изменили');
  });

  it('moves a stale publish request to the latest identical snapshot', () => {
    const requested = { id: 'v-old', contentHash: 'same' };
    const latest = { id: 'v-new', contentHash: 'same' };
    expect(resolveLatestPublishVersion(requested, latest)).toBe(latest);
  });

  it('blocks a stale publish request when newer settings are different', () => {
    expect(() => resolveLatestPublishVersion(
      { id: 'v-old', contentHash: 'old' },
      { id: 'v-new', contentHash: 'new' },
    )).toThrow('более новая версия с другими настройками');
  });
});

describe('safe export and audit logging', () => {
  it('exports one canonical JSON file per config, preserving exact lexemes', () => {
    const files = buildConfigFiles(seedConfigText);
    expect(Object.keys(files)).toHaveLength(9);
    expect(files['configs/Rooms.json']).toContain('1300000000000000000000000000000');
    expect(files['configs/Rooms.json']).not.toMatch(/"blockMaxHP":\s*[^,\n]*[.eE]/);
    expect(files['configs/Pickaxes.json']).toContain('10000000000000000');

    const archive = unzipSync(buildConfigZip(seedConfigText, { versionId: 'v-test' }));
    expect(Object.keys(archive)).toContain('manifest.json');
    expect(strFromU8(archive['configs/Rooms.json'])).toContain('1300000000000000000000000000000');
  });

  it('redacts nested tokens, secrets, API keys and authorization values', () => {
    expect(redactSecrets({ token: 'a', nested: { apiKey: 'b', safe: 'ok' }, authorization: 'c' })).toEqual({
      token: '[СКРЫТО]', nested: { apiKey: '[СКРЫТО]', safe: 'ok' }, authorization: '[СКРЫТО]',
    });
  });
});
