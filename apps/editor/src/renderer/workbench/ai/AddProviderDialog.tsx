/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AddProviderDialog — a focus-trapped modal for adding a provider group. The user
 *  picks a vendor (from the registered providers), names the group, sets an
 *  optional baseUrl / API key, and the dialog auto-probes the endpoint for
 *  validity. The non-secret part of the draft (vendor / name / baseUrl) is
 *  persisted so a half-finished entry survives a close; the API key is NEVER
 *  persisted to storage — it only travels to main for the probe and, on create,
 *  into encrypted secret storage.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import {
  IAiModelService,
  IStorageService,
  StorageScope,
  localize,
  type AiProviderGroup,
  type AiVendorDescriptor,
} from '@universe-editor/platform'
import { Button, FocusScopeOverlay, Input, Spinner } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import styles from './AiSettingsEditor.module.css'

const DRAFT_KEY = 'ai.settings.addProvider.draft'
const VERIFY_DEBOUNCE_MS = 600

interface Draft {
  readonly vendor: string
  readonly name: string
  readonly baseUrl: string
}

type VerifyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface AddProviderDialogProps {
  readonly existingGroups: readonly AiProviderGroup[]
  readonly onClose: () => void
  readonly onCreated: () => void
}

export function AddProviderDialog({ existingGroups, onClose, onCreated }: AddProviderDialogProps) {
  const aiModel = useService(IAiModelService)
  const storage = useService(IStorageService)

  const [vendors, setVendors] = useState<readonly AiVendorDescriptor[]>([])
  const [vendor, setVendor] = useState('')
  const [name, setName] = useState('default')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const [creating, setCreating] = useState(false)

  const draftRestored = useRef(false)
  const verifyToken = useRef(0)

  // Load the vendor list, then overlay the persisted (key-free) draft.
  useEffect(() => {
    let active = true
    void (async () => {
      const [list, draft] = await Promise.all([
        aiModel.getVendors(),
        storage.get<Draft>(DRAFT_KEY, StorageScope.GLOBAL),
      ])
      if (!active) return
      setVendors(list)
      const restoredVendor =
        draft && list.some((v) => v.vendor === draft.vendor) ? draft.vendor : ''
      setVendor(restoredVendor || list[0]?.vendor || '')
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
    void storage.set(DRAFT_KEY, { vendor, name, baseUrl } satisfies Draft, StorageScope.GLOBAL)
  }, [storage, vendor, name, baseUrl])

  const selectedVendor = useMemo(() => vendors.find((v) => v.vendor === vendor), [vendors, vendor])

  const trimmedName = name.trim()
  const nameError = useMemo(() => {
    if (trimmedName.length === 0)
      return localize('aiModels.addProvider.nameEmpty', 'Name is required.')
    if (trimmedName.includes('/'))
      return localize('aiModels.addProvider.nameSlash', "Name must not contain '/'.")
    if (existingGroups.some((g) => g.vendor === vendor && g.name === trimmedName))
      return localize('aiModels.addProvider.exists', 'That provider group already exists.')
    return undefined
  }, [trimmedName, existingGroups, vendor])

  const runVerify = useCallback(async () => {
    if (!vendor) return
    const token = ++verifyToken.current
    setVerify({ kind: 'verifying' })
    const result = await aiModel.verifyGroup({
      vendor,
      name: trimmedName || 'default',
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
  }, [aiModel, vendor, trimmedName, baseUrl, apiKey])

  // Auto-probe when the connection-relevant fields settle — but only once the
  // baseUrl is a complete URL. Empty or half-typed values would otherwise spam
  // pointless probes / failures; the manual "Verify" button still works for
  // vendors that rely on their default endpoint.
  useEffect(() => {
    if (!draftRestored.current || !vendor) return
    if (!isCompleteUrl(baseUrl.trim())) return
    const timer = setTimeout(() => void runVerify(), VERIFY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [vendor, baseUrl, apiKey, runVerify])

  const create = useCallback(async () => {
    if (nameError || !vendor) return
    setCreating(true)
    try {
      const group: AiProviderGroup = {
        vendor,
        name: trimmedName,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      }
      await aiModel.updateGroups([...existingGroups, group])
      if (apiKey.trim()) await aiModel.setApiKey(vendor, trimmedName, apiKey.trim())
      await storage.remove(DRAFT_KEY, StorageScope.GLOBAL)
      onCreated()
    } finally {
      setCreating(false)
    }
  }, [aiModel, apiKey, baseUrl, existingGroups, nameError, onCreated, storage, trimmedName, vendor])

  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['dialogBackdrop']} onClick={onClose} />
      <div className={styles['dialog']} role="dialog" aria-modal="true">
        <h2 className={styles['dialogTitle']}>
          {localize('aiModels.addProvider.title', 'Add Provider Group')}
        </h2>

        <div className={styles['dialogBody']}>
          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.vendor', 'Vendor')}
            </label>
            <select
              className={styles['control']}
              value={vendor}
              aria-label={localize('aiModels.addProvider.vendor', 'Vendor')}
              onChange={(e) => setVendor(e.target.value)}
            >
              {vendors.map((v) => (
                <option key={v.vendor} value={v.vendor}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

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
              {localize('aiModels.addProvider.baseUrl', 'Base URL')}
            </label>
            <Input
              value={baseUrl}
              placeholder={
                selectedVendor?.defaultBaseUrl ??
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
            <Button variant="ghost" size="sm" disabled={!vendor} onClick={() => void runVerify()}>
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
            disabled={nameError !== undefined}
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
    <span className={styles['verifyFail']} title={state.error}>
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
