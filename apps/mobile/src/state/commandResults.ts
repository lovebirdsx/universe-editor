import {
  isValidCommitHash,
  MAX_COMMIT_PROMPT_REFS,
  MAX_ID_LENGTH,
  MAX_MCP_SERVERS,
  MAX_NEW_SESSION_PROJECT_ROOTS,
  MAX_PROMPT_REF_COMMIT_TEXT_LENGTH,
  MAX_PROMPT_REF_DESCRIPTION_LENGTH,
  MAX_PROMPT_REF_DIR_PATH_LENGTH,
  MAX_PROMPT_REF_LABEL_LENGTH,
  MAX_PROMPT_REF_STATUS_LENGTH,
  MAX_PROMPT_REF_SUGGESTIONS,
  MAX_PROMPT_REF_TEXT_LENGTH,
  MAX_PROMPT_REF_URI_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_SUBAGENT_MODEL_CANDIDATES,
  MAX_TITLE_LENGTH,
  MOBILE_DELIVERY_PHASES,
  MOBILE_MCP_TRANSPORTS,
  MOBILE_PROMPT_REF_KINDS,
  parseWorkspaceRelativePath,
  type MobileDeliveryDetail,
  type MobileDeliveryPreview,
  type MobileDeliveryStartResult,
  type MobileDirectoryEntry,
  type MobileDirectoryListing,
  type MobileNewSessionOptions,
  type MobilePromptRef,
  type MobilePromptRefResolveKind,
  type MobilePromptRefSuggestion,
  type MobilePromptRefSuggestionsResult,
  type MobilePushBranchPreview,
  type MobilePushBranchResult,
  type MobileRewindPreview,
  type MobileRewindResult,
  type MobileSessionHistoryEntry,
  type MobileSessionRef,
  type MobileSessionRefResult,
  type MobileSessionSettings,
  type MobileSideTaskSummary,
  type ResolvePromptRefResult,
} from '@universe-editor/mobile-protocol'

