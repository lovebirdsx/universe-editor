/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AddProviderDialog — a focus-trapped modal for adding a single-layer provider
 *  *entry* (id / label / baseUrl / apiKey / default protocol). A template picker
 *  at the top seeds label / baseUrl / protocolMap / pricingSource from a known
 *  endpoint so the user does not have to know the catalog-vendor wiring by heart.
 *  The non-secret part of the draft (id / baseUrl / template) is persisted;
 *  the API key is NEVER persisted to storage — it only travels to main for the
 *  probe and, on create, into the entry's plaintext apiKey (written via
 *  updateProviders).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, XCircle } from 'lucide-react'
import {
  AI_WIRE_PROTOCOLS,
  IAiModelService,
  IStorageService,
  StorageScope,
  localize,
  type AiProviderEntry,
  type AiWireProtocol,
} from '@universe-editor/platform'
import {
  Button,
  FocusScopeOverlay,
  IconButton,
  Input,
  Select,
  Spinner,
} from '@universe-editor/workbench-ui'
import {
  PROVIDER_TEMPLATES,
  type AiProviderTemplate,
} from '../../../shared/ai/providerTemplates.js'
import { useService } from '../useService.js'
import styles from './AiSettingsEditor.module.css'

const DRAFT_KEY = 'ai.settings.addProvider.draft'
const VERIFY_DEBOUNCE_MS = 600

interface Draft {
  readonly id: string
  readonly baseUrl: string
  readonly template: string
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
  const { id, baseUrl, template } = raw as Partial<Draft>
  if (typeof id !== 'string' || typeof baseUrl !== 'string' || typeof template !== 'string')
    return undefined
  if (!PROVIDER_TEMPLATES.some((t) => t.id === template)) return undefined
  return { id, baseUrl, template }
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

