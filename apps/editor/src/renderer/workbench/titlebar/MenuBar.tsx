import { useCallback, useEffect, useRef, useState } from 'react'
import { ICommandService, MenuId, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { useMenuItems } from './useTitleBarMenus.js'
import { DropdownContents } from './TitleBarDropdown.js'
import styles from './TitleBar.module.css'

interface MenuGroupProps {
  label: string
  menuId: MenuId
  isOpen: boolean
  onToggle: () => void
  onHover: () => void
  onClose: () => void
}

function MenuGroup({ label, menuId, isOpen, onToggle, onHover, onClose }: MenuGroupProps) {
  const sections = useMenuItems(menuId)
  const commandService = useService(ICommandService)

  const handleExecute = useCallback(
    (command: string) => {
      onClose()
      void commandService.executeCommand(command)
    },
    [commandService, onClose],
  )

  return (
    <div className={styles['menu-group']}>
      <div
        className={`${styles['menu-label']} ${isOpen ? styles['open'] : ''}`}
        onClick={onToggle}
        onMouseEnter={onHover}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        {label}
      </div>
      {isOpen && (
        <div className={styles['dropdown']} role="menu">
          <DropdownContents sections={sections} onExecute={handleExecute} />
        </div>
      )}
    </div>
  )
}

export function MenuBar() {
  const topLevel: ReadonlyArray<{ label: string; menuId: MenuId }> = [
    { label: localize('menu.file', 'File'), menuId: MenuId.MenubarFileMenu },
    { label: localize('menu.edit', 'Edit'), menuId: MenuId.MenubarEditMenu },
    { label: localize('menu.view', 'View'), menuId: MenuId.MenubarViewMenu },
    { label: localize('menu.help', 'Help'), menuId: MenuId.MenubarHelpMenu },
  ]
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const containerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!openMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [openMenu])

  useEffect(() => {
    if (!openMenu) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openMenu])

  const handleToggle = useCallback((label: string) => {
    setOpenMenu((prev) => (prev === label ? null : label))
  }, [])
  const handleClose = useCallback(() => setOpenMenu(null), [])
  // Once any menu is open, hovering a sibling top-level menu switches to it
  // (standard menubar behavior). Hovering with nothing open does not expand.
  const handleHover = useCallback((label: string) => {
    setOpenMenu((prev) => (prev !== null && prev !== label ? label : prev))
  }, [])

  return (
    <nav
      ref={containerRef}
      className={styles['menubar']}
      aria-label={localize('menuBar.ariaLabel', 'Menu bar')}
    >
      {topLevel.map((entry) => (
        <MenuGroup
          key={entry.label}
          label={entry.label}
          menuId={entry.menuId}
          isOpen={openMenu === entry.label}
          onToggle={() => handleToggle(entry.label)}
          onHover={() => handleHover(entry.label)}
          onClose={handleClose}
        />
      ))}
    </nav>
  )
}