/**
 * Runtime guards for command results the gateway sends as opaque JSON. The
 * server is trusted for its own shape, but a version-skewed or buggy PC must
 * surface `invalid_response` instead of crashing the renderer.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return isNonEmptyString(value) && value.length <= max
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isMobileSessionRef(value: unknown): value is MobileSessionRef {
  if (!isRecord(value)) return false
  if (!isNonNegativeInteger(value['windowId'])) return false
  if (!isNonEmptyString(value['localId'])) return false
  const durableId = value['durableId']
  return durableId === undefined || isNonEmptyString(durableId)
}

export function isMobileSessionRefResult(value: unknown): value is MobileSessionRefResult {
  return isRecord(value) && isMobileSessionRef(value['ref'])
}

function isWorkspaceRelativePath(value: unknown): value is string {
  return typeof value === 'string' && parseWorkspaceRelativePath(value)?.path === value
}

function isMobileDirectoryEntry(value: unknown): value is MobileDirectoryEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value['name']) &&
    !value['name'].includes('/') &&
    isWorkspaceRelativePath(value['relativePath'])
  )
}

export function isMobileDirectoryListing(value: unknown): value is MobileDirectoryListing {
  if (!isRecord(value)) return false
  if (!isWorkspaceRelativePath(value['relativePath'])) return false
  const parent = value['parentRelativePath']
  if (parent !== undefined && !isWorkspaceRelativePath(parent)) return false
  if (!Array.isArray(value['entries']) || !value['entries'].every(isMobileDirectoryEntry)) {
    return false
  }
  const truncated = value['truncated']
  return truncated === undefined || typeof truncated === 'boolean'
}

function isNonEmptyWorkspaceRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== '' && parseWorkspaceRelativePath(value)?.path === value
  )
}

export function isMobileNewSessionOptions(value: unknown): value is MobileNewSessionOptions {
  if (!isRecord(value)) return false
  const last = value['lastRelativePath']
  if (last !== undefined && !isNonEmptyWorkspaceRelativePath(last)) return false
  const roots = value['projectRoots']
  return (
    Array.isArray(roots) &&
    roots.length <= MAX_NEW_SESSION_PROJECT_ROOTS &&
    roots.every(isNonEmptyWorkspaceRelativePath)
  )
}

export function isMobileRewindPreview(value: unknown): value is MobileRewindPreview {
  if (!isRecord(value)) return false
  if (typeof value['canRewind'] !== 'boolean') return false
  if (value['error'] !== undefined && typeof value['error'] !== 'string') return false
  if (!isNonNegativeInteger(value['filesChanged'])) return false
  if (value['insertions'] !== undefined && !isFiniteNumber(value['insertions'])) return false
  if (value['deletions'] !== undefined && !isFiniteNumber(value['deletions'])) return false
  return true
}

export function isMobileRewindResult(value: unknown): value is MobileRewindResult {
  if (!isRecord(value)) return false
  if (typeof value['canRewind'] !== 'boolean') return false
  if (value['error'] !== undefined && typeof value['error'] !== 'string') return false
  if (value['text'] !== undefined && typeof value['text'] !== 'string') return false
  return true
}

export function isMobileSideTaskSummary(value: unknown): value is MobileSideTaskSummary {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['id']) &&
    // A legacy history row may have no title; the sheet renders a placeholder.
    typeof value['title'] === 'string' &&
    isFiniteNumber(value['lastUsedAt']) &&
    typeof value['live'] === 'boolean'
  )
}

export function isMobileSideTaskList(value: unknown): value is readonly MobileSideTaskSummary[] {
  return Array.isArray(value) && value.every(isMobileSideTaskSummary)
}

export function isMobileSessionHistoryEntry(value: unknown): value is MobileSessionHistoryEntry {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['durableId'])) return false
  const windowId = value['windowId']
  if (windowId !== undefined && !isNonNegativeInteger(windowId)) return false
  if (!isNonEmptyString(value['agentId'])) return false
  const agentName = value['agentName']
  if (agentName !== undefined && typeof agentName !== 'string') return false
  if (typeof value['title'] !== 'string') return false
  const firstPrompt = value['firstPrompt']
  if (firstPrompt !== undefined && typeof firstPrompt !== 'string') return false
  if (typeof value['workspaceName'] !== 'string') return false
  const folder = value['folder']
  if (folder !== undefined && typeof folder !== 'string') return false
  const cwd = value['cwd']
  if (cwd !== undefined && typeof cwd !== 'string') return false
  const authority = value['authority']
  if (authority !== undefined && typeof authority !== 'string') return false
  if (!isFiniteNumber(value['createdAt'])) return false
  if (!isFiniteNumber(value['lastUsedAt'])) return false
  const pinned = value['pinned']
  return pinned === undefined || typeof pinned === 'boolean'
}

export function isMobileSessionHistoryList(
  value: unknown,
): value is readonly MobileSessionHistoryEntry[] {
  return Array.isArray(value) && value.every(isMobileSessionHistoryEntry)
}

function isDeliveryPhase(value: unknown): boolean {
  return typeof value === 'string' && (MOBILE_DELIVERY_PHASES as readonly string[]).includes(value)
}

function isDeliverySummary(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['deliveryId']) &&
    isDeliveryPhase(value['phase']) &&
    isNonNegativeInteger(value['commitCount']) &&
    typeof value['dirtySource'] === 'boolean' &&
    isNonEmptyString(value['mainBranch']) &&
    isFiniteNumber(value['updatedAt']) &&
    typeof value['canConfirmPush'] === 'boolean' &&
    typeof value['canRetry'] === 'boolean' &&
    typeof value['canUndo'] === 'boolean' &&
    isRecord(value['sync'])
  )
}

export function isMobileDeliveryPreview(value: unknown): value is MobileDeliveryPreview {
  if (!isRecord(value)) return false
  const source = value['source']
  const target = value['target']
  if (!isRecord(source) || !isRecord(target)) return false
  if (!isNonEmptyString(source['worktreeName']) || !isNonEmptyString(source['head'])) return false
  if (typeof source['dirty'] !== 'boolean' || typeof source['isMainWorktree'] !== 'boolean') {
    return false
  }
  if (!isNonEmptyString(target['mainBranch']) || !isNonEmptyString(target['mainHead'])) {
    return false
  }
  return (
    Array.isArray(value['commits']) &&
    Array.isArray(value['blockers']) &&
    Array.isArray(value['warnings']) &&
    typeof value['forkSupported'] === 'boolean' &&
    isRecord(value['expectation'])
  )
}

export function isMobileDeliveryDetail(value: unknown): value is MobileDeliveryDetail {
  if (!isRecord(value)) return false
  if (!isDeliverySummary(value['summary'])) return false
  if (!isRecord(value['source']) || !isRecord(value['target'])) return false
  return (
    Array.isArray(value['commits']) &&
    Array.isArray(value['conflictFiles']) &&
    Array.isArray(value['syncResults'])
  )
}

export function isMobileDeliveryStartResult(value: unknown): value is MobileDeliveryStartResult {
  return isRecord(value) && isNonEmptyString(value['deliveryId'])
}

export function isMobilePushBranchPreview(value: unknown): value is MobilePushBranchPreview {
  if (!isRecord(value)) return false
  const source = value['source']
  const remote = value['remote']
  if (!isRecord(source) || !isRecord(remote)) return false
  if (
    !isNonEmptyString(source['worktreeName']) ||
    !isNonEmptyString(source['branch']) ||
    !isNonEmptyString(source['head']) ||
    typeof source['dirty'] !== 'boolean' ||
    typeof source['isMainWorktree'] !== 'boolean'
  ) {
    return false
  }
  if (
    !isNonEmptyString(remote['name']) ||
    !isNonEmptyString(remote['branch']) ||
    typeof remote['exists'] !== 'boolean' ||
    !isNonNegativeInteger(remote['ahead']) ||
    !isNonNegativeInteger(remote['behind'])
  ) {
    return false
  }
  return (
    Array.isArray(value['blockers']) &&
    Array.isArray(value['warnings']) &&
    isRecord(value['expectation'])
  )
}

export function isMobilePushBranchResult(value: unknown): value is MobilePushBranchResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value['branch']) &&
    isNonEmptyString(value['remote']) &&
    isNonEmptyString(value['remoteBranch']) &&
    isNonEmptyString(value['head']) &&
    typeof value['published'] === 'boolean'
  )
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** chatContext bodies may span lines; other C0 controls and DEL are still unsafe. */
const UNSAFE_MULTILINE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function isPrintableText(value: unknown, max: number): value is string {
  return isBoundedNonEmptyString(value, max) && !CONTROL_CHARS.test(value)
}

