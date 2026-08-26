export const permissions = [
  'configs:view',
  'configs:edit',
  'configs:import',
  'reward-map:view',
  'reward-map:edit',
  'reward-map:generate',
  'reward-map:suggestions',
  'reward-map:templates',
  'warnings:acknowledge',
  'publish:dev',
  'testing:approve',
  'publish:prod',
  'versions:rollback',
  'connections:manage',
  'users:manage',
] as const;

export type Permission = (typeof permissions)[number];
export type Role =
  | 'owner'
  | 'admin'
  | 'balancer'
  | 'tester'
  | 'prod_publisher'
  | 'observer';

export const roleLabels: Record<Role, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  balancer: 'Балансировщик',
  tester: 'Тестировщик',
  prod_publisher: 'Издатель PROD',
  observer: 'Наблюдатель',
};

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: permissions,
  admin: ['configs:view', 'configs:edit', 'configs:import', 'reward-map:view', 'reward-map:edit', 'reward-map:generate', 'reward-map:suggestions', 'reward-map:templates', 'warnings:acknowledge', 'connections:manage', 'users:manage'],
  balancer: ['configs:view', 'configs:edit', 'reward-map:view', 'reward-map:edit', 'reward-map:generate', 'reward-map:suggestions', 'reward-map:templates', 'warnings:acknowledge'],
  tester: ['configs:view', 'reward-map:view', 'warnings:acknowledge', 'publish:dev', 'testing:approve'],
  prod_publisher: ['configs:view', 'reward-map:view', 'warnings:acknowledge', 'publish:prod', 'versions:rollback'],
  observer: ['configs:view', 'reward-map:view'],
};

export function hasPermission(
  role: Role,
  permission: Permission,
  extraPermissions: readonly Permission[] = [],
): boolean {
  return rolePermissions[role].includes(permission) || extraPermissions.includes(permission);
}

export function assertPermission(
  role: Role,
  permission: Permission,
  extraPermissions: readonly Permission[] = [],
): void {
  if (!hasPermission(role, permission, extraPermissions)) {
    throw new Error(`Роль «${roleLabels[role]}» не имеет права ${permission}.`);
  }
}
