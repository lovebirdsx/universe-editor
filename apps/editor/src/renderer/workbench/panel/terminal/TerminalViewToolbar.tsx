import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { ICommandService } from '@universe-editor/platform'
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
  const menuRef = useRef<HTMLDivElement>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)

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

  const handleNewDefault = () => void manager.newTerminal({ target: 'panel' })

  const handleNewShell = (shell: string) => {
    setShowShellMenu(false)
    void manager.newTerminal({ shell, target: 'panel' })
  }

  const handleClose = () => {
    if (activeId) manager.closeTerminal(activeId)
  }

  const handleOpenInEditor = () =>
    void commandService.executeCommand('workbench.action.createTerminalEditor')

  const shells = shellsForPlatform()

  return (
    <div className={styles['toolbar']}>
      <select
        className={styles['instanceSelect']}
        value={activeId ?? ''}
        onChange={(e) => manager.setActiveTerminal(e.target.value)}
        aria-label="Select terminal instance"
        data-testid="terminal-instance-select"
        disabled={terminals.length === 0}
      >
        {terminals.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {terminals.length === 0 && <option value="">No terminals</option>}
      </select>

      <button
        type="button"
        className={styles['iconBtn']}
        title="Open Terminal in Editor"
        onClick={handleOpenInEditor}
      >
        <ExternalLink size={14} />
      </button>

      <button
        type="button"
        className={styles['iconBtn']}
        title="Close Terminal"
        onClick={handleClose}
        disabled={!activeId}
      >
        <Trash2 size={14} />
      </button>

      <div className={styles['splitBtn']}>
        <button
          type="button"
          className={styles['newBtn']}
          title="New Terminal"
          onClick={handleNewDefault}
        >
          <Plus size={14} />
        </button>
        <button
          ref={chevronRef}
          type="button"
          className={`${styles['chevronBtn']} ${showShellMenu ? styles['active'] : ''}`}
          title="Select Shell"
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
