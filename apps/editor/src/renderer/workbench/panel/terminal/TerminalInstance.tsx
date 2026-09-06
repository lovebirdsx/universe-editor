import { useEffect, useMemo, useRef, useState } from 'react'
import type { URI } from '@universe-editor/platform'
import { localize, markAsSingleton } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import {
  ITerminalXtermService,
  type ITerminalXtermHolder,
} from '../../../services/terminal/TerminalXtermService.js'
import { useService } from '../../useService.js'
import { dragContainsResources, ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../../icons/menuIcon.js'
import {
  formatPathForTerminal,
  readDroppedResources,
} from '../../../services/dnd/resourceDropTransfer.js'
import styles from './TerminalInstance.module.css'

export interface TerminalInstanceProps {
  id: string
  /** Whether this instance is shown (its group/editor is the visible one). */
  active: boolean
  /** Whether this instance should grab focus. Defaults to `active`. */
  focused?: boolean
  cwd: string
  home: string | undefined
  resolveFile: (absolutePath: string) => Promise<URI | null>
  openFile: (uri: URI, line?: number, col?: number, endLine?: number) => void
}

export function TerminalInstance({
  id,
  active,
  focused,
  cwd,
  home,
  resolveFile,
  openFile,
}: TerminalInstanceProps) {
  const isFocused = focused ?? active
  const manager = useService(ITerminalManagerService)
  const xtermService = useService(ITerminalXtermService)

  const hostRef = useRef<HTMLDivElement>(null)
  const holderRef = useRef<ITerminalXtermHolder | null>(null)
  const resolveFileRef = useRef(resolveFile)
  resolveFileRef.current = resolveFile
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const homeRef = useRef(home)
  homeRef.current = home

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  // Reparent the persistent xterm wrapper into this host; never dispose the
  // holder here — it outlives the view and is released on process exit.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const holder = xtermService.acquire(id)
    holderRef.current = holder
    holder.setLinkHandlers({
      resolveFile: (p) => resolveFileRef.current(p),
      openFile: (uri, line, col, endLine) => openFileRef.current(uri, line, col, endLine),
      getCwd: () => cwdRef.current,
      getHome: () => homeRef.current,
    })
    holder.reattachTo(host)
    setHasSelection(holder.hasSelection())

    const selectionSub = markAsSingleton(
      holder.onDidChangeSelection(() => setHasSelection(holder.hasSelection())),
    )
    const observer = new ResizeObserver(() => holder.scheduleFit())
    observer.observe(host)

    return () => {
      observer.disconnect()
      selectionSub.dispose()
      holder.saveScroll()
      holder.wrapper.remove()
      holderRef.current = null
    }
  }, [id, xtermService])

  // Becoming active may follow a display:none (size 0) phase; refit, then focus
  // only the instance that should own focus (the active one within its group).
  useEffect(() => {
    if (!active) return
    const holder = holderRef.current
    if (!holder) return
    holder.fit()
    if (isFocused) holder.focus()
  }, [active, isFocused])

  // Respond to programmatic focus requests (e.g. FocusTerminalPanelAction).
  useEffect(() => {
    if (!isFocused) return
    const d = markAsSingleton(manager.onFocusRequest(() => holderRef.current?.focus()))
    return () => d.dispose()
  }, [isFocused, manager])

  // Respond to targeted focus requests by terminal id (e.g. FocusActiveEditorGroupAction
  // when a terminal editor is active — the handler must reach the exact xterm instance).
  useEffect(() => {
    const d = markAsSingleton(
      manager.onFocusRequestById((targetId) => {
        if (targetId === id) holderRef.current?.focus()
      }),
    )
    return () => d.dispose()
  }, [id, manager])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems = useMemo<readonly ListMenuEntry[]>(
    () => [
      {
        kind: 'item',
        icon: 'copy',
        label: localize('common.copy', 'Copy'),
        disabled: !hasSelection,
        run: () => void holderRef.current?.copy(),
      },
      {
        kind: 'item',
        icon: 'paste',
        label: localize('common.paste', 'Paste'),
        run: () => void holderRef.current?.paste(),
      },
    ],
    [hasSelection],
  )

  const handleDragOver = (e: React.DragEvent) => {
    if (!dragContainsResources(e.dataTransfer)) return
    e.preventDefault()
    // Stop the editor group body from also reacting (it would show an "open"
    // overlay) when a terminal is hosted inside an editor group.
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!hostRef.current?.contains(e.relatedTarget as Node | null)) setDropActive(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    setDropActive(false)
    const resources = readDroppedResources(e)
    if (resources.length === 0) return
    e.preventDefault()
    // Prevent the drop from bubbling to the editor group body, which would
    // otherwise open the dropped files as editors in addition to inserting them.
    e.stopPropagation()
    // 本机路径，不随远端工作区变化：拖入终端的文件均来自 OS 本机拖放。
    const text = resources.map((r) => formatPathForTerminal(r.fsPath)).join(' ')
    manager.input(id, `${text} `)
    holderRef.current?.focus()
  }

  return (
    <>
      <div
        ref={hostRef}
        className={[
          styles['instance'],
          active && styles['visible'],
          dropActive && styles['dropActive'],
        ]
          .filter(Boolean)
          .join(' ')}
        data-terminal-id={id}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />
      {contextMenu && (
        <ListMenu
          items={menuItems}
          anchor={{ x: contextMenu.x, y: contextMenu.y }}
          renderIcon={renderMenuIcon}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
