import { flattenJson, parseExactJson } from './exact-json';
import type { ConfigTextMap } from './config-model';

export type ConfigChange = {
  configName: string;
  path: string;
  before: string;
  after: string;
};

export function diffConfigs(before: ConfigTextMap, after: ConfigTextMap): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const configName of Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()) {
    if (!(configName in before)) {
      changes.push({ configName, path: '$', before: 'отсутствует', after: 'добавлен конфиг' });
      continue;
    }
    if (!(configName in after)) {
      changes.push({ configName, path: '$', before: 'существовал', after: 'удалён конфиг' });
      continue;
    }
    const left = new Map(flattenJson(parseExactJson(before[configName])).map((row) => [row.path, row]));
    const right = new Map(flattenJson(parseExactJson(after[configName])).map((row) => [row.path, row]));
    for (const path of Array.from(new Set([...left.keys(), ...right.keys()])).sort()) {
      const beforeRow = left.get(path);
      const afterRow = right.get(path);
      const beforeValue = beforeRow ? `${beforeRow.type}:${beforeRow.value}` : 'отсутствует';
      const afterValue = afterRow ? `${afterRow.type}:${afterRow.value}` : 'отсутствует';
      if (beforeValue !== afterValue) {
        changes.push({ configName, path, before: beforeValue, after: afterValue });
      }
    }
  }
  return changes;
}
