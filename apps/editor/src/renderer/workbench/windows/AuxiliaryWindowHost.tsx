/*---------------------------------------------------------------------------------------------
 *  AuxiliaryWindowHost — portals one editor-only workbench tree into every
 *  auxiliary window. React context/DI is inherited from the main tree, so the
 *  auxiliary window shares services, editor inputs and Monaco models while its
 *  DOM (and therefore every overlay) is owned by its own document.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { TooltipProvider, useDragSessionDocument } from '@universe-editor/workbench-ui'
import { IWorkbenchWindowService } from '../../services/windows/workbenchWindowService.js'
import {
  IAuxiliaryEditorWindowService,
  type IAuxiliaryEditorWindow,
} from '../../services/windows/auxiliaryEditorWindowService.js'
import { useService } from '../useService.js'
import { useGlobalKeybindingHandler } from '../useGlobalKeybindingHandler.js'
import { resolveShortcut } from '../titlebar/keybindingFormat.js'
import { EditorArea } from '../editor/EditorArea.js'

function AuxiliaryWindowContent({ entry }: { entry: IAuxiliaryEditorWindow }) {
  useGlobalKeybindingHandler(entry.window.document)
  // The drag session context is shared through the portal, but each auxiliary
  // document needs its own terminal-event listeners: a drag dropped or
  // cancelled there never reaches the main window's document.
  useDragSessionDocument(entry.window.document)
  return (
    <TooltipProvider targetDocument={entry.window.document} resolveShortcut={resolveShortcut}>
      <EditorArea editorPart={entry.part} />
    </TooltipProvider>
  )
}

export function AuxiliaryWindowHost() {
  const windowsService = useService(IWorkbenchWindowService)
  const auxiliaryService = useService(IAuxiliaryEditorWindowService)
  const [, bumpVersion] = useState(0)

  useEffect(() => {
    const added = windowsService.onDidAddWindow(() => bumpVersion((v) => v + 1))
    const removed = windowsService.onDidRemoveWindow(() => bumpVersion((v) => v + 1))
    return () => {
      added.dispose()
      removed.dispose()
    }
  }, [windowsService])

  return (
    <>
      {auxiliaryService.windows.map((entry) => {
        const root = entry.window.document.getElementById('root') ?? entry.window.document.body
        return createPortal(
          <AuxiliaryWindowContent key={entry.token} entry={entry} />,
          root,
          entry.token,
        )
      })}
    </>
  )
}
