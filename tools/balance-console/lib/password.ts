export const PASSWORD_ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

export type PasswordDigest = {
  salt: string;
  hash: string;
  iterations: number;
};

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return {
    salt: bytesToHex(salt),
    hash: bytesToHex(await derivePassword(password, salt, PASSWORD_ITERATIONS)),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  digest: PasswordDigest,
): Promise<boolean> {
  if (!Number.isInteger(digest.iterations)
    || digest.iterations < 1
    || digest.iterations > PASSWORD_ITERATIONS) return false;

  const expected = hexToBytes(digest.hash);
  const actual = await derivePassword(password, hexToBytes(digest.salt), digest.iterations);
  if (expected.length !== actual.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

export function randomSessionToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(bytes));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
