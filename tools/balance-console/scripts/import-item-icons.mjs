import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'data', 'item-icons.json');
const outputDirectory = path.join(root, 'public', 'item-icons');
const verifyOnly = process.argv.includes('--verify');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entries = Object.entries(manifest.items);

if (entries.length !== manifest.itemCount) {
  throw new Error(`Manifest count mismatch: ${entries.length} entries, itemCount=${manifest.itemCount}`);
}

await mkdir(outputDirectory, { recursive: true });

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

if (!verifyOnly) {
  const queue = [];
  for (const row of entries) {
    const destination = path.join(root, 'public', row[1].src.replace(/^\//, ''));
    if (!(await isValidPng(destination))) queue.push(row);
  }
  const assetIds = queue.map(([, entry]) => entry.assetId);
  const thumbnails = new Map();
  let pending = [...assetIds];
  for (let attempt = 1; attempt <= 15 && pending.length > 0; attempt += 1) {
    const query = new URLSearchParams({
      assetIds: pending.join(','),
      returnPolicy: 'PlaceHolder',
      size: '420x420',
      format: 'Png',
      isCircular: 'false',
    });
    const response = await fetch(`https://thumbnails.roblox.com/v1/assets?${query}`);
    if (!response.ok) throw new Error(`Roblox thumbnails API returned ${response.status}`);
    const payload = await response.json();
    for (const row of payload.data) thumbnails.set(String(row.targetId), row);
    pending = pending.filter((assetId) => thumbnails.get(assetId)?.state !== 'Completed');
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length > 0) {
      const [itemId, entry] = queue.shift();
      const thumbnail = thumbnails.get(entry.assetId);
      if (!thumbnail || thumbnail.state !== 'Completed' || !thumbnail.imageUrl) {
        throw new Error(`${itemId}: thumbnail is unavailable (${thumbnail?.state ?? 'missing'})`);
      }
      const imageResponse = await fetch(thumbnail.imageUrl);
      if (!imageResponse.ok) throw new Error(`${itemId}: image download returned ${imageResponse.status}`);
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`${itemId}: downloaded file is not PNG`);
      const destination = path.join(root, 'public', entry.src.replace(/^\//, ''));
      const temporary = `${destination}.download`;
      await writeFile(temporary, bytes);
      await rename(temporary, destination);
      process.stdout.write(`downloaded ${itemId} -> ${path.relative(root, destination)}\n`);
    }
  });
  await Promise.all(workers);
}

const missing = [];
for (const [itemId, entry] of entries) {
  const destination = path.join(root, 'public', entry.src.replace(/^\//, ''));
  if (!(await isValidPng(destination))) missing.push(itemId);
}

if (missing.length > 0) {
  throw new Error(`Missing or invalid icons (${new Set(missing).size}): ${[...new Set(missing)].join(', ')}`);
}

console.log(`verified ${entries.length} real Roblox icons from ${manifest.source.path}`);
