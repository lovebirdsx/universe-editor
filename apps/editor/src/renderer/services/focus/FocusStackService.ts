/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FocusStackService — bounded-size focus history backed by IFocusTrackerService.
 *
 *  Subscribes to the global focus tracker, resolves each settled focus event to
 *  a (partId, viewId?, groupId?) tuple by walking up data-* attributes on the
 *  active element, and appends an entry. Consecutive duplicates collapse so
 *  e.g. rapid input clicks don't fill the stack.
 *
 *  Consumers:
 *   - F6 / Shift+F6 navigation
 *   - Monaco blur arbitration (FileEditor) — only restore focus if the user
 *     hasn't moved away in the meantime
 *   - LayoutService.focusPart — for SideBar/Panel/AuxBar, refocus the
 *     lastFocusedView if any
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  type IFocusChangeEvent,
  IFocusTrackerService,
  type IFocusEntry,
  type IFocusStackService,
  ILayoutService,
  PartId,
  ViewRegistry,
} from '@universe-editor/platform'
import { IViewContainerMemoryService } from './ViewContainerMemoryService.js'

const MAX_DEPTH = 16

const PART_ORDER: readonly PartId[] = [
  PartId.ActivityBar,
  PartId.SideBar,
  PartId.EditorArea,
  PartId.Panel,
  PartId.SecondarySideBar,
  PartId.StatusBar,
]

export class FocusStackService extends Disposable implements IFocusStackService {
  declare readonly _serviceBrand: undefined

  private readonly _entries: IFocusEntry[] = []
  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  constructor(
    @IFocusTrackerService tracker: IFocusTrackerService,
    @ILayoutService private readonly _layoutService: ILayoutService,
    @IViewContainerMemoryService private readonly _memory: IViewContainerMemoryService,
  ) {
    super()
    this._register(tracker.onDidFocusChange((e) => this._onFocusChange(e)))
  }

  push(entry: Omit<IFocusEntry, 'timestamp'>): void {
    const top = this._entries[0]
    if (
      top &&
      top.partId === entry.partId &&
      top.viewId === entry.viewId &&
      top.groupId === entry.groupId
    ) {
      return
    }
    this._entries.unshift({ ...entry, timestamp: Date.now() })
    if (this._entries.length > MAX_DEPTH) this._entries.length = MAX_DEPTH
    if (entry.viewId) {
      const containerId = ViewRegistry.getView(entry.viewId)?.containerId
      if (containerId) this._memory.setLastFocusedView(containerId, entry.viewId)
    }
    this._onDidChange.fire()
  }

  getTop(): IFocusEntry | undefined {
    return this._entries[0]
  }

  getAll(): readonly IFocusEntry[] {
    return this._entries
  }

  nextPart(): PartId | undefined {
    return this._navigatePart(1)
  }

  previousPart(): PartId | undefined {
    return this._navigatePart(-1)
  }

  clear(): void {
    if (this._entries.length === 0) return
    this._entries.length = 0
    this._onDidChange.fire()
  }

  private _navigatePart(step: 1 | -1): PartId | undefined {
    const visible = PART_ORDER.filter((id) => this._layoutService.getVisible(id))
    if (visible.length <= 1) return undefined
    const current = this._entries[0]?.partId
    const currentIdx = current ? visible.indexOf(current) : -1
    const startIdx = currentIdx === -1 ? 0 : currentIdx
    const len = visible.length
    return visible[(((startIdx + step) % len) + len) % len]
  }

  private _onFocusChange(e: IFocusChangeEvent): void {
    const el = e.current as unknown as HTMLElement | null
    if (!el) return
    const partTestId = this._closestAttr(el, 'data-testid')
    const partIdStr = partTestId?.startsWith('part-') ? partTestId.slice('part-'.length) : ''
    if (!isPartId(partIdStr)) return
    const viewId = this._closestAttr(el, 'data-view-id')
    const groupIdStr = this._closestAttr(el, 'data-group-id')
    const groupId = groupIdStr === undefined ? undefined : Number(groupIdStr)
    this.push({
      partId: partIdStr,
      viewId: viewId ?? undefined,
      groupId: Number.isFinite(groupId) ? groupId : undefined,
    })
  }

  private _closestAttr(el: HTMLElement, attr: string): string | undefined {
    let cur: HTMLElement | null = el
    while (cur) {
      const v = cur.getAttribute?.(attr)
      if (v) return v
      cur = cur.parentElement
    }
    return undefined
  }
}

function isPartId(s: string): s is PartId {
  return (PART_ORDER as readonly string[]).includes(s)
}
