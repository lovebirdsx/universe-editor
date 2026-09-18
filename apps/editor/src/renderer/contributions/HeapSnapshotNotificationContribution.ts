/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  把堆快照轮次的报告显示出来。刻意做薄：轮次归 main 管（策略、预算、身份），这里只把报告
 *  变成通知，renderer 永远不能成为「决定几秒冻结可以接受」的那一方。
 *
 *  报告带每窗口递增的 revision。窗口 reload 期间结束的轮次仍可能迟到一条报告，凡是不高于
 *  已显示 revision 的一律丢弃，被顶替的轮次就无法盖在新鲜的那轮上自我宣告。
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IWorkbenchContribution,
  Severity,
  localize,
} from '@universe-editor/platform'
import { IDiagnosticsService, type HeapSnapshotEvent } from '../../shared/ipc/services.js'
import { describeHeapSnapshotEvent } from '../services/diagnostics/heapSnapshotMessages.js'

export class HeapSnapshotNotificationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _lastRevision = 0

  constructor(
    @IDiagnosticsService private readonly _diagnostics: IDiagnosticsService,
    @INotificationService private readonly _notifications: INotificationService,
  ) {
    super()
    this._register(this._diagnostics.onDidChangeHeapSnapshot((event) => this._onEvent(event)))
  }

  private _onEvent(event: HeapSnapshotEvent): void {
    // 每窗口单调递增；而且 main 已经在更前面按窗口过滤过了。
    if (event.revision <= this._lastRevision) return
    this._lastRevision = event.revision

    const { severity, text, reveal } = describeHeapSnapshotEvent(event)
    this._notifications.notify({
      severity,
      message: text,
      // 用户没要过的停止、失败、以及跑完的轮次不能悄悄滚走；过程播报可以。
      sticky: event.kind !== 'started' && event.kind !== 'notice',
      ...(reveal
        ? {
            actions: [
              {
                label: localize('heapSnapshot.openFolder', 'Open Snapshots Folder'),
                run: () => {
                  void this._diagnostics.revealHeapSnapshotsFolder().catch((err: unknown) => {
                    this._notifications.notify({
                      severity: Severity.Error,
                      message: localize(
                        'heapSnapshot.revealFailed',
                        'Could not open the snapshots folder: {message}',
                        { message: err instanceof Error ? err.message : String(err) },
                      ),
                    })
                  })
                },
              },
            ],
          }
        : {}),
    })
  }
}