function isSafeMultilineText(value: unknown, max: number): value is string {
  return isBoundedNonEmptyString(value, max) && !UNSAFE_MULTILINE_CHARS.test(value)
}

function isMobilePromptRefKindValue(value: unknown): value is string {
  return typeof value === 'string' && (MOBILE_PROMPT_REF_KINDS as readonly string[]).includes(value)
}

export function isMobilePromptRefSuggestion(value: unknown): value is MobilePromptRefSuggestion {
  if (!isRecord(value)) return false
  const kind = value['kind']
  if (!isMobilePromptRefKindValue(kind)) return false
  const label = value['label']
  if (!isBoundedNonEmptyString(label, MAX_PROMPT_REF_LABEL_LENGTH) || CONTROL_CHARS.test(label)) {
    return false
  }
  const uri = value['uri']
  if (kind === 'chatContext') {
    if (uri !== '') return false
  } else if (kind === 'commit') {
    // The search entry has no URI; the resolved entry carries the repo root.
    if (typeof uri !== 'string' || uri.length > MAX_PROMPT_REF_URI_LENGTH) return false
  } else if (!isBoundedNonEmptyString(uri, MAX_PROMPT_REF_URI_LENGTH)) {
    return false
  }
  const description = value['description']
  if (
    description !== undefined &&
    (!isBoundedString(description, MAX_PROMPT_REF_DESCRIPTION_LENGTH) ||
      CONTROL_CHARS.test(description))
  ) {
    return false
  }
  const scmStatus = value['scmStatus']
  if (
    scmStatus !== undefined &&
    (!isBoundedNonEmptyString(scmStatus, MAX_PROMPT_REF_STATUS_LENGTH) ||
      CONTROL_CHARS.test(scmStatus))
  ) {
    return false
  }
  const dirPath = value['dirPath']
  if (
    dirPath !== undefined &&
    (!isBoundedNonEmptyString(dirPath, MAX_PROMPT_REF_DIR_PATH_LENGTH) ||
      CONTROL_CHARS.test(dirPath))
  ) {
    return false
  }
  for (const key of ['line', 'column'] as const) {
    if (value[key] !== undefined && !isPositiveInteger(value[key])) return false
  }
  if (value['symbolKind'] !== undefined && !isNonNegativeInteger(value['symbolKind'])) return false
  const commitHash = value['commitHash']
  if (commitHash !== undefined) {
    if (kind !== 'commit' || typeof commitHash !== 'string' || !isValidCommitHash(commitHash)) {
      return false
    }
  }
  const chatContextHandle = value['chatContextHandle']
  if (chatContextHandle !== undefined) {
    if (kind !== 'chatContext' || !isPositiveInteger(chatContextHandle)) return false
  }
  const text = value['text']
  if (text !== undefined) {
    if (kind === 'commit') {
      if (!isPrintableText(text, MAX_PROMPT_REF_COMMIT_TEXT_LENGTH)) return false
    } else if (kind === 'chatContext') {
      if (!isSafeMultilineText(text, MAX_PROMPT_REF_TEXT_LENGTH)) return false
    } else {
      return false
    }
  }
  // A docs entry without its directory cannot be validated or forwarded.
  return kind !== 'docs' || isNonEmptyString(dirPath)
}

