/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerConfigPanel — sectioned form over one workspace trigger definition.
 *  The draft is validated with the same parser the scheduler uses; saving writes
 *  only changed fields back into triggers.json (IFileService + mtime guard), so
 *  comments on untouched lines survive. Replacing `source` rewrites that object
 *  wholesale and drops comments inside it, hence the extra confirmation. A JSON
 *  editor with unsaved edits blocks the write.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  FileSystemError,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IDialogService,
  INotificationService,
  IUriIdentityService,
  Severity,
  localize,
} from '@universe-editor/platform'
import { Badge, Button, FormSection, Input } from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { triggerConfigErrorText } from '../../services/triggers/triggerPresentation.js'
import {
  parseTriggerDocument,
  type TriggerConfigSection,
} from '../../../shared/triggers/configDocument.js'
import type {
  TriggerConfig,
  TriggerConfigError,
  TriggerSummary,
} from '../../../shared/triggers/types.js'
import {
  isTriggerConfigEditorDirty,
  readTriggerConfig,
  saveTriggerConfig,
  saveTriggerConfigRebased,
  triggersConfigUri,
  type TriggerConfigSnapshot,
} from '../../services/triggers/triggerConfigFileService.js'
import { openTriggerConfigAt } from '../../services/triggers/revealTriggerConfig.js'
import { useService } from '../useService.js'
import {
  buildRawTrigger,
  draftFromConfig,
  validateTriggerDraft,
  withSourcePatch,
  withSourceType,
  type TriggerConfigDraft as Draft,
} from './triggerConfigDraft.js'
import { Field, ToggleField, errorText } from './triggerFormParts.js'
import styles from './TriggerConfigPanel.module.css'
import { TriggerBudgetFields } from './TriggerBudgetFields.js'
import { TriggerConcurrencyFields } from './TriggerConcurrencyFields.js'
import { TriggerSessionFields } from './TriggerSessionFields.js'
import { TriggerSourceFields } from './TriggerSourceFields.js'
import type { TriggerSourceDraftPatch } from './triggerSources/types.js'

/** Draft kept by the manager while the user switches tabs / triggers. */
export interface TriggerConfigDraftState {
  readonly draft: Draft
  readonly dirty: boolean
  /** Definition fingerprint the draft was based on; a mismatch means an external edit. */
  readonly fingerprint: string
  /** Definition the draft started from, so a later save can merge onto the latest disk text. */
  readonly origin?: TriggerConfig
}

export interface TriggerConfigPanelProps {
  readonly summary: TriggerSummary
  /** Preserved draft from an earlier visit to this trigger (manager-level). */
  readonly draftState?: TriggerConfigDraftState | undefined
  /** Reports the draft (only while dirty) so the manager can restore it later. */
  readonly onDraftStateChange?: (state: TriggerConfigDraftState | undefined) => void
}

type ReadonlyReason =
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'missing-file' }
  | {
      readonly kind: 'root-invalid'
      readonly message: string
      /** Present when the document parses but violates the config contract. */
      readonly issue?: TriggerConfigError
    }
  | { readonly kind: 'trigger-invalid'; readonly issues: readonly TriggerConfigError[] }
  | { readonly kind: 'missing-trigger' }

interface StatusMessage {
  readonly tone: 'info' | 'error'
  readonly text: string
}

function signature(value: unknown): string {
  return JSON.stringify(value)
}

function errorPath(issue: TriggerConfigError): string {
  return issue.path.join('.')
}

/**
 * The definition fingerprint covers every field the scheduler parses (name,
 * enabled, source, session incl. prompt / budget / cwd / model / mcpServers,
 * concurrency, overflow), so any external definition edit re-reads the file.
 * Run-status updates (running / lastRun*) keep the same fingerprint and are
 * ignored, and a trigger turning invalid is tracked separately because its
 * summary carries an empty fingerprint.
 */
function configSignature(summary: TriggerSummary): string {
  return JSON.stringify([
    summary.fingerprint,
    summary.status === 'invalid',
    summary.offline === true,
  ])
}

function isMissing(err: unknown): boolean {
  return err instanceof FileSystemError && err.code === 'ENOENT'
}

