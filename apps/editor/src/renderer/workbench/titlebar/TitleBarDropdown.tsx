/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared dropdown body for title-bar menus (MenuBar, layout control dropdown):
 *  renders useMenuItems-resolved sections with separators, icons, shortcuts and
 *  nested submenu popovers.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useState } from 'react'
import { MenuId, localize } from '@universe-editor/platform'
import { useMenuItems, type ResolvedMenuSection } from './useTitleBarMenus.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import styles from './TitleBar.module.css'

interface DropdownContentsProps {
  sections: ResolvedMenuSection[]
  onExecute: (command: string) => void
}

export function DropdownContents({ sections, onExecute }: DropdownContentsProps) {
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
            const showIconColumn = section.items.some((entry) => entry.icon !== undefined)
            const Icon = resolveHeaderIcon(item.icon)
            const iconCell = showIconColumn ? (
              <span className={styles['dropdown-icon-cell']} aria-hidden="true">
                {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
              </span>
            ) : null
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
                  {iconCell}
                  <span className={styles['dropdown-label-text']}>{item.label}</span>
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
                {iconCell}
                <span className={styles['dropdown-label-text']}>{item.label}</span>
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