function isFinalCommitSuggestion(value: unknown): value is MobilePromptRefSuggestion {
  if (!isMobilePromptRefSuggestion(value) || value.kind !== 'commit') return false
  return (
    value.uri !== '' &&
    typeof value.commitHash === 'string' &&
    isValidCommitHash(value.commitHash) &&
    isPrintableText(value.text, MAX_PROMPT_REF_COMMIT_TEXT_LENGTH)
  )
}

function isFinalChatContextSuggestion(value: unknown): value is MobilePromptRefSuggestion {
  if (!isMobilePromptRefSuggestion(value) || value.kind !== 'chatContext') return false
  // The picker handle belongs to the search entry only; sending it would make
  // the protocol reject the whole prompt.
  return (
    value.uri === '' &&
    value.chatContextHandle === undefined &&
    isSafeMultilineText(value.text, MAX_PROMPT_REF_TEXT_LENGTH)
  )
}

export function isResolvePromptRefResult(
  value: unknown,
  expectedKind: MobilePromptRefResolveKind,
): value is ResolvePromptRefResult {
  if (!isRecord(value) || value['kind'] !== expectedKind) return false
  if (expectedKind === 'commit') {
    return (
      Array.isArray(value['entries']) &&
      value['entries'].length <= MAX_COMMIT_PROMPT_REFS &&
      value['entries'].every(isFinalCommitSuggestion)
    )
  }
  const entry = value['entry']
  return entry === undefined || isFinalChatContextSuggestion(entry)
}

