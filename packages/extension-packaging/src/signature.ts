/**
 * Marketplace signing for VSIX payloads. The gallery signs each published VSIX
 * with the marketplace Ed25519 private key (offline, at publish time); the
 * client verifies against the built-in public key(s) before installing, so a
 * tampered or re-hosted package cannot pass even if registry metadata is
 * forged. The signature covers the raw file bytes — Ed25519 hashes internally,
 * so we sign bytes directly rather than a hex digest.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface IVsixSignature {
  readonly algorithm: string
  readonly keyId: string
  /** base64-encoded Ed25519 signature over the raw VSIX bytes. */
  readonly value: string
}

export type VsixSignatureFailure =
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'hash-mismatch'
  | 'invalid-signature'

export class VsixSignatureError extends Error {
  constructor(
    readonly code: VsixSignatureFailure,
    message: string,
  ) {
    super(message)
    this.name = 'VsixSignatureError'
  }
}

/** sha256 (hex) of the VSIX file — fast integrity check + debugging aid. */
export async function hashVsixFile(vsixPath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(vsixPath))
    .digest('hex')
}

/**
 * Verify a downloaded VSIX against the hash + signature advertised by the
 * marketplace. `publicKeys` maps keyId → base64url JWK `x` of an Ed25519
 * public key. Fail-closed: any mismatch throws {@link VsixSignatureError}.
 */
export async function verifyVsixSignature(
  vsixPath: string,
  expected: { readonly hash: string; readonly signature: IVsixSignature },
  publicKeys: Readonly<Record<string, string>>,
): Promise<void> {
  const { hash, signature } = expected
  if (signature.algorithm !== 'ed25519') {
    throw new VsixSignatureError(
      'unsupported-algorithm',
      `unsupported VSIX signature algorithm "${signature.algorithm}"`,
    )
  }
  const x = publicKeys[signature.keyId]
  if (x === undefined) {
    throw new VsixSignatureError('unknown-key', `unknown VSIX signing key "${signature.keyId}"`)
  }
  const bytes = await readFile(vsixPath)
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== hash) {
    throw new VsixSignatureError(
      'hash-mismatch',
      `VSIX hash mismatch: expected ${hash}, got ${actualHash}`,
    )
  }
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  if (!verify(null, bytes, publicKey, Buffer.from(signature.value, 'base64'))) {
    throw new VsixSignatureError('invalid-signature', 'VSIX signature verification failed')
  }
}
