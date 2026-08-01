import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign, createPublicKey, createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  hashVsixFile,
  verifyVsixSignature,
  VsixSignatureError,
  type IVsixSignature,
} from '../signature.js'

const KEY_ID = 'market-test'

function makeKeyPair(): {
  publicX: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  return { publicX: jwk.x as string, privateKey }
}

function signBytes(
  bytes: Buffer,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): IVsixSignature {
  return {
    algorithm: 'ed25519',
    keyId: KEY_ID,
    value: sign(null, bytes, privateKey).toString('base64'),
  }
}

describe('verifyVsixSignature', () => {
  let dir: string
  let vsixPath: string
  const payload = Buffer.from('fake-vsix-payload')
  const { publicX, privateKey } = makeKeyPair()
  const keys = { [KEY_ID]: publicX }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vsix-sign-'))
    vsixPath = path.join(dir, 'ext.vsix')
    await writeFile(vsixPath, payload)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('hashVsixFile matches an independent sha256', async () => {
    expect(await hashVsixFile(vsixPath)).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('passes for a correctly signed package', async () => {
    const hash = createHash('sha256').update(payload).digest('hex')
    await expect(
      verifyVsixSignature(vsixPath, { hash, signature: signBytes(payload, privateKey) }, keys),
    ).resolves.toBeUndefined()
  })

  it('rejects a tampered package with hash-mismatch', async () => {
    const otherHash = createHash('sha256').update(Buffer.from('other')).digest('hex')
    const err = await verifyVsixSignature(
      vsixPath,
      { hash: otherHash, signature: signBytes(payload, privateKey) },
      keys,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VsixSignatureError)
    expect((err as VsixSignatureError).code).toBe('hash-mismatch')
  })

  it('rejects an unknown keyId', async () => {
    const hash = createHash('sha256').update(payload).digest('hex')
    const signature = { ...signBytes(payload, privateKey), keyId: 'market-unknown' }
    const err = await verifyVsixSignature(vsixPath, { hash, signature }, keys).catch(
      (e: unknown) => e,
    )
    expect((err as VsixSignatureError).code).toBe('unknown-key')
  })

  it('rejects an unsupported algorithm', async () => {
    const hash = createHash('sha256').update(payload).digest('hex')
    const signature = { ...signBytes(payload, privateKey), algorithm: 'rsa' }
    const err = await verifyVsixSignature(vsixPath, { hash, signature }, keys).catch(
      (e: unknown) => e,
    )
    expect((err as VsixSignatureError).code).toBe('unsupported-algorithm')
  })

  it('rejects a forged signature over the real bytes', async () => {
    const hash = createHash('sha256').update(payload).digest('hex')
    const attacker = makeKeyPair()
    const forged = signBytes(payload, attacker.privateKey)
    const err = await verifyVsixSignature(vsixPath, { hash, signature: forged }, keys).catch(
      (e: unknown) => e,
    )
    expect((err as VsixSignatureError).code).toBe('invalid-signature')
  })

  it('public key round-trips through JWK x (the built-in key format)', () => {
    const restored = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicX },
      format: 'jwk',
    })
    expect(restored.export({ format: 'jwk' }).x).toBe(publicX)
  })
})
