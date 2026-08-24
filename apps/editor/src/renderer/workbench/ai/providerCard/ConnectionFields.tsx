/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConnectionFields — baseUrl / apiKey, the two values that decide what
 *  endpoint this entry talks to. Each one commits on blur or Enter and reverts on
 *  Escape; a hot reload of aiSettings.json cannot clobber a focused input.
 *
 *  Either may come from an ancestor via `extends`, and an empty box
 *  that silently inherits is the most confusing state this page can be in — so a
 *  field that is not set locally shows the inherited value and where it came from,
 *  and a field that is set shows that it overrides one, with a way back.
 *  Inherited API keys are never revealed: an ancestor's secret is not this card's.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState } from 'react'
import { Eye, EyeOff, KeyRound, Pencil, RotateCcw, X } from 'lucide-react'
import { localize, type AiProviderEntry } from '@universe-editor/platform'
import { Button, IconButton, Input } from '@universe-editor/workbench-ui'
import { maskKey } from '../../../../shared/ai/maskKey.js'
import { findInherited } from '../../../../shared/ai/providerInheritance.js'
import { SavedIndicator } from './SavedIndicator.js'
import { useEditableText, type SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

interface ConnectionFieldsProps {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly saved: SavedStamp | undefined
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onSetApiKey: (key: string) => void
  readonly onClearApiKey: () => void
}

export function ConnectionFields({
  provider,
  allProviders,
  saved,
  onBaseUrlChange,
  onSetApiKey,
  onClearApiKey,
}: ConnectionFieldsProps) {
  const baseUrl = useEditableText(provider.baseUrl, onBaseUrlChange)

  const inheritedBaseUrl = findInherited(provider, allProviders, 'baseUrl')
  const inheritedKey = findInherited(provider, allProviders, 'apiKey')

  return (
    <>
      <TextField
        name="baseUrl"
        title={localize('aiModels.baseUrl', 'Base URL')}
        placeholder={
          inheritedBaseUrl?.value ?? localize('aiModels.baseUrl.placeholder', 'Provider default')
        }
        edit={baseUrl}
        saved={saved}
        own={provider.baseUrl !== undefined}
        inheritedFrom={inheritedBaseUrl?.from}
        onRevert={() => onBaseUrlChange('')}
      />
      <ApiKeyField
        apiKey={provider.apiKey}
        inheritedFrom={inheritedKey?.from}
        onSetApiKey={onSetApiKey}
        onClearApiKey={onClearApiKey}
      />
    </>
  )
}

function TextField({
  name,
  title,
  placeholder,
  edit,
  saved,
  own,
  inheritedFrom,
  onRevert,
}: {
  readonly name: string
  readonly title: string
  readonly placeholder: string
  readonly edit: ReturnType<typeof useEditableText>
  readonly saved: SavedStamp | undefined
  readonly own: boolean
  readonly inheritedFrom: string | undefined
  readonly onRevert: () => void
}) {
  return (
    <div className={styles['field']}>
      <div className={styles['fieldHeader']}>
        <label className={styles['label']}>{title}</label>
        <SavedIndicator saved={saved} field={name} />
      </div>
      <Input
        value={edit.value}
        placeholder={placeholder}
        aria-label={title}
        onChange={(e) => edit.onChange(e.target.value)}
        onFocus={edit.onFocus}
        onBlur={edit.onBlur}
        onKeyDown={edit.onKeyDown}
      />
      <InheritanceNote own={own} inheritedFrom={inheritedFrom} onRevert={onRevert} />
    </div>
  )
}

export function InheritanceNote({
  own,
  inheritedFrom,
  onRevert,
}: {
  readonly own: boolean
  readonly inheritedFrom: string | undefined
  readonly onRevert: () => void
}) {
  if (inheritedFrom === undefined) return null
  if (!own) {
    return (
      <span className={styles['inheritNote']}>
        {localize('aiModels.inherit.from', 'Inherited from {id}', { id: inheritedFrom })}
      </span>
    )
  }
  return (
    <span className={styles['inheritNote']}>
      {localize('aiModels.inherit.overrides', 'Overrides {id}', { id: inheritedFrom })}
      <IconButton
        label={localize('aiModels.inherit.revert', 'Clear override and inherit again')}
        onClick={onRevert}
      >
        <RotateCcw size={13} strokeWidth={1.75} />
      </IconButton>
    </span>
  )
}

function ApiKeyField({
  apiKey,
  inheritedFrom,
  onSetApiKey,
  onClearApiKey,
}: {
  readonly apiKey: string | undefined
  readonly inheritedFrom: string | undefined
  readonly onSetApiKey: (key: string) => void
  readonly onClearApiKey: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const has = apiKey !== undefined && apiKey !== ''
  const editing = draft !== undefined

  const commit = useCallback(() => {
    const trimmed = draft?.trim() ?? ''
    setDraft(undefined)
    if (trimmed !== '' && trimmed !== apiKey) onSetApiKey(trimmed)
  }, [apiKey, draft, onSetApiKey])

  return (
    <div className={styles['field']}>
      <label className={styles['label']}>{localize('aiModels.apiKey', 'API Key')}</label>
      {editing ? (
        <div className={styles['apiKeyRow']}>
          <Input
            autoFocus
            type={revealed ? 'text' : 'password'}
            value={draft}
            placeholder={
              inheritedFrom !== undefined
                ? localize(
                    'aiModels.apiKey.overridePlaceholder',
                    'Inherited from {id} — enter a key to override',
                    { id: inheritedFrom },
                  )
                : 'sk-…'
            }
            aria-label={localize('aiModels.apiKey', 'API Key')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') setDraft(undefined)
            }}
          />
          <IconButton
            label={
              revealed
                ? localize('aiModels.apiKey.hide', 'Hide API key')
                : localize('aiModels.apiKey.show', 'Show API key')
            }
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <EyeOff size={15} strokeWidth={1.75} />
            ) : (
              <Eye size={15} strokeWidth={1.75} />
            )}
          </IconButton>
          <Button size="sm" onClick={commit}>
            {localize('aiModels.apiKey.save', 'Save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
            {localize('aiModels.apiKey.cancel', 'Cancel')}
          </Button>
        </div>
      ) : (
        <div className={styles['apiKeyRow']}>
          <span className={styles['apiKeyStatus']}>
            {has ? (
              revealed ? (
                apiKey
              ) : (
                maskKey(apiKey)
              )
            ) : inheritedFrom !== undefined ? (
              <span className={styles['inheritNote']}>
                <KeyRound size={12} strokeWidth={2} />
                {localize('aiModels.apiKey.inherited', 'Inherited from {id}', {
                  id: inheritedFrom,
                })}
              </span>
            ) : (
              localize('aiModels.apiKey.unset', 'Not set')
            )}
          </span>
          <IconButton
            label={
              revealed
                ? localize('aiModels.apiKey.hide', 'Hide API key')
                : localize('aiModels.apiKey.show', 'Show API key')
            }
            disabled={!has}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <EyeOff size={15} strokeWidth={1.75} />
            ) : (
              <Eye size={15} strokeWidth={1.75} />
            )}
          </IconButton>
          <IconButton
            label={localize('aiModels.apiKey.edit', 'Edit API key')}
            onClick={() => setDraft(apiKey ?? '')}
          >
            <Pencil size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={localize('aiModels.apiKey.clearBtn', 'Clear API key')}
            disabled={!has}
            onClick={onClearApiKey}
          >
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      )}
    </div>
  )
}
