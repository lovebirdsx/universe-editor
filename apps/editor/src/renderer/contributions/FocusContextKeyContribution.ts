/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FocusContextKeyContribution — derives focus-related context keys from
 *  IFocusTrackerService transitions.
 *
 *  Maintained keys:
 *    focusedPart                — partId currently containing focus, or ''
 *    focusedView                — viewId currently containing focus, or ''
 *    sideBarFocus               — focus is inside SideBar
 *    secondarySideBarFocus      — focus is inside SecondarySideBar
 *    panelFocus                 — focus is inside Panel
 *    activityBarFocus           — focus is inside ActivityBar
 *    editorAreaFocus            — focus is inside EditorArea
 *    statusBarFocus             — focus is inside StatusBar
 *
 *  Each Part exposes onDidFocus / onDidBlur (bridged from FocusTracker in
 *  main.tsx), so we use those for the per-part booleans rather than walking
 *  the DOM on every transition. `focusedPart` / `focusedView` come from the
 *  FocusTracker's settled current element via [data-view-id] / [data-testid].
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IContextKeyService,
  IFocusTrackerService,
  ILayoutService,
  IWorkbenchContribution,
  PartId,
} from '@universe-editor/platform'

const PART_KEY_BY_ID: Readonly<Record<PartId, string>> = {
  [PartId.ActivityBar]: 'activityBarFocus',
  [PartId.SideBar]: 'sideBarFocus',
  [PartId.SecondarySideBar]: 'secondarySideBarFocus',
  [PartId.EditorArea]: 'editorAreaFocus',
  [PartId.Panel]: 'panelFocus',
  [PartId.StatusBar]: 'statusBarFocus',
}

export class FocusContextKeyContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IFocusTrackerService focusTracker: IFocusTrackerService,
    @ILayoutService layoutService: ILayoutService,
  ) {
    super()

    const focusedPart = contextKeyService.createKey<string>('focusedPart', '')
    const focusedView = contextKeyService.createKey<string>('focusedView', '')

    const perPart = new Map<PartId, ReturnType<typeof contextKeyService.createKey<boolean>>>()
    for (const [id, key] of Object.entries(PART_KEY_BY_ID) as [PartId, string][]) {
      perPart.set(id, contextKeyService.createKey<boolean>(key, false))
    }

    // Drive per-part focus booleans from each Part's own onDidFocus / onDidBlur.
    // We bind both currently-registered parts and any future registrations.
    const bind = (partId: PartId) => {
      const part = layoutService.getPart(partId)
      if (!part) return
      const key = perPart.get(partId)
      if (!key) return
      // Active-part: subscribe to part events for boolean key.
      this._register(part.onDidFocus(() => key.set(true)))
      this._register(part.onDidBlur(() => key.set(false)))
      if (part.isFocused()) key.set(true)
    }
    for (const part of layoutService.getParts()) bind(part.id)
    this._register(layoutService.onDidRegisterPart((p) => bind(p.id)))

    // focusedPart + focusedView come from settled focus transitions. We walk
    // up from the current element looking for data-testid="part-*" and
    // data-view-id="*".
    const updateFromCurrent = () => {
      const cur = focusTracker.current as unknown as HTMLElement | null
      if (!cur) {
        focusedPart.set('')
        focusedView.set('')
        return
      }
      const partTestId = this._closestAttr(cur, 'data-testid')
      const partId = partTestId?.startsWith('part-') ? partTestId.slice('part-'.length) : ''
      focusedPart.set(partId)
      focusedView.set(this._closestAttr(cur, 'data-view-id') ?? '')
    }
    this._register(focusTracker.onDidFocusChange(updateFromCurrent))
    updateFromCurrent()
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
