import { expect, type Page } from '@playwright/test'
import type { E2ERecentTarget } from '@universe-editor/e2e-contract'

// 焦点同步到 MRU 有延迟；先只读等待，避免打开 picker 时快照到旧顺序。
export async function waitForRecentTargetHead(
  page: Page,
  kind: E2ERecentTarget['kind'],
  id: string,
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getRecentTargets()[0]))
    .toEqual({ kind, id })
}
