/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphContextMenu — self-contained right-click menu for the Git Graph editor.
 *  Unlike the MenuRegistry-driven ContextMenu, items here are built dynamically
 *  from the object that was clicked (commit / branch / remote / tag), so the menu
 *  takes an explicit item list rather than a MenuId.
 *
 *  Fully keyboard-operable: the list grabs focus on open, ArrowUp/ArrowDown (and
 *  Home/End) move the highlight across separators, Enter executes, Escape closes.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import styles from './GitGraphEditor.module.css'

export type GitGraphMenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly danger?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }

export interface GitGraphMenuState {
  readonly x: number
  readonly y: number
  readonly items: GitGraphMenuItem[]
}

function firstItemIndex(items: readonly GitGraphMenuItem[]): number {
  return items.findIndex((item) => item.kind === 'item')
}

function lastItemIndex(items: readonly GitGraphMenuItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'item') return i
  }
  return -1
}

export function GitGraphContextMenu({
  state,
  onClose,
}: {
  state: GitGraphMenuState
  onClose: () => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [activeIndex, setActiveIndex] = useState(() => firstItemIndex(state.items))

  // A freshly opened menu takes keyboard focus and highlights its first item.
  useEffect(() => {
    setActiveIndex(firstItemIndex(state.items))
    listRef.current?.focus()
  }, [state])

  // Keep the highlighted item in view when the menu itself scrolls.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const move = (dir: 1 | -1) => {
    const items = state.items
    setActiveIndex((prev) => {
      let i = prev
      for (let n = 0; n < items.length; n++) {
        i = (i + dir + items.length) % items.length
        if (items[i]!.kind === 'item') return i
      }
      return prev
    })
  }

  const runItem = (index: number) => {
    const item = state.items[index]
    if (item?.kind !== 'item') return
    onClose()
    item.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        return
      case 'Home':
        e.preventDefault()
        setActiveIndex(firstItemIndex(state.items))
        return
      case 'End':
        e.preventDefault()
        setActiveIndex(lastItemIndex(state.items))
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        runItem(activeIndex)
        return
      case 'Escape':
        e.preventDefault()
        onClose()
        return
      default:
        return
    }
  }

  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']} tabIndex={-1} ref={listRef} onKeyDown={onKeyDown}>
        {state.items.map((item, i) =>
          item.kind === 'sep' ? (
            <li key={`sep-${i}`} role="separator" className={styles['menuSep']} />
          ) : (
            <li
              key={`${item.label}-${i}`}
              role="menuitem"
              className={`${styles['menuItem']} ${item.danger ? styles['menuItemDanger'] : ''} ${i === activeIndex ? styles['menuItemActive'] : ''}`}
              data-active={i === activeIndex ? '' : undefined}
              onClick={() => runItem(i)}
              // onMouseMove (not onMouseEnter): the menu can open directly under a
              // stationary cursor, which fires a synthetic mouseenter that would
              // hijack the keyboard highlight. A genuine cursor move fires
              // mousemove; a layout change beneath a still cursor does not.
              onMouseMove={() => setActiveIndex(i)}
            >
              {item.label}
            </li>
          ),
        )}
      </ul>
    </AnchoredSurface>
  )
}
