import { strToU8, zipSync } from 'fflate';
import type { ConfigTextMap } from './config-model';
import { canonicalExactJson } from './exact-json';

export function buildConfigFiles(configs: ConfigTextMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, raw]) => [`configs/${safeName(name)}.json`, canonicalExactJson(raw)]),
  );
}

export function buildConfigZip(configs: ConfigTextMap, metadata: Record<string, unknown>) {
  const files = buildConfigFiles(configs);
  const bytes = Object.fromEntries([
    ...Object.entries(files).map(([name, raw]) => [name, strToU8(raw)]),
    ['manifest.json', strToU8(`${JSON.stringify(metadata, null, 2)}\n`)],
  ]);
  return zipSync(bytes, { level: 6 });
}

function safeName(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Небезопасное имя конфига: ${name}`);
  return name;
}
