/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar — renders session-level switches (model / mode / thought
 *  level / custom) as a row of compact <select> dropdowns at the top of the
 *  ChatView. Legacy `modes` are surfaced through the same path: the service
 *  synthesizes a category="mode" ConfigOption from the legacy state so the UI
 *  doesn't branch on which protocol shape the agent uses.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import type {
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import styles from './agents.module.css'

/** Display order — earlier categories render leftmost. */
const CATEGORY_ORDER: SessionConfigOptionCategory[] = ['model', 'mode', 'thought_level']

function compareByCategory(a: SessionConfigOption, b: SessionConfigOption): number {
  const ai = a.category ? CATEGORY_ORDER.indexOf(a.category as SessionConfigOptionCategory) : -1
  const bi = b.category ? CATEGORY_ORDER.indexOf(b.category as SessionConfigOptionCategory) : -1
  // Items missing from the reserved list keep their server-supplied order
  // (sorted to the end). Stable: equal keys → preserve original index.
  const aw = ai === -1 ? CATEGORY_ORDER.length + 1 : ai
  const bw = bi === -1 ? CATEGORY_ORDER.length + 1 : bi
  return aw - bw
}

export function ConfigOptionsBar({ session }: { session: IAcpSession }) {
  const options = useObservable(session.configOptions)
  if (options.length === 0) return null
  const ordered = [...options].sort(compareByCategory)
  return (
    <div className={styles['configOptionsBar']} data-testid="acp-config-options">
      {ordered.map((opt) => (
        <ConfigOptionSelect key={opt.id} session={session} option={opt} />
      ))}
    </div>
  )
}

function ConfigOptionSelect({
  session,
  option,
}: {
  session: IAcpSession
  option: SessionConfigOption
}) {
  if (option.type !== 'select') return null
  const onChange = (value: string): void => {
    if (value === option.currentValue) return
    void session.setConfigOption(option.id, value)
  }
  const titleParts = [option.name]
  if (option.description) titleParts.push(option.description)
  return (
    <label
      className={styles['configOption']}
      data-category={option.category ?? 'custom'}
      data-testid={`acp-config-${option.category ?? option.id}`}
    >
      <span className={styles['configOptionLabel']}>{option.name}</span>
      <select
        className={styles['configOptionSelect']}
        value={option.currentValue}
        title={titleParts.join(' — ')}
        onChange={(e) => onChange(e.target.value)}
      >
        {renderSelectOptions(option.options)}
      </select>
    </label>
  )
}

function renderSelectOptions(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
) {
  if (options.length === 0) return null
  // Discriminator: group entries carry `group` / `name` whereas leaf entries
  // carry `value`. Both shapes are valid per spec; mixing groups + leaves
  // inside a single options array is not, so a single peek is enough.
  const first = options[0]!
  if ('group' in first) {
    const groups = options as readonly SessionConfigSelectGroup[]
    return groups.map((g) => (
      <optgroup key={g.group} label={g.name}>
        {g.options.map((v) => (
          <option key={v.value} value={v.value} title={v.description ?? v.name}>
            {v.name}
          </option>
        ))}
      </optgroup>
    ))
  }
  const flat = options as readonly SessionConfigSelectOption[]
  return flat.map((v) => (
    <option key={v.value} value={v.value} title={v.description ?? v.name}>
      {v.name}
    </option>
  ))
}