export function TriggerConfigPanel({
  summary,
  draftState,
  onDraftStateChange,
}: TriggerConfigPanelProps) {
  const files = useService(IFileService)
  const editors = useService(IEditorResolverService)
  const editorService = useService(IEditorService)
  const groups = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)
  const dialogs = useService(IDialogService)
  const notifications = useService(INotificationService)
  const triggers = useService(ITriggerMainService)

  const workspaceUri = useMemo(() => parseWorkspaceUri(summary.workspace), [summary.workspace])
  const configUri = useMemo(
    () => (workspaceUri === undefined ? undefined : triggersConfigUri(workspaceUri)),
    [workspaceUri],
  )

  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<TriggerConfigSnapshot | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [baseline, setBaseline] = useState<Record<string, unknown> | undefined>(undefined)
  const [originConfig, setOriginConfig] = useState<TriggerConfig | undefined>(undefined)
  const [readonlyReason, setReadonlyReason] = useState<ReadonlyReason | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [externalChange, setExternalChange] = useState(false)
  const [status, setStatus] = useState<StatusMessage | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const snapshotRef = useRef<TriggerConfigSnapshot | undefined>(undefined)
  snapshotRef.current = snapshot
  const summaryRef = useRef(summary)
  summaryRef.current = summary
  const draftStateRef = useRef<TriggerConfigDraftState | undefined>(draftState)
  draftStateRef.current = draftState
  const baseFingerprintRef = useRef(summary.fingerprint)
  const selectionSignatureRef = useRef(configSignature(summary))
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const readTokenRef = useRef(0)
  const rebaseOnSaveRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applySnapshot = useCallback(
    (next: TriggerConfigSnapshot | undefined, options: { keepDraft?: boolean } = {}) => {
      setSnapshot(next)
      setExternalChange(false)
      setStatus(undefined)
      rebaseOnSaveRef.current = false
      if (next === undefined) {
        setDraft(undefined)
        setBaseline(undefined)
        setOriginConfig(undefined)
        setReadonlyReason({ kind: 'missing-file' })
        return
      }
      const parsed = parseTriggerDocument(next.text)
      if (parsed.kind !== 'ok') {
        setDraft(undefined)
        setBaseline(undefined)
        setOriginConfig(undefined)
        setReadonlyReason({
          kind: 'root-invalid',
          message: parsed.kind === 'invalid' ? parsed.error : 'triggers.json is missing',
          ...(parsed.kind === 'invalid' && parsed.issue !== undefined
            ? { issue: parsed.issue }
            : {}),
        })
        return
      }
      const config = parsed.value.triggers.find((entry) => entry.id === summary.id)
      if (config === undefined) {
        setDraft(undefined)
        setBaseline(undefined)
        setOriginConfig(undefined)
        const invalid = parsed.value.invalid.find((entry) => entry.id === summary.id)
        setReadonlyReason(
          invalid === undefined
            ? { kind: 'missing-trigger' }
            : { kind: 'trigger-invalid', issues: invalid.issues },
        )
        return
      }
      // Keep a draft the user was editing in an earlier visit (tab / selection
      // switch). Its base fingerprint detects an external edit that happened
      // while the draft was parked.
      const restored = options.keepDraft === true ? draftStateRef.current : undefined
      setDraft(restored?.draft ?? draftFromConfig(config))
      setBaseline(buildRawTrigger(config.id, draftFromConfig(config)))
      setOriginConfig(restored?.origin ?? config)
      baseFingerprintRef.current = restored?.fingerprint ?? summaryRef.current.fingerprint
      setReadonlyReason(undefined)
      if (
        restored !== undefined &&
        restored.dirty &&
        restored.fingerprint !== summaryRef.current.fingerprint
      ) {
        setExternalChange(true)
      }
    },
    [summary.id],
  )

  const readFromDisk = useCallback(
    async (auto: boolean, options: { keepDraft?: boolean } = {}): Promise<void> => {
      if (workspaceUri === undefined) return
      if (auto && summaryRef.current.offline === true) return
      const token = ++readTokenRef.current
      let next: TriggerConfigSnapshot | undefined
      try {
        next = await readTriggerConfig(files, workspaceUri)
      } catch (err) {
        if (!mountedRef.current || token !== readTokenRef.current) return
        setLoading(false)
        // An automatic (event-driven) refresh must never replace the loaded form
        // with a blocking error page; the snapshot and draft stay as they are.
        if (!auto) setLoadError(errorText(err))
        return
      }
      if (!mountedRef.current || token !== readTokenRef.current) return
      setLoading(false)
      setLoadError(undefined)
      const current = snapshotRef.current
      const unchanged =
        auto &&
        current !== undefined &&
        current.text === next?.text &&
        current.mtime === next?.mtime
      if (unchanged) return
      if (auto && dirtyRef.current) {
        setExternalChange(true)
        return
      }
      applySnapshot(next, options)
    },
    [applySnapshot, files, workspaceUri],
  )

  useEffect(() => {
    setLoading(true)
    setLoadError(undefined)
    setSnapshot(undefined)
    setDraft(undefined)
    setBaseline(undefined)
    setOriginConfig(undefined)
    setReadonlyReason(undefined)
    setExternalChange(false)
    setStatus(undefined)
    snapshotRef.current = undefined
    baseFingerprintRef.current = summaryRef.current.fingerprint
    selectionSignatureRef.current = configSignature(summaryRef.current)
    if (workspaceUri === undefined) {
      setReadonlyReason({ kind: 'no-workspace' })
      setLoading(false)
      return
    }
    // A draft parked by the manager survives tab / selection switches.
    void readFromDisk(false, { keepDraft: true })
  }, [readFromDisk, workspaceUri])

  useEffect(() => {
    const subscription = triggers.onDidChangeTriggers((list) => {
      const current = summaryRef.current
      if (current.offline === true) return
      const next = list.find((entry) => entry.key === current.key)
      const signature = next === undefined ? 'missing' : configSignature(next)
      if (signature === selectionSignatureRef.current) return
      selectionSignatureRef.current = signature
      void readFromDisk(true)
    })
    return () => subscription.dispose()
  }, [readFromDisk, triggers])

  const rawDraft = useMemo(
    () => (draft === undefined ? undefined : buildRawTrigger(summary.id, draft)),
    [draft, summary.id],
  )
  const dirty =
    rawDraft !== undefined && baseline !== undefined && signature(rawDraft) !== signature(baseline)
  dirtyRef.current = dirty
  const validation = useMemo(
    () => (draft === undefined ? undefined : validateTriggerDraft(summary.id, draft)),
    [draft, summary.id],
  )
  const issues = validation?.issues ?? []
  const canSave =
    dirty && validation?.config !== undefined && !saving && readonlyReason === undefined

  // Keep the manager's per-trigger draft store in sync. Clean drafts are dropped:
  // only unsaved edits need to survive tab / selection switches.
  useEffect(() => {
    if (draft === undefined || baseline === undefined) return
    if (!dirty) {
      onDraftStateChange?.(undefined)
      return
    }
    onDraftStateChange?.({
      draft,
      dirty: true,
      fingerprint: baseFingerprintRef.current,
      ...(originConfig !== undefined ? { origin: originConfig } : {}),
    })
  }, [baseline, dirty, draft, onDraftStateChange, originConfig])

  const changedSections = useMemo(() => {
    if (rawDraft === undefined || baseline === undefined) {
      return { source: false }
    }
    return {
      source: signature(rawDraft['source']) !== signature(baseline['source']),
    }
  }, [rawDraft, baseline])

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => (current === undefined ? current : { ...current, ...patch }))
  }, [])

  const openJson = useCallback(
    (section?: TriggerConfigSection) => {
      if (configUri === undefined) return
      if (snapshot === undefined) {
        void editors.openEditor(configUri, { pinned: true })
        return
      }
      openTriggerConfigAt(
        { editors, editorService, groups, uriIdentity },
        configUri,
        snapshot.text,
        summary.id,
        section,
      )
    },
    [configUri, editorService, editors, groups, snapshot, summary.id, uriIdentity],
  )

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    const { confirmed } = await dialogs.confirm({
      type: 'warning',
      message: localize(
        'trigger.manager.config.discardDraft',
        'Discard your unsaved changes to trigger "{name}"?',
        { name: summaryRef.current.name },
      ),
      primaryButton: localize('trigger.manager.config.discard', 'Discard'),
    })
    return confirmed
  }, [dialogs])

  const reload = useCallback(async () => {
    setStatus(undefined)
    if (!(await confirmDiscard())) return
    await readFromDisk(false)
  }, [confirmDiscard, readFromDisk])

  const revert = useCallback(async () => {
    if (snapshot === undefined) return
    if (!(await confirmDiscard())) return
    applySnapshot(snapshot)
  }, [applySnapshot, confirmDiscard, snapshot])

  const keepEdits = useCallback(async () => {
    // Keep the draft but move the snapshot to the latest disk text: later saves
    // rebase the draft patch onto it instead of failing the stale-snapshot check.
    rebaseOnSaveRef.current = true
    setExternalChange(false)
    setStatus(undefined)
    if (workspaceUri === undefined) return
    const before = snapshotRef.current
    try {
      const latest = await readTriggerConfig(files, workspaceUri)
      // Another read or a completed save may have replaced the snapshot while
      // this one was in flight; never regress the panel to older disk text.
      if (!mountedRef.current || snapshotRef.current !== before || latest === undefined) return
      snapshotRef.current = latest
      setSnapshot(latest)
    } catch {
      // The save itself reads the latest text inside the write queue.
    }
  }, [files, workspaceUri])

  const jsonEditorDirty = useCallback((): boolean => {
    if (configUri === undefined) return false
    return isTriggerConfigEditorDirty({ groups, uriIdentity }, configUri)
  }, [configUri, groups, uriIdentity])

  const save = useCallback(async () => {
    const next = validation?.config
    if (next === undefined || snapshot === undefined) return
    if (jsonEditorDirty()) {
      setStatus({
        tone: 'error',
        text: localize(
          'trigger.manager.config.dirtyEditor',
          'triggers.json has unsaved changes in the editor. Save or revert it before saving here.',
        ),
      })
      return
    }
    const { confirmed } = await dialogs.confirm({
      type: 'warning',
      message: localize(
        'trigger.manager.config.confirmSave',
        'Save changes to trigger "{name}"? Saving requires confirming the trigger again before it can run.',
        { name: summary.name },
      ),
      ...(changedSections.source
        ? {
            detail: localize(
              'trigger.manager.config.confirmSaveComments',
              'Because the trigger source changes, that value is rewritten as a whole and any comments inside it in triggers.json will be lost.',
            ),
          }
        : {}),
      primaryButton: localize('trigger.manager.config.save', 'Save'),
    })
    if (!confirmed) return

    setSaving(true)
    try {
      const write = async (overwrite: boolean) => {
        if (rebaseOnSaveRef.current && originConfig !== undefined) {
          return saveTriggerConfigRebased(files, snapshot, summary.id, next, {
            isEditorDirty: jsonEditorDirty,
            origin: originConfig,
            ...(overwrite ? { overwrite: true } : {}),
          })
        }
        return saveTriggerConfig(files, snapshot, summary.id, next, {
          isEditorDirty: jsonEditorDirty,
        })
      }
      let result = await write(false)
      if (!mountedRef.current) return
      if (result.kind === 'field-conflict') {
        const choice = await dialogs.confirm({
          type: 'warning',
          message: localize(
            'trigger.manager.config.fieldConflict',
            'These fields also changed in triggers.json: {fields}. Overwrite the disk values with your edits?',
            { fields: result.fields.join(', ') },
          ),
          primaryButton: localize('trigger.manager.config.overwrite', 'Overwrite'),
        })
        if (!mountedRef.current) return
        if (!choice.confirmed) {
          setExternalChange(true)
          setStatus({
            tone: 'info',
            text: localize(
              'trigger.manager.config.fieldConflictCancelled',
              'Save cancelled. Reload triggers.json or keep your edits.',
            ),
          })
          return
        }
        result = await write(true)
        if (!mountedRef.current) return
      }
      switch (result.kind) {
        case 'ok': {
          applySnapshot({ uri: snapshot.uri, text: result.text, mtime: result.mtime })
          const message = localize(
            'trigger.manager.config.saved',
            'Saved. Confirm the trigger again before it can run.',
          )
          setStatus({ tone: 'info', text: message })
          notifications.notify({ severity: Severity.Info, message })
          return
        }
        case 'conflict':
          setExternalChange(true)
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.conflict',
              'triggers.json changed on disk while you were editing. Reload it to continue.',
            ),
          })
          return
        case 'missing-trigger':
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.missingTrigger',
              'This trigger is no longer present in triggers.json. Reload the file.',
            ),
          })
          return
        case 'dirty-editor':
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.dirtyEditor',
              'triggers.json has unsaved changes in the editor. Save or revert it before saving here.',
            ),
          })
          return
        case 'invalid':
          setStatus({
            tone: 'error',
            text: localize('trigger.manager.config.invalid', 'Cannot save: {error}', {
              error: result.error,
            }),
          })
          return
        case 'field-conflict':
          setExternalChange(true)
          setStatus({
            tone: 'error',
            text: localize(
              'trigger.manager.config.fieldConflictStill',
              'These fields still conflict: {fields}. Reload triggers.json to continue.',
              { fields: result.fields.join(', ') },
            ),
          })
          return
      }
    } catch (err) {
      if (!mountedRef.current) return
      const missing = isMissing(err)
      setStatus({
        tone: 'error',
        text: missing
          ? localize(
              'trigger.manager.config.conflict',
              'triggers.json changed on disk while you were editing. Reload it to continue.',
            )
          : localize('trigger.manager.config.saveFailed', 'Saving failed: {error}', {
              error: errorText(err),
            }),
      })
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [
    applySnapshot,
    changedSections.source,
    dialogs,
    files,
    jsonEditorDirty,
    notifications,
    originConfig,
    snapshot,
    summary.id,
    summary.name,
    validation?.config,
  ])

  if (loading) {
    return (
      <div className={styles['state']} data-testid="trigger-manager-config-loading">
        {localize('trigger.manager.config.loading', 'Loading trigger configuration…')}
      </div>
    )
  }

  if (loadError !== undefined) {
    return (
      <div className={styles['placeholder']} data-testid="trigger-manager-config-load-error">
        <p className={styles['notice']}>
          {localize('trigger.manager.config.loadFailed', 'Could not read triggers.json: {error}', {
            error: loadError,
          })}
        </p>
        <Button size="sm" onClick={() => void reload()} data-testid="trigger-manager-config-reload">
          {localize('trigger.manager.config.reload', 'Reload')}
        </Button>
      </div>
    )
  }

  if (readonlyReason !== undefined || draft === undefined || snapshot === undefined) {
    return (
      <ReadonlyConfig
        reason={readonlyReason ?? { kind: 'missing-trigger' }}
        onOpenJson={openJson}
      />
    )
  }

  const fieldError = (...paths: string[]): string | undefined => {
    const issue = issues.find((entry) => {
      const key = errorPath(entry)
      return paths.some((path) => key === path || key.startsWith(`${path}.`))
    })
    return issue === undefined ? undefined : triggerConfigErrorText(issue)
  }

  return (
    <div className={styles['config']} data-testid="trigger-manager-config">
      <header className={styles['configHeader']}>
        <div className={styles['configHeading']}>
          <h2 className={styles['overviewTitle']}>{summary.name}</h2>
          <span className={styles['overviewSubtitle']}>{summary.id}</span>
        </div>
        <div className={styles['configHeaderActions']}>
          {dirty && (
            <span data-testid="trigger-manager-config-dirty">
              <Badge tone="accent">{localize('trigger.manager.config.dirty', 'Unsaved')}</Badge>
            </span>
          )}
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void revert()}
            data-testid="trigger-manager-config-revert"
          >
            {localize('trigger.manager.config.revert', 'Revert')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={() => void save()}
            data-testid="trigger-manager-config-save"
          >
            {saving
              ? localize('trigger.manager.config.saving', 'Saving…')
              : localize('trigger.manager.config.save', 'Save')}
          </Button>
        </div>
      </header>

      {externalChange && (
        <div className={styles['notice']} data-testid="trigger-manager-config-external-change">
          <span>
            {localize(
              'trigger.manager.config.externalChange',
              'triggers.json was changed outside this form. Reload to pick up the new content, or keep your local edits.',
            )}
          </span>
          <Button
            size="sm"
            onClick={() => void reload()}
            data-testid="trigger-manager-config-external-reload"
          >
            {localize('trigger.manager.config.reload', 'Reload')}
          </Button>
          <Button
            size="sm"
            onClick={() => void keepEdits()}
            data-testid="trigger-manager-config-external-keep"
          >
            {localize('trigger.manager.config.keepDraft', 'Keep my edits')}
          </Button>
        </div>
      )}

      {status !== undefined && (
        <p
          className={status.tone === 'error' ? styles['fieldError'] : styles['note']}
          data-testid="trigger-manager-config-status"
        >
          {status.text}
        </p>
      )}

      {issues.length > 0 && (
        <div className={styles['notice']} data-testid="trigger-manager-config-errors">
          <ul className={styles['errorList']}>
            {issues.map((issue, index) => (
              <li key={`${errorPath(issue)}:${issue.code}:${index}`}>
                {triggerConfigErrorText(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section
        title={localize('trigger.manager.config.basics', 'Basics')}
        testId="basics"
        onEditJson={() => openJson('trigger')}
      >
        <Field label={localize('trigger.manager.config.id', 'ID')}>
          <Input value={summary.id} readOnly disabled data-testid="trigger-manager-config-id" />
        </Field>
        <Field label={localize('trigger.manager.config.name', 'Name')} error={fieldError('name')}>
          <Input
            value={draft.name}
            invalid={fieldError('name') !== undefined}
            onChange={(event) => update({ name: event.target.value })}
            data-testid="trigger-manager-config-name"
          />
        </Field>
        <ToggleField
          label={localize('trigger.manager.config.enabled', 'Enabled')}
          checked={draft.enabled}
          onChange={(enabled) => update({ enabled })}
          testId="trigger-manager-config-enabled"
        />
        <ToggleField
          label={localize(
            'trigger.manager.config.showSession',
            'Reveal the session while it runs (visible windows only)',
          )}
          checked={draft.showSession}
          onChange={(showSession) => update({ showSession })}
          testId="trigger-manager-config-show-session"
        />
        <TriggerConcurrencyFields
          draft={draft}
          update={update}
          fieldError={fieldError}
          testIdPrefix="trigger-manager-config"
        />
      </Section>

      <Section
        title={localize('trigger.manager.config.source', 'Trigger source')}
        testId="source"
        onEditJson={() => openJson('source')}
      >
        <TriggerSourceFields
          source={draft.source}
          setSourceType={(type) =>
            setDraft((current) => (current === undefined ? current : withSourceType(current, type)))
          }
          updateSource={(patch: TriggerSourceDraftPatch) =>
            setDraft((current) =>
              current === undefined ? current : withSourcePatch(current, patch),
            )
          }
          fieldError={fieldError}
          testIdPrefix="trigger-manager-config"
        />
      </Section>

      <Section
        title={localize('trigger.manager.config.session', 'Session')}
        testId="session"
        onEditJson={() => openJson('session')}
      >
        <TriggerSessionFields
          draft={draft}
          update={update}
          fieldError={fieldError}
          testIdPrefix="trigger-manager-config"
        />
      </Section>

      <Section
        title={localize('trigger.manager.config.budget', 'Budget')}
        testId="budget"
        onEditJson={() => openJson('budget')}
      >
        <TriggerBudgetFields
          draft={draft}
          update={update}
          fieldError={fieldError}
          testIdPrefix="trigger-manager-config"
        />
      </Section>
    </div>
  )
}

function ReadonlyConfig({
  reason,
  onOpenJson,
}: {
  readonly reason: ReadonlyReason
  readonly onOpenJson: (section?: 'trigger') => void
}) {
  const detail = ((): string => {
    switch (reason.kind) {
      case 'no-workspace':
        return localize(
          'trigger.manager.config.noWorkspace',
          'This trigger does not belong to a workspace that can be edited here.',
        )
      case 'missing-file':
        return localize(
          'trigger.manager.config.missingFile',
          'triggers.json does not exist. Open it to create the file, then reopen this form.',
        )
      case 'root-invalid':
        return localize(
          'trigger.manager.config.rootInvalid',
          'triggers.json cannot be parsed, so the form is read-only: {error}',
          {
            error:
              reason.issue === undefined ? reason.message : triggerConfigErrorText(reason.issue),
          },
        )
      case 'trigger-invalid':
        return localize(
          'trigger.manager.config.triggerInvalid',
          'This trigger is invalid and cannot be edited here. Fix it in JSON: {errors}',
          { errors: reason.issues.map(triggerConfigErrorText).join('; ') },
        )
      case 'missing-trigger':
        return localize(
          'trigger.manager.config.missingTrigger',
          'This trigger is no longer present in triggers.json. Reload the manager.',
        )
    }
  })()

  return (
    <div className={styles['placeholder']} data-testid="trigger-manager-config-readonly">
      <h3 className={styles['sectionTitle']}>
        {localize('trigger.manager.overview.configuration', 'Configuration')}
      </h3>
      <p className={styles['notice']}>{detail}</p>
      <div>
        <Button
          size="sm"
          onClick={() => onOpenJson('trigger')}
          data-testid="trigger-manager-config-open-json"
        >
          {localize('trigger.manager.config.openJson', 'Edit in JSON')}
        </Button>
      </div>
    </div>
  )
}

function Section({
  title,
  testId,
  onEditJson,
  children,
}: {
  readonly title: string
  readonly testId: string
  readonly onEditJson: () => void
  readonly children: ReactNode
}) {
  return (
    <FormSection
      title={title}
      className={styles['configSection']}
      data-testid={`trigger-manager-config-section-${testId}`}
      actions={
        <Button
          size="sm"
          onClick={onEditJson}
          data-testid={`trigger-manager-config-json-${testId}`}
        >
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          {localize('trigger.manager.config.editInJson', 'Edit in JSON')}
        </Button>
      }
    >
      {children}
    </FormSection>
  )
}
