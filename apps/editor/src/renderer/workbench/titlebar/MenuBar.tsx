import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ICommandService, MenuId } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { useMenuItems } from './useTitleBarMenus.js'
import styles from './TitleBar.module.css'

const TOP_LEVEL: ReadonlyArray<{ label: string; menuId: MenuId }> = [
  { label: 'File', menuId: MenuId.MenubarFileMenu },
  { label: 'Edit', menuId: MenuId.MenubarEditMenu },
  { label: 'View', menuId: MenuId.MenubarViewMenu },
  { label: 'Help', menuId: MenuId.MenubarHelpMenu },
]

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

  const handleItemClick = useCallback(
    (command: string) => {
      onClose()
      void commandService.executeCommand(command)
    },
    [commandService, onClose],
  )

  const isEmpty = sections.length === 0

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
          {isEmpty ? (
            <div className={`${styles['dropdown-item']} ${styles['disabled']}`}>(empty)</div>
          ) : (
            sections.map((section, sectionIdx) => (
              <Fragment key={`section-${section.group}-${sectionIdx}`}>
                {sectionIdx > 0 && <div className={styles['separator']} />}
                {section.items.map((item, itemIdx) => (
                  <div
                    key={`${section.group}-${itemIdx}-${item.command}`}
                    className={styles['dropdown-item']}
                    onClick={() => handleItemClick(item.command)}
                    role="menuitem"
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className={styles['shortcut']}>{item.shortcut}</span>}
                  </div>
                ))}
              </Fragment>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function MenuBar() {
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
    <nav ref={containerRef} className={styles['menubar']} aria-label="Menu bar">
      {TOP_LEVEL.map((entry) => (
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
