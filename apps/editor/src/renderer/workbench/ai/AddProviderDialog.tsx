/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AddProviderDialog — a focus-trapped modal for adding a provider *instance*.
 *  Three steps in one dialog: pick a provider type (existing descriptor or
 *  create a new type inline), fill the connection (name / label / baseUrl /
 *  apiKey), and verify. Picking an existing type reuses that type's model
 *  catalog and rates, so the dialog never asks for models/rates again. The
 *  non-secret part of the draft (type / name / baseUrl) is persisted; the API
 *  key is NEVER persisted to storage — it only travels to main for the probe
 *  and, on create, into the instance's plaintext apiKey (written via
 *  updateProviders, not setApiKey).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import {
  IAiModelService,
  IStorageService,
  StorageScope,
  localize,
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { Button, Checkbox, FocusScopeOverlay, Input, Spinner } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import styles from './AiSettingsEditor.module.css'

const DRAFT_KEY = 'ai.settings.addProvider.draft'
const VERIFY_DEBOUNCE_MS = 600
const NEW_TYPE = '__new__'

const PROTOCOLS: readonly AiWireProtocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'ollama',
]

interface Draft {
  readonly type: string
  readonly name: string
  readonly baseUrl: string
}

type VerifyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface AddProviderDialogProps {
  readonly existingInstances: readonly AiProviderInstance[]
  readonly existingTypes: Readonly<Record<string, AiProviderType>>
  readonly onClose: () => void
  readonly onCreated: () => void
}

