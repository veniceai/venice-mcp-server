import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto'

/**
 * Caller-side Venice E2EE primitives for tests, following
 * https://docs.venice.ai/guides/features/tee-e2ee-models: secp256k1 ECDH,
 * HKDF-SHA256 (no salt, info "ecdsa_encryption"), AES-256-GCM, and hex output
 * of ephemeral_pub (65) || nonce (12) || ciphertext || tag (16).
 */
const HKDF_INFO = 'ecdsa_encryption'

export interface E2eeKeyPair {
  ecdh: ECDH
  publicKeyHex: string
}

export function generateE2eeKeyPair(): E2eeKeyPair {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  return { ecdh, publicKeyHex: ecdh.getPublicKey('hex', 'uncompressed') }
}

function deriveAesKey(ecdh: ECDH, peerPublicKey: Buffer): Buffer {
  const sharedSecret = ecdh.computeSecret(peerPublicKey)
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, 32))
}

export function encryptForE2ee(plaintext: string, recipientPublicKeyHex: string): string {
  const ephemeral = createECDH('secp256k1')
  ephemeral.generateKeys()
  const key = deriveAesKey(ephemeral, Buffer.from(recipientPublicKeyHex, 'hex'))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([ephemeral.getPublicKey(undefined, 'uncompressed'), nonce, ciphertext]).toString('hex')
}

export function decryptE2ee(ciphertextHex: string, recipient: E2eeKeyPair): string {
  const raw = Buffer.from(ciphertextHex, 'hex')
  const key = deriveAesKey(recipient.ecdh, raw.subarray(0, 65))
  const nonce = raw.subarray(65, 77)
  const tag = raw.subarray(raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(raw.subarray(77, raw.length - 16)), decipher.final()]).toString('utf8')
}

/** One client/model key pair plus ciphertext in each direction, generated per test run. */
export function e2eeSession() {
  const client = generateE2eeKeyPair()
  const model = generateE2eeKeyPair()
  return {
    client,
    model,
    headers: {
      client_public_key: client.publicKeyHex,
      model_public_key: model.publicKeyHex,
      signing_algorithm: 'ecdsa' as const,
    },
    encryptToModel: (plaintext: string) => encryptForE2ee(plaintext, model.publicKeyHex),
    encryptToClient: (plaintext: string) => encryptForE2ee(plaintext, client.publicKeyHex),
  }
}