  const [templateId, setTemplateId] = useState('custom')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyRevealed, setApiKeyRevealed] = useState(false)
  const [protocol, setProtocol] = useState<AiWireProtocol>('openai-chat')
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const [creating, setCreating] = useState(false)

  const draftRestored = useRef(false)
  const verifyToken = useRef(0)

  const selectedTemplate = useMemo(
    () => PROVIDER_TEMPLATES.find((t) => t.id === templateId),
    [templateId],
  )

  useEffect(() => {
    let active = true
    void storage.get<unknown>(DRAFT_KEY, StorageScope.GLOBAL).then((raw) => {
      if (!active) return
      const draft = readDraft(raw)
      if (draft) {
        // Template first: it seeds label/baseUrl/protocol, and the draft's own
        // values must win over those seeds, not the other way round.
        const tpl = PROVIDER_TEMPLATES.find((t) => t.id === draft.template)
        if (tpl) applyTemplate(tpl, setLabel, setBaseUrl, setProtocol)
        setTemplateId(draft.template)
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
    void storage.set(
      DRAFT_KEY,
      { id, baseUrl, template: templateId } satisfies Draft,
      StorageScope.GLOBAL,
    )
  }, [storage, id, baseUrl, templateId])

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

  const baseUrlTrimmed = baseUrl.trim()
  const baseUrlInvalid = baseUrlTrimmed.length > 0 && !isCompleteUrl(baseUrlTrimmed)

  const runVerify = useCallback(async () => {
    if (!trimmedId) return
    const token = ++verifyToken.current
    setVerify({ kind: 'verifying' })
    const result = await aiModel.verifyProvider({
      id: trimmedId,
      protocol,
      ...(baseUrlTrimmed ? { baseUrl: baseUrlTrimmed } : {}),
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
  }, [aiModel, trimmedId, protocol, baseUrlTrimmed, apiKey])

  useEffect(() => {
    if (!draftRestored.current || !trimmedId) return
    if (!isCompleteUrl(baseUrlTrimmed)) return
    const timer = setTimeout(() => void runVerify(), VERIFY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmedId, baseUrlTrimmed, apiKey, protocol, runVerify])

  const onTemplateChange = useCallback((newTemplateId: string) => {
    setTemplateId(newTemplateId)
    const tpl = PROVIDER_TEMPLATES.find((t) => t.id === newTemplateId)
    if (!tpl) return
    applyTemplate(tpl, setLabel, setBaseUrl, setProtocol)
    console.debug('aiModels: template selected', { templateId: newTemplateId })
  }, [])

  const create = useCallback(async () => {
    if (idError !== undefined || !trimmedId) return
    setCreating(true)
    try {
      const tpl = selectedTemplate
      const tplProtocolMap = tpl?.entry.protocolMap
      // Use the template's protocolMap only when the chosen protocol is one of
      // its keys; otherwise fall back to a bare discover-map for the chosen
      // protocol. pricingSource is kept regardless — picking a template
      // declares intent to use that vendor's rates even if the protocol changed.
      const protocolMap =
        tplProtocolMap !== undefined && protocol in tplProtocolMap
          ? tplProtocolMap
          : { [protocol]: [] }

      const entry: AiProviderEntry = {
        id: trimmedId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(baseUrlTrimmed ? { baseUrl: baseUrlTrimmed } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        defaultProtocol: protocol,
        protocolMap,
        ...(tpl?.entry.pricingSource !== undefined
          ? { pricingSource: tpl.entry.pricingSource }
          : {}),
        ...(tpl?.entry.usageSource !== undefined ? { usageSource: tpl.entry.usageSource } : {}),
      }
      console.debug('aiModels: creating provider', {
        id: entry.id,
        templateId,
        defaultProtocol: entry.defaultProtocol,
        hasPricingSource: entry.pricingSource !== undefined,
      })
      await aiModel.updateProviders([...existingProviders, entry])
      await storage.remove(DRAFT_KEY, StorageScope.GLOBAL)
      onCreated()
    } finally {
      setCreating(false)
    }
  }, [
    aiModel,
    apiKey,
    baseUrlTrimmed,
    existingProviders,
    idError,
    label,
    onCreated,
    protocol,
    selectedTemplate,
    storage,
    templateId,
    trimmedId,
  ])

  const templateOptions = useMemo(
    () =>
      PROVIDER_TEMPLATES.map((t) => ({
        value: t.id,
        label: (
          <span className={styles['configMeta'] ?? ''}>
            <span className={styles['configKey'] ?? ''}>{t.label}</span>
            <span className={styles['configDesc'] ?? ''}>{t.description}</span>
          </span>
        ),
        triggerLabel: t.label,
        text: t.label,
      })),
    [],
  )

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
              {localize('aiModels.addProvider.template', 'Template')}
            </label>
            <Select
              value={templateId}
              options={templateOptions}
              onChange={onTemplateChange}
              aria-label={localize('aiModels.addProvider.template', 'Template')}
            />
          </div>

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
              invalid={baseUrlInvalid}
              placeholder="https://…"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {baseUrlInvalid && (
              <span className={styles['dialogFieldError']}>
                {localize(
                  'aiModels.addProvider.baseUrlInvalid',
                  'Not a complete http(s) URL — you can still create, but verification will be skipped.',
                )}
              </span>
            )}
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.apiKey', 'API Key (optional)')}
            </label>
            <div className={styles['apiKeyRow']}>
              <Input
                type={apiKeyRevealed ? 'text' : 'password'}
                value={apiKey}
                placeholder="sk-…"
                onChange={(e) => setApiKey(e.target.value)}
              />
              <IconButton
                label={
                  apiKeyRevealed
                    ? localize('aiModels.addProvider.hideApiKey', 'Hide API key')
                    : localize('aiModels.addProvider.revealApiKey', 'Reveal API key')
                }
                onClick={() => setApiKeyRevealed((v) => !v)}
              >
                {apiKeyRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
            </div>
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.addProvider.protocol', 'Default protocol')}
            </label>
            <Select<AiWireProtocol>
              value={protocol}
              options={AI_WIRE_PROTOCOLS.map((p) => ({ value: p, label: p }))}
              onChange={setProtocol}
              aria-label={localize('aiModels.addProvider.protocol', 'Default protocol')}
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

function applyTemplate(
  tpl: AiProviderTemplate,
  setLabel: (v: string) => void,
  setBaseUrl: (v: string) => void,
  setProtocol: (v: AiWireProtocol) => void,
) {
  setLabel(tpl.entry.label ?? '')
  setBaseUrl(tpl.entry.baseUrl ?? '')
  setProtocol(tpl.entry.defaultProtocol ?? 'openai-chat')
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
