import { importPublicKeyFromPem, getPrivateKey } from './keys.js'
import { fetchActor } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'

interface SignatureParams {
  keyId: string
  headers: string[]
  signature: string
  algorithm?: string
}

function parseSignatureHeader(header: string): SignatureParams | null {
  const params: Record<string, string> = {}
  const parts = header.match(/(\w+)="([^"]+)"/g) ?? []
  for (const part of parts) {
    const eq = part.indexOf('=')
    const k = part.slice(0, eq)
    const v = part.slice(eq + 2, -1)
    params[k] = v
  }
  if (!params.keyId || !params.headers || !params.signature) return null
  return {
    keyId: params.keyId,
    headers: params.headers.split(' '),
    signature: params.signature,
    algorithm: params.algorithm,
  }
}

function buildSigningString(
  headers: string[],
  requestHeaders: Record<string, string>,
  method: string,
  path: string
): string {
  return headers.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${method.toLowerCase()} ${path}`
    }
    const val = requestHeaders[h.toLowerCase()]
    if (val === undefined) throw new Error(`Missing header for signing: ${h}`)
    return `${h}: ${val}`
  }).join('\n')
}

export async function verifySignature(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ valid: boolean; actorApId?: string; error?: string }> {
  const sigHeader = headers['signature']
  if (!sigHeader) return { valid: false, error: 'Missing Signature header' }

  const params = parseSignatureHeader(sigHeader)
  if (!params) return { valid: false, error: 'Invalid Signature header format' }

  // Check Date freshness (30-second window)
  const dateStr = headers['date']
  if (dateStr) {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = Math.abs(now.getTime() - date.getTime())
    if (diff > 30_000) {
      return { valid: false, error: `Date too skewed: ${diff}ms` }
    }
  }

  // Verify Digest if present
  const digestHeader = headers['digest']
  if (digestHeader) {
    const expected = await computeDigest(body)
    if (digestHeader !== expected) {
      return { valid: false, error: 'Digest mismatch' }
    }
  }

  // Fetch the actor to get their public key
  const keyIdUrl = params.keyId.split('#')[0]
  let actor
  try {
    actor = await fetchActor(keyIdUrl)
  } catch (e) {
    return { valid: false, error: `Could not fetch actor: ${e}` }
  }

  let publicKey: CryptoKey
  try {
    if (!actor.publicKeyPem) return { valid: false, error: 'Actor has no public key (non-AP actor)' }
    publicKey = await importPublicKeyFromPem(actor.publicKeyPem)
  } catch (e) {
    return { valid: false, error: `Could not import public key: ${e}` }
  }

  const urlObj = new URL(url)
  const path = urlObj.pathname + urlObj.search

  let signingString: string
  try {
    signingString = buildSigningString(params.headers, headers, method, path)
  } catch (e) {
    return { valid: false, error: `${e}` }
  }

  const sigBytes = Buffer.from(params.signature, 'base64')
  const sigStringBytes = new TextEncoder().encode(signingString)

  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    sigBytes,
    sigStringBytes
  )

  return { valid, actorApId: actor.apId }
}

export async function computeDigest(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return `SHA-256=${Buffer.from(hash).toString('base64')}`
}

export async function signRequest(
  method: string,
  targetUrl: string,
  body: string
): Promise<Record<string, string>> {
  const url = new URL(targetUrl)
  const date = new Date().toUTCString()
  const digest = await computeDigest(body)
  const path = url.pathname + url.search
  const host = url.host
  const actorUrl = `https://${config.APP_DOMAIN}/actor`
  const keyId = `${actorUrl}#main-key`

  const headersToSign = ['(request-target)', 'host', 'date', 'digest']
  const signingString = buildSigningString(
    headersToSign,
    { host, date, digest },
    method,
    path
  )

  const privateKey = getPrivateKey()
  const sigBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingString)
  )
  const signature = Buffer.from(sigBytes).toString('base64')

  const sigHeader = `keyId="${keyId}",algorithm="rsa-sha256",headers="${headersToSign.join(' ')}",signature="${signature}"`

  return {
    Date: date,
    Digest: digest,
    Signature: sigHeader,
    Host: host,
  }
}
