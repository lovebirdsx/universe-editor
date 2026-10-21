/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GlobalDragAndDropContribution — window-level safety net for file/resource
 *  drags. Chromium's default action for a file dropped anywhere in the window is
 *  to navigate to it (Electron then "opens" the file as a page). Each drop
 *  target preventDefaults its own zone, but unhandled gaps (activity bar, empty
 *  editor area, between rows, …) would still navigate. Mirroring VSCode, we
 *  preventDefault every file/resource drag at the window so no drop can ever
 *  trigger that navigation; real targets still run first and do their work.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { dragContainsResources } from '@universe-editor/workbench-ui'
import { installPerWorkbenchDocument } from '../services/windows/workbenchDocumentEvents.js'

export class GlobalDragAndDropContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    // dragover must preventDefault too, otherwise the drop event never reaches
    // JS over unhandled regions and the browser navigates straight away.
    const onDragOver = (e: DragEvent): void => {
      if (dragContainsResources(e.dataTransfer)) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      if (dragContainsResources(e.dataTransfer)) e.preventDefault()
    }
    // Every workbench document needs the net: a file dropped over an auxiliary
    // window would otherwise navigate that window to the file.
    this._register(
      installPerWorkbenchDocument((doc) => {
        const view = doc.defaultView
        if (!view) return toDisposable(() => {})
        view.addEventListener('dragover', onDragOver)
        view.addEventListener('drop', onDrop)
        return toDisposable(() => {
          view.removeEventListener('dragover', onDragOver)
          view.removeEventListener('drop', onDrop)
        })
      }),
    )
  }
}
