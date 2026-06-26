import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ExternalLink,
  Plus,
  SplitSquareHorizontal,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { useService, useObservable } from '../../useService.js'
import styles from './TerminalViewToolbar.module.css'

function shellsForPlatform(): readonly string[] {
  if (navigator.platform.toLowerCase().startsWith('win')) {
    return ['cmd.exe', 'powershell.exe', 'pwsh.exe']
  }
  return ['bash', 'zsh', 'fish']
}

export function TerminalViewToolbar() {
  const manager = useService(ITerminalManagerService)
  const commandService = useService(ICommandService)
  const terminals = useObservable(manager.panelTerminals)
  const activeId = useObservable(manager.activeTerminalId)
  const [showShellMenu, setShowShellMenu] = useState(false)
  const [showInstanceMenu, setShowInstanceMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)
  const instanceRef = useRef<HTMLDivElement>(null)
  const instanceBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!showShellMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        chevronRef.current &&
        !chevronRef.current.contains(e.target as Node)
      ) {
        setShowShellMenu(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [showShellMenu])

  useEffect(() => {
    if (!showInstanceMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (
        instanceRef.current &&
        !instanceRef.current.contains(e.target as Node) &&
        instanceBtnRef.current &&
        !instanceBtnRef.current.contains(e.target as Node)
      ) {
        setShowInstanceMenu(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [showInstanceMenu])

  const handleNewDefault = () => void manager.newTerminal({ target: 'panel' })

  const handleNewShell = (shell: string) => {
    setShowShellMenu(false)
    void manager.newTerminal({ shell, target: 'panel' })
  }

  const handleClose = () => {
    if (activeId) manager.closeTerminal(activeId)
  }

  const handleSplit = () => void manager.splitTerminal({ target: 'panel' })

  const handleOpenInEditor = () =>
    void commandService.executeCommand('workbench.action.createTerminalEditor')

  const handleSelectInstance = (id: string) => {
    setShowInstanceMenu(false)
    manager.setActiveTerminal(id)
  }

  const shells = shellsForPlatform()
  const activeTerminal = terminals.find((t) => t.id === activeId)
  const activeLabel = activeTerminal?.name ?? localize('terminal.noTerminals', 'No terminals')

  return (
    <div className={styles['toolbar']}>
      <div className={styles['instancePicker']}>
        <button
          ref={instanceBtnRef}
          type="button"
          className={styles['instanceBtn']}
          onClick={() => setShowInstanceMenu((v) => !v)}
          disabled={terminals.length === 0}
          title={activeLabel}
          aria-label={localize('terminal.selectInstance', 'Select terminal instance')}
          aria-haspopup="listbox"
          aria-expanded={showInstanceMenu}
          data-testid="terminal-instance-select"
        >
          <TerminalSquare size={13} className={styles['instanceIcon']} aria-hidden="true" />
          <span className={styles['instanceLabel']}>{activeLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>

        {showInstanceMenu && terminals.length > 0 && (
          <div ref={instanceRef} className={styles['instanceMenu']} role="listbox">
            {terminals.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === activeId}
                className={`${styles['instanceItem']} ${
                  t.id === activeId ? styles['instanceItemActive'] : ''
                }`}
                title={t.name}
                onClick={() => handleSelectInstance(t.id)}
                data-testid={`terminal-instance-item-${t.id}`}
              >
                <TerminalSquare size={13} className={styles['instanceIcon']} aria-hidden="true" />
                <span className={styles['instanceLabel']}>{t.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('action.terminalInEditor.title', 'Open Terminal in Editor')}
        onClick={handleOpenInEditor}
      >
        <ExternalLink size={14} />
      </button>

      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('terminal.splitWithKey', 'Split Terminal (Ctrl+Shift+5)')}
        onClick={handleSplit}
        disabled={!activeId}
      >
        <SplitSquareHorizontal size={14} />
      </button>

      <button
        type="button"
        className={styles['iconBtn']}
        title={localize('terminal.close', 'Close Terminal')}
        onClick={handleClose}
        disabled={!activeId}
      >
        <Trash2 size={14} />
      </button>

      <div className={styles['splitBtn']}>
        <button
          type="button"
          className={styles['newBtn']}
          title={localize('action.newTerminal.title', 'New Terminal')}
          onClick={handleNewDefault}
        >
          <Plus size={14} />
        </button>
        <button
          ref={chevronRef}
          type="button"
          className={`${styles['chevronBtn']} ${showShellMenu ? styles['active'] : ''}`}
          title={localize('terminal.selectShell', 'Select Shell')}
          onClick={() => setShowShellMenu((v) => !v)}
        >
          <ChevronDown size={10} />
        </button>
      </div>

      {showShellMenu && (
        <div ref={menuRef} className={styles['shellMenu']}>
          {shells.map((shell) => (
            <button
              key={shell}
              type="button"
              className={styles['shellItem']}
              title={shell}
              onClick={() => handleNewShell(shell)}
            >
              {shell}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
