/**
 * Thin AES-256-GCM encrypt/decrypt layer for LinkedIn OAuth tokens.
 * The encryption key is derived from SESSION_SECRET via PBKDF2.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { config } from '../config.js'

const SALT = 'activitypub-mcp-linkedin-token-v1'
const KEY_LEN = 32 // 256-bit
const IV_LEN = 12  // 96-bit IV for GCM
const TAG_LEN = 16 // 128-bit auth tag

function getDerivedKey(): Buffer {
  return pbkdf2Sync(config.SESSION_SECRET, SALT, 100_000, KEY_LEN, 'sha256')
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string: iv:authTag:ciphertext (all base64 parts joined with ':').
 */
export function encryptToken(plaintext: string): string {
  const key = getDerivedKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a token encrypted by encryptToken.
 * Throws on auth failure (tampered data).
 */
export function decryptToken(enc: string): string {
  const parts = enc.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted token format')
  const [ivB64, tagB64, ctB64] = parts
  const key = getDerivedKey()
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return plain.toString('utf8')
}
