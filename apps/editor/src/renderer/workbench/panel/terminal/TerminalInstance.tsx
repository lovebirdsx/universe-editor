import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
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
}

export function TerminalInstance({ id, active, isDark, manager }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: themeFor(isDark),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    const doFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
        manager.resize(id, term.cols, term.rows)
      } catch {
        // layout not ready — ignore
      }
    }

    const detach = manager.attach(id, (data) => term.write(data))
    const inputSub = term.onData((data) => manager.input(id, data))
    const observer = new ResizeObserver(() => doFit())
    observer.observe(el)
    doFit()

    return () => {
      observer.disconnect()
      inputSub.dispose()
      detach.dispose()
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
    const d = manager.onFocusRequest(() => termRef.current?.focus())
    return () => d.dispose()
  }, [active, manager])

  return (
    <div
      ref={containerRef}
      className={active ? `${styles['instance']} ${styles['visible']}` : styles['instance']}
      data-terminal-id={id}
    />
  )
}
