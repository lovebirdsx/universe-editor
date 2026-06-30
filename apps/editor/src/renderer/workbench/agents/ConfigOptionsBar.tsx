/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar — compact icon-button row of session-level switches
 *  (model / mode / thought level / custom). Sits inline with the Send button
 *  inside PromptInput's action row. Clicking a trigger opens a small popover
 *  for choosing a value.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Settings2, Sliders, Sparkles } from 'lucide-react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import type {
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import { findConfigOptionLabel } from '../../services/acp/configOptionLabel.js'
import styles from './agents.module.css'

export { findConfigOptionLabel as findLabel }

const CATEGORY_ORDER: SessionConfigOptionCategory[] = ['model', 'mode', 'thought_level']

export function compareByCategory(a: SessionConfigOption, b: SessionConfigOption): number {
  const ai = a.category ? CATEGORY_ORDER.indexOf(a.category as SessionConfigOptionCategory) : -1
  const bi = b.category ? CATEGORY_ORDER.indexOf(b.category as SessionConfigOptionCategory) : -1
  const aw = ai === -1 ? CATEGORY_ORDER.length + 1 : ai
  const bw = bi === -1 ? CATEGORY_ORDER.length + 1 : bi
  return aw - bw
}

export function ConfigOptionsBar({ session }: { session: IAcpSession }) {
  const options = useObservable(session.configOptions)
  const [openId, setOpenId] = useState<string | null>(null)
  if (options.length === 0) return null
  const ordered = [...options].sort(compareByCategory)
  return (
    <div className={styles['configBar']} data-testid="acp-config-options">
      {ordered.map((opt) => (
        <ConfigOptionTrigger
          key={opt.id}
          session={session}
          option={opt}
          open={openId === opt.id}
          onOpen={() => setOpenId(opt.id)}
          onClose={() => setOpenId(null)}
        />
      ))}
    </div>
  )
}

function categoryIcon(category: SessionConfigOption['category']) {
  switch (category) {
    case 'model':
      return Bot
    case 'mode':
      return Settings2
    case 'thought_level':
      return Sparkles
    default:
      return Sliders
  }
}

function ConfigOptionTrigger({
  session,
  option,
  open,
  onOpen,
  onClose,
}: {
  session: IAcpSession
  option: SessionConfigOption
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  if (option.type !== 'select') return null
  const Icon = categoryIcon(option.category)
  const currentLabel = findConfigOptionLabel(option.options, option.currentValue)
  const testKey = option.category ?? option.id
  const tooltipParts = [option.name]
  if (option.description) tooltipParts.push(option.description)
  return (
    <div className={styles['configTriggerWrap']} data-testid={`acp-config-${testKey}`}>
      <button
        type="button"
        className={styles['configTrigger']}
        data-category={option.category ?? 'custom'}
        data-testid={`acp-config-${testKey}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={tooltipParts.join(' — ')}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['configTriggerValue']}>{currentLabel}</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <ConfigOptionPopover
          option={option}
          onPick={(value) => {
            onClose()
            if (value !== option.currentValue) void session.setConfigOption(option.id, value)
          }}
          onDismiss={onClose}
          testKey={testKey}
        />
      ) : null}
    </div>
  )
}

function ConfigOptionPopover({
  option,
  onPick,
  onDismiss,
  testKey,
}: {
  option: SessionConfigOption & { type: 'select' }
  onPick: (value: string) => void
  onDismiss: () => void
  testKey: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])
  return (
    <div
      ref={containerRef}
      className={styles['configPopover']}
      role="listbox"
      aria-label={option.name}
      data-testid={`acp-config-${testKey}-popover`}
    >
      {renderPopoverItems(option.options, option.currentValue, onPick)}
    </div>
  )
}

function renderPopoverItems(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
  current: string,
  onPick: (value: string) => void,
) {
  if (options.length === 0) return null
  const first = options[0]!
  if ('group' in first) {
    const groups = options as readonly SessionConfigSelectGroup[]
    return groups.map((g) => (
      <div key={g.group} className={styles['configPopoverGroup']}>
        <div className={styles['configPopoverGroupLabel']}>{g.name}</div>
        {g.options.map((v) => (
          <PopoverItem key={v.value} option={v} current={current} onPick={onPick} />
        ))}
      </div>
    ))
  }
  const flat = options as readonly SessionConfigSelectOption[]
  return flat.map((v) => <PopoverItem key={v.value} option={v} current={current} onPick={onPick} />)
}

function PopoverItem({
  option,
  current,
  onPick,
}: {
  option: SessionConfigSelectOption
  current: string
  onPick: (value: string) => void
}) {
  const active = option.value === current
  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active}
      className={styles['configPopoverItem']}
      title={option.description ?? option.name}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(option.value)
      }}
    >
      <span className={styles['configPopoverItemName']}>{option.name}</span>
    </div>
  )
}