export function AddProviderDialog({
  existingInstances,
  existingTypes,
  onClose,
  onCreated,
}: AddProviderDialogProps) {
  const aiModel = useService(IAiModelService)
  const storage = useService(IStorageService)

  const [descriptors, setDescriptors] = useState<readonly AiProviderTypeDescriptor[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState('')
  const [name, setName] = useState('default')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const [creating, setCreating] = useState(false)

  // New-type form fields (shown only when "＋ New type…" is selected).
  const [newTypeId, setNewTypeId] = useState('')
  const [newTypeLabel, setNewTypeLabel] = useState('')
  const [newTypeProtocol, setNewTypeProtocol] = useState<AiWireProtocol>('openai-chat')
  const [newTypeBaseUrl, setNewTypeBaseUrl] = useState('')
  const [newTypeRequiresApiKey, setNewTypeRequiresApiKey] = useState(false)

  const draftRestored = useRef(false)
  const verifyToken = useRef(0)

  const creatingNewType = selectedTypeId === NEW_TYPE

  // Load descriptors, then overlay the persisted (key-free) draft.
  useEffect(() => {
    let active = true
    void (async () => {
      const [list, draft] = await Promise.all([
        aiModel.getProviderTypeDescriptors(),
        storage.get<Draft>(DRAFT_KEY, StorageScope.GLOBAL),
      ])
      if (!active) return
      setDescriptors(list)
      const restoredType =
        draft && (list.some((d) => d.id === draft.type) || draft.type === NEW_TYPE)
          ? draft.type
          : ''
      setSelectedTypeId(restoredType || list[0]?.id || '')
      if (draft) {
        setName(draft.name)
        setBaseUrl(draft.baseUrl)
      }
      draftRestored.current = true
    })()
    return () => {
      active = false
    }
  }, [aiModel, storage])

  // Persist the key-free draft as the user edits (after the initial restore).
  useEffect(() => {
    if (!draftRestored.current) return
    void storage.set(
      DRAFT_KEY,
      { type: selectedTypeId, name, baseUrl } satisfies Draft,
      StorageScope.GLOBAL,
    )
  }, [storage, selectedTypeId, name, baseUrl])

  const selectedType = useMemo(
    () => (creatingNewType ? undefined : existingTypes[selectedTypeId]),
    [creatingNewType, existingTypes, selectedTypeId],
  )

  const effectiveTypeId = creatingNewType ? newTypeId.trim() : selectedTypeId
  const effectiveProtocol: AiWireProtocol = creatingNewType
    ? newTypeProtocol
    : (selectedType?.protocol ?? 'openai-chat')
  const effectiveDefaultBaseUrl = creatingNewType
    ? newTypeBaseUrl.trim() || undefined
    : selectedType?.defaultBaseUrl

  const trimmedName = name.trim()
  const nameError = useMemo(() => {
    if (trimmedName.length === 0)
      return localize('aiModels.addProvider.nameEmpty', 'Name is required.')
    if (trimmedName.includes('/'))
      return localize('aiModels.addProvider.nameSlash', "Name must not contain '/'.")
    if (
      !creatingNewType &&
      existingInstances.some((i) => i.type === effectiveTypeId && i.name === trimmedName)
    )
      return localize(
        'aiModels.addProvider.nameExists',
        'That provider already exists for this type.',
      )
    return undefined
  }, [trimmedName, existingInstances, effectiveTypeId, creatingNewType])

  const newTypeIdTrimmed = newTypeId.trim()
  const newTypeError = useMemo(() => {
    if (!creatingNewType) return undefined
    if (newTypeIdTrimmed.length === 0)
      return localize('aiModels.addProvider.newType.idEmpty', 'Type id must not be empty.')
    if (newTypeIdTrimmed.includes('/'))
      return localize('aiModels.addProvider.newType.idSlash', "Type id must not contain '/'.")
    if (newTypeIdTrimmed in existingTypes)
      return localize('aiModels.addProvider.newType.idExists', 'That type id already exists.')
    return undefined
  }, [creatingNewType, newTypeIdTrimmed, existingTypes])

  const runVerify = useCallback(async () => {
    if (!effectiveTypeId) return
    const token = ++verifyToken.current
    setVerify({ kind: 'verifying' })
    const result = await aiModel.verifyProvider({
      type: effectiveTypeId,
      name: trimmedName || 'default',
      protocol: effectiveProtocol,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    })
    if (token !== verifyToken.current) return
    setVerify(
      result.ok
        ? { kind: 'ok', modelCount: result.modelCount }
        : {
            kind: 'fail',
            error:
              result.error ?? localize('aiModels.addProvider.verifyFail', 'Verification failed.'),
          },
    )
  }, [aiModel, effectiveTypeId, trimmedName, effectiveProtocol, baseUrl, apiKey])

  // Auto-probe when the connection-relevant fields settle — but only once the
  // baseUrl is a complete URL. Empty or half-typed values would otherwise spam
  // pointless probes / failures; the manual "Verify" button still works for
  // types that rely on their default endpoint.
  useEffect(() => {
    if (!draftRestored.current || !effectiveTypeId) return
    if (!isCompleteUrl(baseUrl.trim())) return
    const timer = setTimeout(() => void runVerify(), VERIFY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [effectiveTypeId, baseUrl, apiKey, runVerify])

  // Switching type / entering new-type mode resets the probe.
  useEffect(() => {
    setVerify({ kind: 'idle' })
  }, [selectedTypeId, newTypeId, newTypeProtocol])

  const create = useCallback(async () => {
    if (nameError || newTypeError || !effectiveTypeId) return
    setCreating(true)
    try {
      const instance: AiProviderInstance = {
        type: effectiveTypeId,
        name: trimmedName,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }
      if (creatingNewType) {
        const newType: AiProviderType = {
          protocol: newTypeProtocol,
          requiresApiKey: newTypeRequiresApiKey,
          ...(newTypeLabel.trim() ? { label: newTypeLabel.trim() } : {}),
          ...(newTypeBaseUrl.trim() ? { defaultBaseUrl: newTypeBaseUrl.trim() } : {}),
        }
        await aiModel.updateProviderTypes({ ...existingTypes, [effectiveTypeId]: newType })
      }
      await aiModel.updateProviders([...existingInstances, instance])
      await storage.remove(DRAFT_KEY, StorageScope.GLOBAL)
      onCreated()
    } finally {
      setCreating(false)
    }
  }, [
    aiModel,
    apiKey,
    baseUrl,
    creatingNewType,
    effectiveTypeId,
    existingInstances,
    existingTypes,
    label,
    nameError,
    newTypeBaseUrl,
    newTypeError,
    newTypeLabel,
    newTypeProtocol,
    newTypeRequiresApiKey,
    onCreated,
    storage,
    trimmedName,
  ])

  const reuseCount = selectedType?.models?.length ?? 0

  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['dialogBackdrop']} onClick={onClose} />
      <div className={styles['dialog']} role="dialog" aria-modal="true">
        <h2 className={styles['dialogTitle']}>
          {localize('aiModels.addProvider.title', 'Add Provider')}
        </h2>

        <div className={styles['dialogBody']}>
          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.type', 'Provider type')}
            </label>
            <select
              className={styles['control']}
              value={selectedTypeId}
              aria-label={localize('aiModels.addProvider.type', 'Provider type')}
              onChange={(e) => setSelectedTypeId(e.target.value)}
            >
              {descriptors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} · {d.protocol}
                  {d.builtin
                    ? localize('aiModels.addProvider.builtin', ' (built-in)')
                    : localize('aiModels.addProvider.custom', ' (custom)')}
                </option>
              ))}
              <option value={NEW_TYPE}>
                {localize('aiModels.addProvider.newType', '＋ New type…')}
              </option>
            </select>
          </div>

          {!creatingNewType && selectedType && (
            <div className={styles['reuseHint']}>
              {localize(
                'aiModels.addProvider.reuse',
                'Will reuse the {count} models and rates of {type}.',
                { count: reuseCount, type: selectedType.label ?? selectedTypeId },
              )}
            </div>
          )}

          {creatingNewType && (
            <>
              <div className={styles['field']}>
                <label className={styles['label']}>
                  {localize('aiModels.addProvider.newType.id', 'Type id')}
                </label>
                <Input
                  value={newTypeId}
                  invalid={newTypeIdTrimmed.length > 0 && newTypeError !== undefined}
                  placeholder="my-gateway"
                  onChange={(e) => setNewTypeId(e.target.value)}
                />
                {newTypeIdTrimmed.length > 0 && newTypeError && (
                  <span className={styles['dialogFieldError']}>{newTypeError}</span>
                )}
              </div>

              <div className={styles['field']}>
                <label className={styles['label']}>
                  {localize('aiModels.addProvider.newType.label', 'Label')}
                </label>
                <Input
                  value={newTypeLabel}
                  placeholder={localize(
                    'aiModels.addProvider.newType.labelPlaceholder',
                    'Display name',
                  )}
                  onChange={(e) => setNewTypeLabel(e.target.value)}
                />
              </div>

              <div className={styles['field']}>
                <label className={styles['label']}>
                  {localize('aiModels.addProvider.newType.protocol', 'Protocol')}
                </label>
                <select
                  className={styles['control']}
                  value={newTypeProtocol}
                  aria-label={localize('aiModels.addProvider.newType.protocol', 'Protocol')}
                  onChange={(e) => setNewTypeProtocol(e.target.value as AiWireProtocol)}
                >
                  {PROTOCOLS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles['field']}>
                <label className={styles['label']}>
                  {localize('aiModels.addProvider.newType.baseUrl', 'Default base URL')}
                </label>
                <Input
                  value={newTypeBaseUrl}
                  placeholder="https://…"
                  onChange={(e) => setNewTypeBaseUrl(e.target.value)}
                />
              </div>

              <label className={styles['checkboxRow']}>
                <Checkbox
                  checked={newTypeRequiresApiKey}
                  onChange={(checked) => setNewTypeRequiresApiKey(checked)}
                />
                <span>
                  {localize('aiModels.addProvider.newType.requiresApiKey', 'Requires API key')}
                </span>
              </label>
            </>
          )}

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.name', 'Name')}
            </label>
            <Input
              value={name}
              invalid={trimmedName.length > 0 && nameError !== undefined}
              placeholder="default"
              onChange={(e) => setName(e.target.value)}
            />
            {trimmedName.length > 0 && nameError && (
              <span className={styles['dialogFieldError']}>{nameError}</span>
            )}
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.label', 'Label (optional)')}
            </label>
            <Input
              value={label}
              placeholder={localize('aiModels.addProvider.labelPlaceholder', 'Friendly name')}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.baseUrl', 'Base URL')}
            </label>
            <Input
              value={baseUrl}
              placeholder={
                effectiveDefaultBaseUrl ??
                localize('aiModels.baseUrl.placeholder', 'Provider default')
              }
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.apiKey', 'API Key (optional)')}
            </label>
            <Input
              type="password"
              value={apiKey}
              placeholder="sk-…"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className={styles['verifyRow']}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!effectiveTypeId}
              onClick={() => void runVerify()}
            >
              {localize('aiModels.addProvider.verify', 'Verify')}
            </Button>
            <VerifyStatus state={verify} />
          </div>
        </div>

        <div className={styles['dialogActions']}>
          <Button variant="ghost" onClick={onClose}>
            {localize('aiModels.addProvider.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            busy={creating}
            disabled={nameError !== undefined || newTypeError !== undefined}
            onClick={() => void create()}
          >
            {localize('aiModels.addProvider.create', 'Create')}
          </Button>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}

function VerifyStatus({ state }: { readonly state: VerifyState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'verifying') {
    return (
      <span className={styles['verifyStatus']}>
        <Spinner size={13} />
        {localize('aiModels.addProvider.verifying', 'Verifying…')}
      </span>
    )
  }
  if (state.kind === 'ok') {
    return (
      <span className={styles['verifyOk']}>
        <CheckCircle2 size={14} strokeWidth={2} />
        {localize('aiModels.addProvider.verifyOk', 'Connected · {count} models', {
          count: state.modelCount,
        })}
      </span>
    )
  }
  return (
    <span className={styles['verifyFail']} data-tooltip={state.error}>
      <XCircle size={14} strokeWidth={2} />
      {state.error}
    </span>
  )
}

/** A baseUrl is "complete enough" to probe: an http(s) URL with a host. */
function isCompleteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== ''
  } catch {
    return false
  }
}
