/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AddProviderDialog — a focus-trapped modal for adding a single-layer provider
 *  *entry* (id / label / baseUrl / apiKey / default protocol). No more
 *  "pick an existing type vs create a new type" branch: one entry is one gateway
 *  endpoint, and the models / rates it serves are declared later in its
 *  `protocolMap`. The non-secret part of the draft (id / baseUrl) is persisted;
 *  the API key is NEVER persisted to storage — it only travels to main for the
 *  probe and, on create, into the entry's plaintext apiKey (written via
 *  updateProviders).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import {
  IAiModelService,
  IStorageService,
  StorageScope,
  localize,
  type AiProviderEntry,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { Button, FocusScopeOverlay, Input, Select, Spinner } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import styles from './AiSettingsEditor.module.css'

const DRAFT_KEY = 'ai.settings.addProvider.draft'
const VERIFY_DEBOUNCE_MS = 600

const PROTOCOLS: readonly AiWireProtocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'ollama',
]

interface Draft {
  readonly id: string
  readonly baseUrl: string
}

/**
 * Storage is untyped — `get<T>` is a compile-time assertion and nothing validates
 * the bytes — and this key outlived an earlier `{ vendor, name, baseUrl }` draft,
 * so a stale entry still deserializes into a truthy object with no `id`. Validate
 * every field and take the draft all-or-nothing: half a restored form is worth
 * less than an empty one.
 */
function readDraft(raw: unknown): Draft | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { id, baseUrl } = raw as Partial<Draft>
  if (typeof id !== 'string' || typeof baseUrl !== 'string') return undefined
  return { id, baseUrl }
}

type VerifyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface AddProviderDialogProps {
  readonly existingProviders: readonly AiProviderEntry[]
  readonly onClose: () => void
  readonly onCreated: () => void
}

export function AddProviderDialog({
  existingProviders,
  onClose,
  onCreated,
}: AddProviderDialogProps) {
  const aiModel = useService(IAiModelService)
  const storage = useService(IStorageService)

  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState<AiWireProtocol>('openai-chat')
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const [creating, setCreating] = useState(false)

  const draftRestored = useRef(false)
  const verifyToken = useRef(0)

  useEffect(() => {
    let active = true
    void storage.get<unknown>(DRAFT_KEY, StorageScope.GLOBAL).then((raw) => {
      if (!active) return
      const draft = readDraft(raw)
      if (draft) {
        setId(draft.id)
        setBaseUrl(draft.baseUrl)
      }
      draftRestored.current = true
    })
    return () => {
      active = false
    }
  }, [storage])

  useEffect(() => {
    if (!draftRestored.current) return
    void storage.set(DRAFT_KEY, { id, baseUrl } satisfies Draft, StorageScope.GLOBAL)
  }, [storage, id, baseUrl])

  const trimmedId = id.trim()
  const idError = useMemo(() => {
    if (trimmedId.length === 0)
      return localize('aiModels.addProvider.idEmpty', 'Provider id is required.')
    if (trimmedId.includes('/'))
      return localize('aiModels.addProvider.idSlash', "Provider id must not contain '/'.")
    if (existingProviders.some((p) => p.id === trimmedId))
      return localize('aiModels.addProvider.idExists', 'That provider id already exists.')
    return undefined
  }, [trimmedId, existingProviders])

  const runVerify = useCallback(async () => {
    if (!trimmedId) return
    const token = ++verifyToken.current
    setVerify({ kind: 'verifying' })
    const result = await aiModel.verifyProvider({
      id: trimmedId,
      protocol,
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
  }, [aiModel, trimmedId, protocol, baseUrl, apiKey])

  useEffect(() => {
    if (!draftRestored.current || !trimmedId) return
    if (!isCompleteUrl(baseUrl.trim())) return
    const timer = setTimeout(() => void runVerify(), VERIFY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmedId, baseUrl, apiKey, protocol, runVerify])

  const create = useCallback(async () => {
    if (idError !== undefined || !trimmedId) return
    setCreating(true)
    try {
      // Seed `[]` (discover from the endpoint) for the chosen protocol: an entry
      // with no protocolMap resolves to a fatal `no-protocol` issue and serves
      // nothing, and the dialog's own verify step already enumerated models that
      // way. The user narrows it to an explicit list later in the JSON.
      const entry: AiProviderEntry = {
        id: trimmedId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        defaultProtocol: protocol,
        protocolMap: { [protocol]: [] },
      }
      await aiModel.updateProviders([...existingProviders, entry])
      await storage.remove(DRAFT_KEY, StorageScope.GLOBAL)
      onCreated()
    } finally {
      setCreating(false)
    }
  }, [
    aiModel,
    apiKey,
    baseUrl,
    existingProviders,
    idError,
    label,
    onCreated,
    protocol,
    storage,
    trimmedId,
  ])

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
              {localize('aiModels.addProvider.id', 'Provider id')}
            </label>
            <Input
              value={id}
              invalid={trimmedId.length > 0 && idError !== undefined}
              placeholder="my-gateway"
              onChange={(e) => setId(e.target.value)}
            />
            {trimmedId.length > 0 && idError && (
              <span className={styles['dialogFieldError']}>{idError}</span>
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
              placeholder="https://…"
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

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.protocol', 'Default protocol')}
            </label>
            <Select<AiWireProtocol>
              value={protocol}
              aria-label={localize('aiModels.addProvider.protocol', 'Default protocol')}
              options={PROTOCOLS.map((p) => ({ value: p, label: p }))}
              onChange={setProtocol}
            />
          </div>

          <div className={styles['verifyRow']}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!trimmedId}
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
            disabled={idError !== undefined}
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
