import { getDb } from '../db/client.js'
import { serverConfig } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger.js'

const KEY_ALGO: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
}

async function exportToPem(key: CryptoKey, type: 'public' | 'private'): Promise<string> {
  const format = type === 'public' ? 'spki' : 'pkcs8'
  const exported = await crypto.subtle.exportKey(format, key)
  const b64 = Buffer.from(exported).toString('base64')
  const lines = b64.match(/.{1,64}/g)!.join('\n')
  const label = type === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY'
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

export async function importPublicKeyFromPem(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '')
  const der = Buffer.from(b64, 'base64')
  return crypto.subtle.importKey('spki', der, KEY_ALGO, true, ['verify'])
}

export async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const der = Buffer.from(b64, 'base64')
  return crypto.subtle.importKey('pkcs8', der, KEY_ALGO, true, ['sign'])
}

let _publicKeyPem: string | null = null
let _privateKeyPem: string | null = null
let _publicKey: CryptoKey | null = null
let _privateKey: CryptoKey | null = null

export async function ensureKeys(): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(serverConfig)
    .where(eq(serverConfig.key, 'actor_public_key_pem'))

  if (rows.length === 0) {
    logger.info('Generating RSA keypair on first startup...')
    const keyPair = await crypto.subtle.generateKey(KEY_ALGO, true, ['sign', 'verify'])
    const pubPem = await exportToPem(keyPair.publicKey, 'public')
    const privPem = await exportToPem(keyPair.privateKey, 'private')
    await db.insert(serverConfig).values([
      { key: 'actor_public_key_pem', value: pubPem },
      { key: 'actor_private_key_pem', value: privPem },
    ])
    _publicKeyPem = pubPem
    _privateKeyPem = privPem
    _publicKey = keyPair.publicKey
    _privateKey = keyPair.privateKey
    logger.info('RSA keypair generated and stored')
  } else {
    const [pub] = await db.select().from(serverConfig).where(eq(serverConfig.key, 'actor_public_key_pem'))
    const [priv] = await db.select().from(serverConfig).where(eq(serverConfig.key, 'actor_private_key_pem'))
    _publicKeyPem = pub.value
    _privateKeyPem = priv.value
    _publicKey = await importPublicKeyFromPem(_publicKeyPem)
    _privateKey = await importPrivateKeyFromPem(_privateKeyPem)
  }
}

export function getPublicKeyPem(): string {
  if (!_publicKeyPem) throw new Error('Keys not initialized. Call ensureKeys() first.')
  return _publicKeyPem
}

export function getPrivateKey(): CryptoKey {
  if (!_privateKey) throw new Error('Keys not initialized. Call ensureKeys() first.')
  return _privateKey
}

export function getPublicKey(): CryptoKey {
  if (!_publicKey) throw new Error('Keys not initialized. Call ensureKeys() first.')
  return _publicKey
}
