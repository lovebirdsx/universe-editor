/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiModelKnowledgePanel — the "Model configuration" category of the AI settings
 *  editor: the `models` knowledge base at the top level of aiSettings.json. An
 *  entry describes what a model *is* (name, family, real vendor, native protocol,
 *  token limits, capabilities, reasoning-effort levels, request parameters) —
 *  intrinsic properties that hold no matter which gateway serves it. Rates are
 *  deliberately not here: a price is a function of (channel, model) and belongs to
 *  the provider entry.
 *
 *  Only the *user* layer is ever written (`getUserModelKnowledge` /
 *  `updateModelKnowledge`). Writing back the merged view would materialize the
 *  whole built-in catalog into the user's file and pin it against future built-in
 *  upgrades, so a built-in model is instead "overridden" by an entry that starts
 *  empty and grows one field at a time.
 *
 *  Unlike the providers panel this one never calls `getModels()`: that is the slow
 *  endpoint enumeration, and nothing here depends on which models a gateway
 *  currently answers with.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileJson, Plus, TriangleAlert } from 'lucide-react'
import {
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  IStorageService,
  IUserDataFilesService,
  StorageScope,
  UserDataFile,
  localize,
  type AiModelKnowledge,
  type AiProviderEntry,
} from '@universe-editor/platform'
import { Badge, Button, Spinner } from '@universe-editor/workbench-ui'
import { useEventSubscription, useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../../services/editor/openInLockAwareGroup.js'
import { BUILTIN_MODEL_KNOWLEDGE } from '../../../shared/ai/catalog/modelKnowledge.js'
import { isValidKnowledgeKey, nextCopyKey } from '../../../shared/ai/modelKnowledgeEdit.js'
import {
  referencingProviders,
  rewriteRefsForRename,
} from '../../../shared/ai/modelKnowledgeUsage.js'
import { refKnowledgeKey } from '../../../shared/ai/protocolMapEdit.js'
import { PanelSection, useCollapseToggle } from './PanelSection.js'
import { AddModelDialog } from './modelCard/AddModelDialog.js'
import { ModelKnowledgeCard, type KnowledgePatch } from './modelCard/ModelKnowledgeCard.js'
import styles from './AiSettingsEditor.module.css'

const COLLAPSED_KEY = 'ai.settings.modelKnowledge.collapsed'

const SECTION_CUSTOM = 'section:custom'
const SECTION_BUILTIN = 'section:builtin'
const modelCollapseKey = (key: string): string => `model:${key}`

export function AiModelKnowledgePanel() {
  const aiModel = useService(IAiModelService)
  const dialog = useService(IDialogService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const storage = useService(IStorageService)

  const [providers, setProviders] = useState<readonly AiProviderEntry[]>([])
  const [userKnowledge, setUserKnowledge] = useState<Readonly<Record<string, AiModelKnowledge>>>({})
  const [legacy, setLegacy] = useState(false)
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({})
  /**
   * 'failed' is its own state on purpose: the snapshot is then still the empty
   * placeholder, so editing must stay locked rather than silently offer to
   * replace the user's `models` with nothing.
   */
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [addOpen, setAddOpen] = useState(false)

  /**
   * `updateModelKnowledge` replaces the whole map, so every write must start from
   * the newest one. Render state is too old for that: with per-field immediate
   * saves a second commit can be issued while the first is still in flight, and a
   * stale snapshot would silently undo it. The refs carry the values across that
   * window; the chain keeps writes from interleaving at all.
   */
  const knowledgeRef = useRef<Readonly<Record<string, AiModelKnowledge>>>({})
  const providersRef = useRef<readonly AiProviderEntry[]>([])
  const writeChain = useRef<Promise<unknown>>(Promise.resolve())
  /** Bumped by every snapshot replacement so a stale read can't clobber it. */
  const writeSeqRef = useRef(0)
  /** Set on unmount; async reload continuations skip setState once it flips. */
  const disposedRef = useRef(false)
  /**
   * Every write replaces the whole map, so writing before the first read lands
   * would replace the user's real `models` with a map built from the empty
   * placeholder — silently wiping the file. The buttons are disabled until then;
   * this is the guard that makes it true regardless of how the call was reached.
   */
  const loadedRef = useRef(false)
  /** Mirrors `legacy` so the write guard reads it without a stale closure. */
  const legacyRef = useRef(false)

  /**
   * The single gate in front of every write. Two states must never write:
   * `legacy` (the file is in the retired format and we promised not to rewrite
   * it) and "not loaded yet" (the snapshot is the empty placeholder, so a
   * wholesale replacement would wipe the user's `models`). The toolbar and the
   * cards are disabled in both, but a queued click or a keyboard activation can
   * still land here, so the guard is checked again at write time.
   */
  const enqueueWrite = useCallback((run: () => Promise<void>): Promise<void> => {
    const guarded = async () => {
      if (legacyRef.current || !loadedRef.current) {
        console.debug('aiKnowledge: write skipped', {
          legacy: legacyRef.current,
          loaded: loadedRef.current,
        })
        return
      }
      await run()
    }
    const next = writeChain.current.then(guarded, guarded)
    writeChain.current = next.catch(() => undefined)
    return next
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  useEffect(() => {
    let active = true
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored) setCollapsed(stored)
    })
    return () => {
      active = false
    }
  }, [storage])

  /**
   * `defaultCollapsed` matters here: see `useCollapseToggle` for why the toggle has
   * to negate the *effective* value rather than the stored one.
   */
  const toggleCollapsed = useCollapseToggle(storage, COLLAPSED_KEY, setCollapsed)

  const reload = useCallback(async () => {
    const version = writeSeqRef.current
    try {
      const [nextProviders, nextKnowledge, nextLegacy] = await Promise.all([
        aiModel.getProviders(),
        aiModel.getUserModelKnowledge(),
        aiModel.isLegacySettingsFormat(),
      ])
      if (disposedRef.current) return
      if (version === writeSeqRef.current) {
        providersRef.current = nextProviders
        knowledgeRef.current = nextKnowledge
        setProviders(nextProviders)
        setUserKnowledge(nextKnowledge)
      }
      setLegacy(nextLegacy)
      legacyRef.current = nextLegacy
      loadedRef.current = true
      setLoad('ready')
    } catch (error) {
      // Deliberately not 'ready': the snapshot is still the empty placeholder, and
      // a write from here would replace the real `models` with it.
      console.debug('aiKnowledge: reload failed', error)
      if (!disposedRef.current) setLoad('failed')
    }
  }, [aiModel])

  useEffect(() => {
    void reload()
  }, [reload])

  useEventSubscription(() => [aiModel.onDidChangeModels(() => void reload())], [aiModel, reload])

  const updateKnowledge = useCallback(
    async (next: Readonly<Record<string, AiModelKnowledge>>) => {
      knowledgeRef.current = next
      writeSeqRef.current++
      await aiModel.updateModelKnowledge(next)
      await reload()
    },
    [aiModel, reload],
  )

  const replaceKnowledgeAt = useCallback(
    (key: string, build: KnowledgePatch) =>
      enqueueWrite(async () => {
        const current = knowledgeRef.current
        const entry = current[key]
        if (entry === undefined) return
        await updateKnowledge({ ...current, [key]: build(entry) })
      }),
    [enqueueWrite, updateKnowledge],
  )

  const addKnowledge = useCallback(
    (key: string) =>
      enqueueWrite(async () => {
        const current = knowledgeRef.current
        if (current[key] !== undefined) return
        console.debug('aiKnowledge: add model', { key })
        await updateKnowledge({ ...current, [key]: {} })
      }),
    [enqueueWrite, updateKnowledge],
  )

  const duplicateKnowledge = useCallback(
    (key: string) =>
      enqueueWrite(async () => {
        const current = knowledgeRef.current
        const source = current[key]
        if (source === undefined) return
        // A copy must not collide with a built-in key either: that would silently
        // turn a duplicate into an override of an unrelated model.
        const taken = new Set([...Object.keys(current), ...Object.keys(BUILTIN_MODEL_KNOWLEDGE)])
        const copy = nextCopyKey(key, taken)
        console.debug('aiKnowledge: duplicate model', { from: key, to: copy })
        await updateKnowledge({ ...current, [copy]: { ...source } })
      }),
    [enqueueWrite, updateKnowledge],
  )

  const removeKnowledge = useCallback(
    async (key: string) => {
      const isOverride = BUILTIN_MODEL_KNOWLEDGE[key] !== undefined
      // providersRef, not render state: a write in flight may already have moved
      // refs, and the confirmation must name who is actually affected now.
      const refs = referencingProviders(providersRef.current, key)
      const detail =
        refs.length === 0 || isOverride
          ? undefined
          : localize(
              'aiKnowledge.remove.detail',
              'Referenced by: {providers}. Those models keep working but lose their metadata (name, token limits, capabilities).',
              { providers: refs.map((r) => r.providerId).join(', ') },
            )
      const { confirmed } = await dialog.confirm({
        message: isOverride
          ? localize('aiKnowledge.reset.confirm', 'Reset {key} to the built-in definition?', {
              key,
            })
          : localize('aiKnowledge.remove.confirm', 'Remove model {key}?', { key }),
        ...(detail !== undefined ? { detail } : {}),
        primaryButton: isOverride
          ? localize('aiKnowledge.reset.action', 'Reset')
          : localize('aiKnowledge.remove.action', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await enqueueWrite(async () => {
        const next = { ...knowledgeRef.current }
        delete next[key]
        await updateKnowledge(next)
      })
    },
    [dialog, enqueueWrite, updateKnowledge],
  )

  /**
   * A rename moves the knowledge key and every provider reference that can follow
   * it. Only an explicit `ref` can — a bare string or a bare `id` *is* the wire
   * name the endpoint expects, so rewriting it would rename the model on the wire
   * and break the call. Those references are named in the confirmation instead,
   * because they become knowledge-less (a non-fatal, pre-existing state).
   *
   * Both halves go to disk in ONE write: two sequential writes can fail in
   * between and leave refs pointing at a key that no longer exists.
   */
  const renameKnowledge = useCallback(
    async (key: string) => {
      const nextKey = (
        await dialog.prompt({
          title: localize('aiKnowledge.rename.title', 'Rename model key'),
          initialValue: key,
        })
      )?.trim()
      if (nextKey === undefined || nextKey === '' || nextKey === key) return
      if (!isValidKnowledgeKey(nextKey)) {
        await dialog.confirm({
          message: localize('aiKnowledge.rename.invalid', "A model key must not contain '/'."),
          type: 'error',
        })
        return
      }
      if (knowledgeRef.current[nextKey] !== undefined) {
        await dialog.confirm({
          message: localize('aiKnowledge.rename.exists', 'A model named {key} already exists.', {
            key: nextKey,
          }),
          type: 'error',
        })
        return
      }
      // A built-in key is taken too: renaming onto one would silently turn this
      // entry into an override of an unrelated model, inheriting every field it
      // does not set. Same rule the duplicate and add paths already follow.
      if (BUILTIN_MODEL_KNOWLEDGE[nextKey] !== undefined) {
        await dialog.confirm({
          message: localize(
            'aiKnowledge.rename.builtinExists',
            '{key} is a built-in model. Renaming onto it would turn this entry into an override of that model — use Override in the Built-in Models section instead.',
            { key: nextKey },
          ),
          type: 'error',
        })
        return
      }

      const refs = referencingProviders(providersRef.current, key)
      if (refs.length > 0) {
        const rewritable = refs.filter((r) => r.explicit).map((r) => r.providerId)
        const bare = refs.filter((r) => r.bare).map((r) => r.providerId)
        const parts: string[] = []
        if (rewritable.length > 0) {
          parts.push(
            localize('aiKnowledge.rename.rewritable', 'Updated automatically: {providers}.', {
              providers: rewritable.join(', '),
            }),
          )
        }
        if (bare.length > 0) {
          parts.push(
            localize(
              'aiKnowledge.rename.bare',
              'Cannot be updated: {providers} — they reference the model by its wire name, which renaming must not change. Those models lose their metadata.',
              { providers: bare.join(', ') },
            ),
          )
        }
        const { confirmed } = await dialog.confirm({
          message: localize('aiKnowledge.rename.confirm', 'Rename {from} to {to}?', {
            from: key,
            to: nextKey,
          }),
          detail: parts.join('\n'),
          primaryButton: localize('aiKnowledge.rename.action', 'Rename'),
          type: 'warning',
        })
        if (!confirmed) return
      }

      await enqueueWrite(async () => {
        const current = knowledgeRef.current
        if (current[key] === undefined) return
        const nextKnowledge: Record<string, AiModelKnowledge> = {}
        // Rebuild in order so the renamed entry keeps its position in the file
        // instead of jumping to the end on every rename.
        for (const [k, v] of Object.entries(current)) nextKnowledge[k === key ? nextKey : k] = v

        const rewrite = rewriteRefsForRename(providersRef.current, key, nextKey)
        console.debug('aiKnowledge: rename model', {
          from: key,
          to: nextKey,
          explicitRefs: rewrite.explicitRefCount,
          bareRefs: rewrite.bareRefCount,
        })

        knowledgeRef.current = nextKnowledge
        providersRef.current = rewrite.providers
        writeSeqRef.current++
        await aiModel.updateModelKnowledgeAndProviders(nextKnowledge, rewrite.providers)
        await reload()
      })
    },
    [aiModel, dialog, enqueueWrite, reload],
  )

  /**
   * The flush exists because a field commit can still be queued when the file is
   * about to be shown; it must never fire while editing is locked, or the legacy
   * banner's own button would rewrite the file we promised to leave alone.
   */
  const openJson = useCallback(async () => {
    if (!legacy && load === 'ready') {
      await enqueueWrite(() => aiModel.updateModelKnowledge(knowledgeRef.current))
    }
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, uri)
    void openInLockAwareGroup(editorGroups, input, { activate: true })
  }, [aiModel, editorGroups, enqueueWrite, instantiation, legacy, load, userData])

  const userKeys = useMemo(() => Object.keys(userKnowledge), [userKnowledge])

  const usedByKey = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const provider of providers) {
      for (const refs of Object.values(provider.protocolMap ?? {})) {
        if (refs === undefined) continue
        for (const ref of refs) {
          const key = refKnowledgeKey(ref)
          if (key === '') continue
          const list = map.get(key) ?? []
          if (!list.includes(provider.id)) list.push(provider.id)
          map.set(key, list)
        }
      }
    }
    return map
  }, [providers])

  const builtinKeys = useMemo(() => Object.keys(BUILTIN_MODEL_KNOWLEDGE).sort(), [])
  const availableBuiltinKeys = useMemo(
    () => builtinKeys.filter((key) => userKnowledge[key] === undefined),
    [builtinKeys, userKnowledge],
  )

  /**
   * Nothing may be edited until the user layer has actually been read: every write
   * replaces the whole map, so a write built on the empty placeholder would wipe
   * the user's `models`. Same gate as the write-time guard in `enqueueWrite`.
   */
  const canEdit = !legacy && load === 'ready'

  return (
    <div className={styles['panel']}>
      <div className={styles['panelToolbar']}>
        <Button disabled={!canEdit} onClick={() => setAddOpen(true)}>
          <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
          {localize('aiKnowledge.addModel', 'Add Model')}
        </Button>
        <Button variant="ghost" onClick={() => void openJson()}>
          <FileJson size={14} strokeWidth={1.75} className={styles['btnIcon']} />
          {localize('aiSettings.openJson', 'Open aiSettings.json')}
        </Button>
      </div>

      {legacy && (
        <div className={styles['legacyBanner']} data-testid="ai-knowledge-legacy-banner">
          <TriangleAlert size={16} strokeWidth={1.75} className={styles['cardIcon']} />
          <span className={styles['spacer']}>
            {localize(
              'aiKnowledge.legacy.banner',
              'aiSettings.json is still in the retired two-layer format and has been ignored, so model knowledge cannot be edited here. Rebuild the file in the new format first.',
            )}
          </span>
          <Button variant="ghost" onClick={() => void openJson()}>
            {localize('aiSettings.openJson', 'Open aiSettings.json')}
          </Button>
        </div>
      )}

      <PanelSection
        title={localize('aiKnowledge.section.custom', 'Your Models')}
        collapsed={collapsed[SECTION_CUSTOM] ?? false}
        onToggle={() => toggleCollapsed(SECTION_CUSTOM, false)}
      >
        {load === 'loading' ? (
          <div className={styles['emptyState']} data-testid="ai-knowledge-loading">
            <Spinner size={20} />
            <div className={styles['emptyDesc']}>
              {localize('aiKnowledge.loading', 'Loading model knowledge…')}
            </div>
          </div>
        ) : load === 'failed' ? (
          <div className={styles['emptyState']} data-testid="ai-knowledge-load-failed">
            <div className={styles['emptyDesc']}>
              {localize(
                'aiKnowledge.loadFailed',
                'Model knowledge could not be read, so editing is locked to avoid overwriting it. Check the log and reopen the settings editor.',
              )}
            </div>
          </div>
        ) : userKeys.length === 0 ? (
          <div className={styles['emptyState']} data-testid="ai-knowledge-empty">
            <div className={styles['emptyDesc']}>
              {localize(
                'aiKnowledge.empty',
                'No model definitions of your own yet. Add one for a model the built-in catalog does not know, or override a built-in model below.',
              )}
            </div>
            <Button disabled={!canEdit} onClick={() => setAddOpen(true)}>
              <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
              {localize('aiKnowledge.addModel', 'Add Model')}
            </Button>
          </div>
        ) : (
          <div className={styles['cards']}>
            {userKeys.map((key) => (
              <ModelKnowledgeCard
                key={key}
                modelKey={key}
                own={userKnowledge[key] ?? {}}
                builtin={BUILTIN_MODEL_KNOWLEDGE[key]}
                usedBy={usedByKey.get(key) ?? []}
                disabled={!canEdit}
                collapsed={collapsed[modelCollapseKey(key)] ?? false}
                onToggleCollapsed={() => toggleCollapsed(modelCollapseKey(key), false)}
                updateEntry={(build) => replaceKnowledgeAt(key, build)}
                onRename={() => void renameKnowledge(key)}
                onDuplicate={() => void duplicateKnowledge(key)}
                onRemove={() => void removeKnowledge(key)}
              />
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title={localize('aiKnowledge.section.builtin', 'Built-in Models')}
        collapsed={collapsed[SECTION_BUILTIN] ?? true}
        onToggle={() => toggleCollapsed(SECTION_BUILTIN, true)}
      >
        <span className={styles['ratesLine']}>
          {localize(
            'aiKnowledge.section.builtin.note',
            'Shipped with the editor and kept up to date by it. Override one to change a field; everything you do not set keeps following the built-in definition.',
          )}
        </span>
        <ul className={styles['modelList']}>
          {availableBuiltinKeys.map((key) => (
            <BuiltinRow
              key={key}
              modelKey={key}
              knowledge={BUILTIN_MODEL_KNOWLEDGE[key] ?? {}}
              usedBy={usedByKey.get(key) ?? []}
              disabled={!canEdit}
              onOverride={() => void addKnowledge(key)}
            />
          ))}
          {availableBuiltinKeys.length === 0 && (
            <li className={styles['noModels']}>
              {localize(
                'aiKnowledge.section.builtin.allOverridden',
                'Every built-in model already has an override above.',
              )}
            </li>
          )}
        </ul>
      </PanelSection>

      {addOpen && (
        <AddModelDialog
          existingKeys={userKeys}
          builtinKeys={builtinKeys}
          onClose={() => setAddOpen(false)}
          onCreate={(key) => {
            setAddOpen(false)
            void addKnowledge(key)
          }}
        />
      )}
    </div>
  )
}

/** A built-in entry as it ships: read-only, with the one action that makes it editable. */
function BuiltinRow({
  modelKey,
  knowledge,
  usedBy,
  disabled,
  onOverride,
}: {
  readonly modelKey: string
  readonly knowledge: AiModelKnowledge
  readonly usedBy: readonly string[]
  readonly disabled: boolean
  readonly onOverride: () => void
}) {
  return (
    <li
      className={styles['modelRow']}
      data-testid="ai-knowledge-builtin-row"
      data-model-key={modelKey}
    >
      <div className={styles['modelMain']}>
        <span className={styles['modelName']}>{knowledge.name ?? modelKey}</span>
        <span className={styles['modelFamily']}>{modelKey}</span>
        <div className={styles['cardBadges']}>
          {knowledge.vendor !== undefined && <Badge>{knowledge.vendor}</Badge>}
          {knowledge.maxInputTokens !== undefined && (
            <Badge>
              {localize('aiKnowledge.builtin.contextBadge', '{count} in', {
                count: knowledge.maxInputTokens,
              })}
            </Badge>
          )}
          {usedBy.length > 0 && (
            <Badge>
              <span data-tooltip={usedBy.join(', ')}>
                {localize('aiKnowledge.badge.usedBy', 'Used by {count} providers', {
                  count: usedBy.length,
                })}
              </span>
            </Badge>
          )}
        </div>
        <span className={styles['spacer']} />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onOverride}>
          {localize('aiKnowledge.builtin.override', 'Override')}
        </Button>
      </div>
    </li>
  )
}
