import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'data', 'entity-icons.json'), 'utf8'));
const verifyOnly = process.argv.includes('--verify');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const entries = Object.entries(manifest.categories).flatMap(([category, group]) => {
  const rows = Object.entries(group.items).map(([entityId, entry]) => ({ category, entityId, sourcePath: group.sourcePath, ...entry }));
  if (rows.length !== group.count) throw new Error(`${category}: manifest count ${rows.length} does not match ${group.count}`);
  return rows;
});

async function isValidPng(destination) {
  try {
    const info = await stat(destination);
    if (!info.isFile() || info.size < 100) return false;
    const bytes = await readFile(destination);
    return bytes.subarray(0, 8).equals(pngSignature);
  } catch {
    return false;
  }
}

for (const entry of entries) await mkdir(path.dirname(path.join(root, 'public', entry.src.replace(/^\//, ''))), { recursive: true });

if (!verifyOnly) {
  const queue = [];
  for (const entry of entries) {
    const destination = path.join(root, 'public', entry.src.replace(/^\//, ''));
    if (!(await isValidPng(destination))) queue.push(entry);
  }

  const thumbnails = new Map();
  let pending = queue.map((entry) => entry.assetId);
  for (let attempt = 1; attempt <= 15 && pending.length > 0; attempt += 1) {
    for (let start = 0; start < pending.length; start += 100) {
      const query = new URLSearchParams({
        assetIds: pending.slice(start, start + 100).join(','),
        returnPolicy: 'PlaceHolder',
        size: '420x420',
        format: 'Png',
        isCircular: 'false',
      });
      const response = await fetch(`https://thumbnails.roblox.com/v1/assets?${query}`);
      if (!response.ok) throw new Error(`Roblox thumbnails API returned ${response.status}`);
      const payload = await response.json();
      for (const row of payload.data) thumbnails.set(String(row.targetId), row);
    }
    pending = pending.filter((assetId) => thumbnails.get(assetId)?.state !== 'Completed');
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      const thumbnail = thumbnails.get(entry.assetId);
      if (!thumbnail || thumbnail.state !== 'Completed' || !thumbnail.imageUrl) {
        throw new Error(`${entry.category}/${entry.entityId}: thumbnail is unavailable (${thumbnail?.state ?? 'missing'})`);
      }
      const imageResponse = await fetch(thumbnail.imageUrl);
      if (!imageResponse.ok) throw new Error(`${entry.category}/${entry.entityId}: image download returned ${imageResponse.status}`);
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`${entry.category}/${entry.entityId}: downloaded file is not PNG`);
      const destination = path.join(root, 'public', entry.src.replace(/^\//, ''));
      const temporary = `${destination}.download`;
      await writeFile(temporary, bytes);
      await rename(temporary, destination);
      process.stdout.write(`downloaded ${entry.category}/${entry.entityId}\n`);
    }
  });
  await Promise.all(workers);
}

const missing = [];
for (const entry of entries) {
  const destination = path.join(root, 'public', entry.src.replace(/^\//, ''));
  if (!(await isValidPng(destination))) missing.push(`${entry.category}/${entry.entityId}`);
}
if (missing.length > 0) throw new Error(`Missing or invalid entity icons (${missing.length}): ${missing.join(', ')}`);

console.log(`verified ${entries.length} real Roblox entity icons from author-owned game configs`);
