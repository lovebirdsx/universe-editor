import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ICommandService, MenuId, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { useMenuItems, type ResolvedMenuSection } from './useTitleBarMenus.js'
import styles from './TitleBar.module.css'

interface DropdownContentsProps {
  sections: ResolvedMenuSection[]
  onExecute: (command: string) => void
}

function DropdownContents({ sections, onExecute }: DropdownContentsProps) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)

  if (sections.length === 0) {
    return (
      <div className={`${styles['dropdown-item']} ${styles['disabled']}`}>
        {localize('titleBar.empty', '(empty)')}
      </div>
    )
  }
  return (
    <>
      {sections.map((section, sectionIdx) => (
        <Fragment key={`section-${section.group}-${sectionIdx}`}>
          {sectionIdx > 0 && <div className={styles['separator']} />}
          {section.items.map((item, itemIdx) => {
            if (item.kind === 'submenu') {
              const key = `${section.group}-${itemIdx}-sub-${item.submenu}`
              const isOpen = openSubmenu === key
              return (
                <div
                  key={key}
                  className={`${styles['dropdown-item']} ${styles['submenu-anchor']}`}
                  onMouseEnter={() => setOpenSubmenu(key)}
                  onMouseLeave={() => setOpenSubmenu((cur) => (cur === key ? null : cur))}
                  role="menuitem"
                  aria-haspopup="true"
                  aria-expanded={isOpen}
                >
                  <span>{item.label}</span>
                  <span className={styles['submenu-arrow']}>▶</span>
                  {isOpen && <SubmenuPanel submenu={item.submenu} onExecute={onExecute} />}
                </div>
              )
            }
            return (
              <div
                key={`${section.group}-${itemIdx}-${item.command}`}
                className={styles['dropdown-item']}
                onClick={() => onExecute(item.command)}
                role="menuitem"
              >
                <span>{item.label}</span>
                {item.shortcut && <span className={styles['shortcut']}>{item.shortcut}</span>}
              </div>
            )
          })}
        </Fragment>
      ))}
    </>
  )
}

interface SubmenuPanelProps {
  submenu: MenuId
  onExecute: (command: string) => void
}

function SubmenuPanel({ submenu, onExecute }: SubmenuPanelProps) {
  const sections = useMenuItems(submenu)
  return (
    <div className={styles['submenu']} role="menu">
      <DropdownContents sections={sections} onExecute={onExecute} />
    </div>
  )
}

interface MenuGroupProps {
  label: string
  menuId: MenuId
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
}

function MenuGroup({ label, menuId, isOpen, onToggle, onClose }: MenuGroupProps) {
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
          onClose={handleClose}
        />
      ))}
    </nav>
  )
}
