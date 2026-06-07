import { useEffect, useRef, useState } from 'react'
import type { URI } from '@universe-editor/platform'
import { IContextKeyService, markAsSingleton } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import {
  ITerminalXtermService,
  type ITerminalXtermHolder,
} from '../../../services/terminal/TerminalXtermService.js'
import { useService } from '../../useService.js'
import styles from './TerminalInstance.module.css'

export interface TerminalInstanceProps {
  id: string
  active: boolean
  cwd: string
  resolveFile: (absolutePath: string) => Promise<URI | null>
  openFile: (uri: URI, line?: number, col?: number) => void
}

export function TerminalInstance({
  id,
  active,
  cwd,
  resolveFile,
  openFile,
}: TerminalInstanceProps) {
  const contextKeyService = useService(IContextKeyService)
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

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)

  // Reparent the persistent xterm wrapper into this host; never dispose the
  // holder here — it outlives the view and is released on process exit.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const holder = xtermService.acquire(id)
    holderRef.current = holder
    holder.setLinkHandlers({
      resolveFile: (p) => resolveFileRef.current(p),
      openFile: (uri, line, col) => openFileRef.current(uri, line, col),
      getCwd: () => cwdRef.current,
    })
    holder.reattachTo(host)
    setHasSelection(holder.hasSelection())

    const selectionSub = markAsSingleton(
      holder.onDidChangeSelection(() => setHasSelection(holder.hasSelection())),
    )
    const observer = new ResizeObserver(() => holder.scheduleFit())
    observer.observe(host)

    const onFocusIn = () => contextKeyService.set('terminalFocus', true)
    const onFocusOut = (e: FocusEvent) => {
      if (!host.contains(e.relatedTarget as Node | null)) {
        contextKeyService.set('terminalFocus', false)
      }
    }
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onFocusOut)

    return () => {
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onFocusOut)
      contextKeyService.set('terminalFocus', false)
      observer.disconnect()
      selectionSub.dispose()
      holder.saveScroll()
      holder.wrapper.remove()
      holderRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, xtermService])

  // Becoming active may follow a display:none (size 0) phase; refit and focus.
  useEffect(() => {
    if (!active) return
    const holder = holderRef.current
    if (!holder) return
    holder.fit()
    holder.focus()
  }, [active])

  // Respond to programmatic focus requests (e.g. FocusTerminalPanelAction).
  useEffect(() => {
    if (!active) return
    const d = markAsSingleton(manager.onFocusRequest(() => holderRef.current?.focus()))
    return () => d.dispose()
  }, [active, manager])

  // Dismiss context menu on Escape.
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleCopy = async () => {
    await holderRef.current?.copy()
    setContextMenu(null)
  }

  const handlePaste = async () => {
    await holderRef.current?.paste()
    setContextMenu(null)
  }

  return (
    <>
      <div
        ref={hostRef}
        className={active ? `${styles['instance']} ${styles['visible']}` : styles['instance']}
        data-terminal-id={id}
        onContextMenu={handleContextMenu}
      />
      {contextMenu && (
        <>
          <div className={styles['ctx-overlay']} onClick={() => setContextMenu(null)} />
          <div className={styles['ctx-menu']} style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button
              className={hasSelection ? styles['ctx-item'] : styles['ctx-item-disabled']}
              disabled={!hasSelection}
              onClick={handleCopy}
            >
              Copy
            </button>
            <button className={styles['ctx-item']} onClick={handlePaste}>
              Paste
            </button>
          </div>
        </>
      )}
    </>
  )
}
