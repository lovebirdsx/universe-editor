import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'

/** The phone's mirror of `isSessionWorking` on the editor side. */
export function isSessionWorking(
  summary: Pick<MobileSessionSummary, 'bucket' | 'backgroundTaskCount'>,
): boolean {
  return (
    summary.bucket === 'in_progress' ||
    summary.bucket === 'input_needed' ||
    summary.backgroundTaskCount > 0
  )
}
