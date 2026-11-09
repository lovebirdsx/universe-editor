import type {
  MobileRewindPreview,
  MobileRewindResult,
  MobileSessionRef,
  MobileSessionRefResult,
  MobileSideTaskSummary,
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
