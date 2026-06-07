import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { URI } from '@universe-editor/platform'
import {
  IConfigurationService,
  IContextKeyService,
  markAsSingleton,
} from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { createFileLinkProvider } from './terminalLinkProvider.js'
import {
  copyTerminalSelection,
  handleTerminalClipboardKey,
  pasteClipboardIntoTerminal,
} from './terminalClipboard.js'
import { useService } from '../../useService.js'
import styles from './TerminalInstance.module.css'

interface XtermTheme {
  background: string
  foreground: string
  cursor: string
}

function themeFor(isDark: boolean): XtermTheme {
  return isDark
    ? { background: '#1a1a1c', foreground: '#cccccc', cursor: '#cccccc' }
    : { background: '#ffffff', foreground: '#333333', cursor: '#333333' }
}

export interface TerminalInstanceProps {
  id: string
  active: boolean
  isDark: boolean
  manager: ITerminalManagerService
  cwd: string
  resolveFile: (absolutePath: string) => Promise<URI | null>
  openFile: (uri: URI, line?: number, col?: number) => void
}

export function TerminalInstance({
  id,
  active,
  isDark,
  manager,
  cwd,
  resolveFile,
  openFile,
}: TerminalInstanceProps) {
  const contextKeyService = useService(IContextKeyService)
  const configService = useService(IConfigurationService)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resolveFileRef = useRef(resolveFile)
  resolveFileRef.current = resolveFile
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: configService.get<number>('terminal.integrated.scrollback') ?? 5000,
      theme: themeFor(isDark),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    term.attachCustomKeyEventHandler((event) => handleTerminalClipboardKey(event, term))

    const linkDisposable = term.registerLinkProvider(
      createFileLinkProvider(
        term,
        (absPath) => resolveFileRef.current(absPath),
        (uri, line, col) => openFileRef.current(uri, line, col),
        () => cwdRef.current,
      ),
    )

    const doFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
        manager.resize(id, term.cols, term.rows)
      } catch {
        // layout not ready — ignore
      }
    }

    // markAsSingleton: Restart Editor snapshots the leak tracker while React is
    // still mounted (before unmount flushes passive cleanup), so these live
    // subscriptions would otherwise read as leaks. Unmount still disposes them.
    const detach = markAsSingleton(manager.attach(id, (data) => term.write(data)))
    const inputSub = term.onData((data) => manager.input(id, data))
    const selectionSub = term.onSelectionChange(() => setHasSelection(term.hasSelection()))
    const observer = new ResizeObserver(() => doFit())
    observer.observe(el)
    doFit()

    const onFocusIn = () => contextKeyService.set('terminalFocus', true)
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) {
        contextKeyService.set('terminalFocus', false)
      }
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)

    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      contextKeyService.set('terminalFocus', false)
      observer.disconnect()
      selectionSub.dispose()
      inputSub.dispose()
      detach.dispose()
      linkDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, manager])

  // Live theme update without rebuilding the terminal (keeps scrollback).
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = themeFor(isDark)
  }, [isDark])

  // Live scrollback update when the setting changes.
  useEffect(() => {
    const d = markAsSingleton(
      configService.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('terminal.integrated.scrollback')) return
        const term = termRef.current
        if (term)
          term.options.scrollback =
            configService.get<number>('terminal.integrated.scrollback') ?? 5000
      }),
    )
    return () => d.dispose()
  }, [configService])

  // When this instance becomes active it may have been display:none (size 0);
  // refit against the now-laid-out container and focus.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    const el = containerRef.current
    if (!term || !fit || !el) return
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fit.fit()
        manager.resize(id, term.cols, term.rows)
      } catch {
        // ignore
      }
    }
    term.focus()
  }, [active, id, manager])

  // Respond to programmatic focus requests (e.g. FocusTerminalPanelAction).
  useEffect(() => {
    if (!active) return
    const d = markAsSingleton(manager.onFocusRequest(() => termRef.current?.focus()))
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
    const term = termRef.current
    if (term) await copyTerminalSelection(term)
    setContextMenu(null)
  }

  const handlePaste = async () => {
    const term = termRef.current
    if (term) await pasteClipboardIntoTerminal(term)
    setContextMenu(null)
  }

  return (
    <>
      <div
        ref={containerRef}
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