/**
 * Draft-restoration / send guard: unlike a search suggestion, a sendable ref
 * must carry every field the gateway rebuilds from (commit hash + subject,
 * chatContext body) and a well-formed range. The suggestion guard runs first so
 * the display fields (description / scmStatus / line / column) stay bounded
 * too — the protocol rejects the whole prompt over any of them.
 */
export function isSendableMobilePromptRef(value: unknown): value is MobilePromptRef {
  if (!isMobilePromptRefSuggestion(value)) return false
  const candidate = value as MobilePromptRef
  if (
    !isNonNegativeInteger(candidate.start) ||
    !isNonNegativeInteger(candidate.end) ||
    candidate.end <= candidate.start
  ) {
    return false
  }
  if (candidate.kind === 'chatContext') {
    return (
      candidate.chatContextHandle === undefined &&
      isSafeMultilineText(candidate.text, MAX_PROMPT_REF_TEXT_LENGTH)
    )
  }
  if (candidate.uri === '') return false
  if (candidate.kind === 'commit') {
    return (
      typeof candidate.commitHash === 'string' &&
      isValidCommitHash(candidate.commitHash) &&
      isPrintableText(candidate.text, MAX_PROMPT_REF_COMMIT_TEXT_LENGTH) &&
      candidate.chatContextHandle === undefined
    )
  }
  return (
    candidate.commitHash === undefined &&
    candidate.text === undefined &&
    candidate.chatContextHandle === undefined
  )
}

export function isMobilePromptRefSuggestionsResult(
  value: unknown,
): value is MobilePromptRefSuggestionsResult {
  return (
    isRecord(value) &&
    Array.isArray(value['entries']) &&
    value['entries'].length <= MAX_PROMPT_REF_SUGGESTIONS &&
    value['entries'].every(isMobilePromptRefSuggestion)
  )
}

function isMcpTransport(value: unknown): boolean {
  return typeof value === 'string' && (MOBILE_MCP_TRANSPORTS as readonly string[]).includes(value)
}

function isMcpNameList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MCP_SERVERS &&
    value.every((entry) => isBoundedNonEmptyString(entry, MAX_ID_LENGTH))
  )
}

export function isMobileSessionSettings(value: unknown): value is MobileSessionSettings {
  if (!isRecord(value) || typeof value['canEdit'] !== 'boolean') return false

  const subagent = value['subagentModel']
  if (!isRecord(subagent) || typeof subagent['supported'] !== 'boolean') return false
  const current = subagent['current']
  if (current !== null && !isBoundedNonEmptyString(current, MAX_TITLE_LENGTH)) return false
  const candidates = subagent['candidates']
  if (
    !Array.isArray(candidates) ||
    candidates.length > MAX_SUBAGENT_MODEL_CANDIDATES ||
    !candidates.every((entry) => isBoundedNonEmptyString(entry, MAX_TITLE_LENGTH))
  ) {
    return false
  }

  const mcp = value['mcp']
  if (!isRecord(mcp)) return false
  const pool = mcp['pool']
  if (!Array.isArray(pool) || pool.length > MAX_MCP_SERVERS) return false
  for (const entry of pool) {
    if (!isRecord(entry)) return false
    if (!isBoundedNonEmptyString(entry['name'], MAX_ID_LENGTH)) return false
    if (!isMcpTransport(entry['transport'])) return false
    if (typeof entry['defaultDisabled'] !== 'boolean') return false
  }
  const selection = mcp['selection']
  if (selection !== null && !isMcpNameList(selection)) return false
  if (!isMcpNameList(mcp['enabled'])) return false
  const live = mcp['live']
  if (!Array.isArray(live) || live.length > MAX_MCP_SERVERS) return false
  for (const entry of live) {
    if (!isRecord(entry)) return false
    if (!isBoundedNonEmptyString(entry['name'], MAX_ID_LENGTH)) return false
    if (!isBoundedString(entry['status'], MAX_STATUS_LENGTH)) return false
    if (entry['transport'] !== undefined && !isMcpTransport(entry['transport'])) return false
  }
  return true
}
