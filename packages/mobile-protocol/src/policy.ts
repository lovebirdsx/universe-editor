/*---------------------------------------------------------------------------------------------
 *  Mobile safety policy shared by the gateway (main) and the session bridge
 *  (renderer). Both endpoints enforce the same rules: the bridge rejects a
 *  command before it reaches ACP, the gateway rejects it again in case a
 *  renderer is out of date or compromised. Keeping the predicates here means
 *  the two checks and the `allowedOnMobile` projection cannot drift.
 *--------------------------------------------------------------------------------------------*/

/**
 * Permission option ids that carry a durable side effect even when an agent
 * mislabels their `kind` (the Claude fork spells scoped grants as
 * `allow-with-updates`; its skill grants are persistent too). Every
 * `allow_always` option is rejected as well; these ids are the belt-and-braces
 * net for option contracts that do not set `kind` correctly.
 */
const HIGH_RISK_PERMISSION_OPTION_IDS: ReadonlySet<string> = new Set([
  'allow-with-updates',
  'allow-skill-exact',
  'allow-skill-prefix',
  'exit-plan-bypass',
])

/**
 * Values a mode/config select can carry that disable the permission system.
 * Claude exposes `bypassPermissions`; the codex fork exposes
 * `agent-full-access`; both are also accepted in their codex/CLI aliases.
 * Comparison is case-insensitive because agents spell the same concept with
 * camelCase, kebab-case and snake_case.
 */
const HIGH_RISK_CONFIG_VALUES: ReadonlySet<string> = new Set([
  'bypasspermissions',
  'bypass',
  'dangerously-skip-permissions',
  'agent-full-access',
  'danger-full-access',
  'full-access',
  'full_access',
])

/**
 * True when selecting this option would write a persistent allow rule or
 * otherwise turn off permission checks. This is exactly the set a phone may
 * not choose during the first release (docs/development/mobile-gateway.md §7).
 */
export function isHighRiskPermissionOption(option: {
  readonly optionId: string
  readonly kind?: string
}): boolean {
  if (option.kind === 'allow_always') return true
  const id = option.optionId.toLowerCase()
  return id.includes('bypass') || HIGH_RISK_PERMISSION_OPTION_IDS.has(id)
}

/** True when this value would switch a session into bypass / full-access mode. */
export function isHighRiskConfigValue(value: string | boolean): boolean {
  if (typeof value !== 'string') return false
  return HIGH_RISK_CONFIG_VALUES.has(value.toLowerCase())
}

/** The wire-level projection of {@link isHighRiskPermissionOption}. */
export function isPermissionOptionAllowedOnMobile(option: {
  readonly optionId: string
  readonly kind?: string
}): boolean {
  return !isHighRiskPermissionOption(option)
}

/** The wire-level projection of {@link isHighRiskConfigValue}. */
export function isConfigValueAllowedOnMobile(value: string | boolean): boolean {
  return !isHighRiskConfigValue(value)
}
