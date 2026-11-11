import {
  MOBILE_DELIVERY_PHASES,
  type MobileDeliveryDetail,
  type MobileDeliveryPreview,
  type MobileDeliveryStartResult,
  type MobileRewindPreview,
  type MobileRewindResult,
  type MobileSessionHistoryEntry,
  type MobileSessionRef,
  type MobileSessionRefResult,
  type MobileSideTaskSummary,
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
