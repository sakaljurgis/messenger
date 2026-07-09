import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt parameters. 16-byte salt, 64-byte derived key. Stored as
// `saltBase64url:hashBase64url`.
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Hash a password with a fresh random salt. Returns `salt:hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `${salt.toString('base64url')}:${key.toString('base64url')}`;
}

/** Constant-time verification of a password against a stored `salt:hash`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltPart, hashPart] = stored.split(':');
  if (!saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64url');
  const salt = Buffer.from(saltPart, 'base64url');
  const actual = await deriveKey(password, salt);

  // timingSafeEqual throws on length mismatch — guard first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
