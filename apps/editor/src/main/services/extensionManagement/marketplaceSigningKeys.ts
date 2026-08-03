/*---------------------------------------------------------------------------------------------
 *  Marketplace VSIX signing keys (keyId → base64url JWK `x` of an Ed25519 public key).
 *
 *  The marketplace signs every published VSIX with its offline private key
 *  (scripts/gallery/publish.mjs --signing-key-file); gallery installs verify the
 *  signature against these public keys and refuse unsigned/invalid packages
 *  (fail-closed). The matching private key lives only on the ops machine / CI
 *  secret — never in this repo.
 *
 *  Rotation: generate `market-v2` (pnpm gallery:keygen), add it here keeping the
 *  old id, roll out clients, then switch the publisher to --key-id market-v2.
 *  Clients without the new key fail closed, so the publish switch must wait for
 *  client rollout.
 *
 *  `UNIVERSE_GALLERY_SIGNING_KEYS` (JSON {"<keyId>": "<x>"}) merges over the
 *  built-in map — a dev/e2e seam for test key pairs, not a user-facing setting.
 *--------------------------------------------------------------------------------------------*/

export const BUILTIN_MARKETPLACE_SIGNING_KEYS: Readonly<Record<string, string>> = {
  'market-v1': 'ygBMXrD6w96p8I0uYBejToWvqU8DUer--4cWJ676A-g',
}

/**
 * Resolve the effective key map: built-ins overlaid with the env-provided JSON.
 * A malformed env value degrades to the built-in map (the env is a dev seam and
 * must never break startup).
 */
export function resolveMarketplaceSigningKeys(envJson?: string): Record<string, string> {
  const keys: Record<string, string> = { ...BUILTIN_MARKETPLACE_SIGNING_KEYS }
  if (envJson) {
    try {
      const parsed: unknown = JSON.parse(envJson)
      if (parsed && typeof parsed === 'object') {
        for (const [keyId, x] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof x === 'string') keys[keyId] = x
        }
      }
    } catch {
      // fall through with built-ins only
    }
  }
  return keys
}
