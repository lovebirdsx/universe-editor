/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiModelsPanel — the "Model configuration" category of the AI settings editor.
 *  Manages provider groups (baseUrl / API key / declared models) and per-model
 *  parameters. Reads everything live from IAiModelService; group / baseUrl /
 *  custom-model edits go through updateGroups, API keys through the secret-backed
 *  setApiKey / clearApiKey path (never into aiSettings.json), and per-model
 *  parameters through setModelConfiguration.
 *
 *  Per-group collapse state and the per-card model filter are persisted (GLOBAL
 *  scope) so the page reopens exactly as the user left it.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileJson,
  KeyRound,
  Plus,
  Server,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import {
  bareModelName,
  groupKey,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IStorageService,
  IUserDataFilesService,
  Severity,
  StorageScope,
  URI,
  UserDataFile,
  localize,
  type AiCustomModelConfig,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiProviderGroup,
} from '@universe-editor/platform'
import { Badge, Button, Checkbox, IconButton, Input } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { AddProviderDialog } from './AddProviderDialog.js'
import styles from './AiSettingsEditor.module.css'

interface GroupState {
  readonly group: AiProviderGroup
  readonly hasApiKey: boolean
  readonly models: readonly AiModelMetadata[]
}

const COLLAPSED_KEY = 'ai.settings.models.collapsed'
const filterKey = (key: string): string => `ai.settings.models.filter.${key}`

export function AiModelsPanel() {
  const aiModel = useService(IAiModelService)
  const quickInput = useService(IQuickInputService)
  const dialog = useService(IDialogService)
  const notifications = useService(INotificationService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const storage = useService(IStorageService)

  const [groupStates, setGroupStates] = useState<readonly GroupState[]>([])
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({})
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    let active = true
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored) setCollapsed(stored)
    })
    return () => {
      active = false
    }
  }, [storage])

  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = { ...prev, [key]: !prev[key] }
        void storage.set(COLLAPSED_KEY, next, StorageScope.GLOBAL)
        return next
      })
    },
    [storage],
  )

  const reload = useCallback(async () => {
    const [groups, models] = await Promise.all([aiModel.getGroups(), aiModel.getModels()])
    const states = await Promise.all(
      groups.map(async (group): Promise<GroupState> => {
        const hasApiKey = await aiModel.hasApiKey(group.vendor, group.name)
        const groupModels = models.filter(
          (m) => m.vendor === group.vendor && (m.groupName ?? 'default') === group.name,
        )
        return { group, hasApiKey, models: groupModels }
      }),
    )
    setGroupStates(states)
  }, [aiModel])

  useEffect(() => {
    void reload()
    const d = aiModel.onDidChangeModels(() => void reload())
    return () => d.dispose()
  }, [aiModel, reload])

  const writeGroups = useCallback(
    async (next: readonly AiProviderGroup[]) => {
      await aiModel.updateGroups(next)
      await reload()
    },
    [aiModel, reload],
  )

  const replaceGroup = useCallback(
    async (index: number, build: (group: AiProviderGroup) => AiProviderGroup) => {
      const next = groupStates.map((s, i) => (i === index ? build(s.group) : s.group))
      await writeGroups(next)
    },
    [groupStates, writeGroups],
  )

  const addGroup = useCallback(() => setAddOpen(true), [])

  const removeGroup = useCallback(
    async (index: number) => {
      const target = groupStates[index]
      if (!target) return
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.removeGroup.confirm', 'Remove provider group {group}?', {
          group: groupKey(target.group),
        }),
        primaryButton: localize('aiModels.removeGroup.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      if (target.hasApiKey) await aiModel.deleteApiKey(target.group.vendor, target.group.name)
      await writeGroups(groupStates.filter((_, i) => i !== index).map((s) => s.group))
    },
    [aiModel, dialog, groupStates, writeGroups],
  )

  const setApiKey = useCallback(
    async (group: AiProviderGroup) => {
      const key = await quickInput.input({
        prompt: localize(
          'aiModels.setApiKey.prompt',
          'Enter the API key for {group} (stored encrypted; never written to aiSettings.json).',
          { group: groupKey(group) },
        ),
        placeholder: 'sk-…',
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.setApiKey.empty', 'The API key must not be empty.')
            : undefined,
      })
      const trimmed = key?.trim()
      if (!trimmed) return
      await aiModel.setApiKey(group.vendor, group.name, trimmed)
      await reload()
      notifications.notify({
        severity: Severity.Info,
        message: localize('aiModels.setApiKey.done', 'API key saved for {group}.', {
          group: groupKey(group),
        }),
      })
    },
    [aiModel, notifications, quickInput, reload],
  )

  const clearApiKey = useCallback(
    async (group: AiProviderGroup) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.clearApiKey.confirm', 'Clear the stored API key for {group}?', {
          group: groupKey(group),
        }),
        primaryButton: localize('aiModels.clearApiKey.clear', 'Clear'),
        type: 'warning',
      })
      if (!confirmed) return
      await aiModel.deleteApiKey(group.vendor, group.name)
      await reload()
    },
    [aiModel, dialog, reload],
  )

  const addCustomModel = useCallback(
    async (index: number) => {
      const target = groupStates[index]
      if (!target) return
      const id = await quickInput.input({
        prompt: localize(
          'aiModels.addModel.id',
          'Model id the endpoint expects (e.g. qwen3-coder)',
        ),
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.addModel.idEmpty', 'Model id must not be empty.')
            : undefined,
      })
      const trimmedId = id?.trim()
      if (!trimmedId) return
      const existing = target.group.models ?? []
      if (existing.some((m) => m.id === trimmedId)) {
        notifications.notify({
          severity: Severity.Warning,
          message: localize('aiModels.addModel.exists', 'That model is already declared.'),
        })
        return
      }
      await replaceGroup(index, (group) => ({ ...group, models: [...existing, { id: trimmedId }] }))
    },
    [groupStates, notifications, quickInput, replaceGroup],
  )

  const removeCustomModel = useCallback(
    async (index: number, modelId: string) => {
      const target = groupStates[index]
      if (!target) return
      const bare = bareModelName(modelId, target.group.vendor, target.group.name)
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.removeModel.confirm', 'Remove model {model}?', {
          model: modelId,
        }),
        primaryButton: localize('aiModels.removeModel.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await replaceGroup(index, (group) => {
        const models = (group.models ?? []).filter((m) => m.id !== bare)
        const next: {
          name: string
          vendor: string
          baseUrl?: string
          models?: readonly AiCustomModelConfig[]
          settings?: Readonly<Record<string, AiModelConfiguration>>
        } = { ...group }
        if (models.length > 0) next.models = models
        else delete next.models
        if (group.settings && modelId in group.settings) {
          const settings = { ...group.settings }
          delete settings[modelId]
          if (Object.keys(settings).length > 0) next.settings = settings
          else delete next.settings
        }
        return next
      })
    },
    [dialog, groupStates, replaceGroup],
  )

  const openJson = useCallback(async () => {
    await aiModel.updateGroups(await aiModel.getGroups())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, URI.revive(uri) as URI)
    void editorGroups.activeGroup.openEditor(input, { activate: true })
  }, [aiModel, editorGroups, instantiation, userData])

  return (
    <div className={styles['panel']}>
      <div className={styles['panelToolbar']}>
        <Button onClick={() => addGroup()}>
          <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
          {localize('aiModels.addGroup', 'Add Provider Group')}
        </Button>
        <Button variant="ghost" onClick={() => void openJson()}>
          <FileJson size={14} strokeWidth={1.75} className={styles['btnIcon']} />
          {localize('aiSettings.openJson', 'Open aiSettings.json')}
        </Button>
      </div>

      {groupStates.length === 0 ? (
        <div className={styles['emptyState']}>
          <Server size={40} strokeWidth={1.25} className={styles['emptyIcon']} />
          <div className={styles['emptyTitle']}>
            {localize('aiModels.empty.title', 'No provider groups yet')}
          </div>
          <div className={styles['emptyDesc']}>
            {localize(
              'aiModels.empty.desc',
              'Add a provider group to connect an AI service (OpenAI-compatible endpoint, Ollama, …).',
            )}
          </div>
          <Button onClick={() => addGroup()}>
            <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
            {localize('aiModels.addGroup', 'Add Provider Group')}
          </Button>
        </div>
      ) : (
        <div className={styles['cards']}>
          {groupStates.map((state, index) => {
            const key = groupKey(state.group)
            return (
              <GroupCard
                key={key}
                state={state}
                collapsed={collapsed[key] ?? false}
                onToggleCollapsed={() => toggleCollapsed(key)}
                storage={storage}
                onBaseUrlChange={(baseUrl) =>
                  void replaceGroup(index, (group) => {
                    const next: AiProviderGroup = { ...group }
                    if (baseUrl) return { ...next, baseUrl }
                    if ('baseUrl' in next) delete (next as { baseUrl?: string }).baseUrl
                    return next
                  })
                }
                onSetApiKey={() => void setApiKey(state.group)}
                onClearApiKey={() => void clearApiKey(state.group)}
                onRemoveGroup={() => void removeGroup(index)}
                onAddModel={() => void addCustomModel(index)}
                onRemoveModel={(modelId) => void removeCustomModel(index, modelId)}
                onConfigure={(modelId, config) =>
                  aiModel.setModelConfiguration(modelId, config).then(() => reload())
                }
                getConfiguration={(modelId) => aiModel.getModelConfiguration(modelId)}
              />
            )
          })}
        </div>
      )}

      {addOpen && (
        <AddProviderDialog
          existingGroups={groupStates.map((s) => s.group)}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false)
            void reload()
          }}
        />
      )}
    </div>
  )
}

interface GroupCardProps {
  readonly state: GroupState
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly storage: IStorageService
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onSetApiKey: () => void
  readonly onClearApiKey: () => void
  readonly onRemoveGroup: () => void
  readonly onAddModel: () => void
  readonly onRemoveModel: (modelId: string) => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function GroupCard({
  state,
  collapsed,
  onToggleCollapsed,
  storage,
  onBaseUrlChange,
  onSetApiKey,
  onClearApiKey,
  onRemoveGroup,
  onAddModel,
  onRemoveModel,
  onConfigure,
  getConfiguration,
}: GroupCardProps) {
  const { group, hasApiKey, models } = state
  const key = groupKey(group)
  const [baseUrl, setBaseUrl] = useState(group.baseUrl ?? '')
  const [filter, setFilter] = useState('')
  const declaredIds = useMemo(() => new Set((group.models ?? []).map((m) => m.id)), [group.models])

  useEffect(() => setBaseUrl(group.baseUrl ?? ''), [group.baseUrl])

  useEffect(() => {
    let active = true
    void storage.get<string>(filterKey(key), StorageScope.GLOBAL).then((stored) => {
      if (active && typeof stored === 'string') setFilter(stored)
    })
    return () => {
      active = false
    }
  }, [storage, key])

  const onFilterChange = useCallback(
    (value: string) => {
      setFilter(value)
      void storage.set(filterKey(key), value, StorageScope.GLOBAL)
    },
    [storage, key],
  )

  // Declared (user-added) models float to the top so they stay reachable in long
  // lists; the relative order within each partition is preserved.
  const orderedModels = useMemo(() => {
    const isDeclared = (m: AiModelMetadata) =>
      declaredIds.has(bareModelName(m.id, group.vendor, group.name))
    const declared = models.filter(isDeclared)
    const rest = models.filter((m) => !isDeclared(m))
    return [...declared, ...rest]
  }, [models, declaredIds, group.vendor, group.name])

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return orderedModels
    return orderedModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.family?.toLowerCase().includes(q) ?? false),
    )
  }, [orderedModels, filter])

  return (
    <section className={styles['card']}>
      <button
        type="button"
        className={styles['cardHeader']}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? (
          <ChevronRight size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        ) : (
          <ChevronDown size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        )}
        <Server size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        <span className={styles['cardTitle']}>{key}</span>
        <div className={styles['cardBadges']}>
          {hasApiKey && (
            <Badge tone="accent">
              <KeyRound size={11} strokeWidth={2} className={styles['badgeIcon']} />
              {localize('aiModels.badge.keyed', 'Key set')}
            </Badge>
          )}
          <Badge>
            {localize('aiModels.badge.modelCount', '{count} models', { count: models.length })}
          </Badge>
        </div>
        <span className={styles['spacer']} />
        <span
          className={styles['cardHeaderAction']}
          role="button"
          tabIndex={0}
          aria-label={localize('aiModels.removeGroup', 'Remove')}
          title={localize('aiModels.removeGroup', 'Remove provider group')}
          onClick={(e) => {
            e.stopPropagation()
            onRemoveGroup()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onRemoveGroup()
            }
          }}
        >
          <Trash2 size={15} strokeWidth={1.75} />
        </span>
      </button>

      {!collapsed && (
        <div className={styles['cardBody']}>
          <div className={styles['field']}>
            <label className={styles['label']}>{localize('aiModels.baseUrl', 'Base URL')}</label>
            <Input
              value={baseUrl}
              placeholder={localize('aiModels.baseUrl.placeholder', 'Provider default')}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl.trim() !== (group.baseUrl ?? '')) onBaseUrlChange(baseUrl.trim())
              }}
            />
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>{localize('aiModels.apiKey', 'API Key')}</label>
            <div className={styles['apiKeyRow']}>
              <span className={styles['apiKeyStatus']}>
                {hasApiKey
                  ? localize('aiModels.apiKey.set', 'Stored')
                  : localize('aiModels.apiKey.unset', 'Not set')}
              </span>
              <IconButton
                label={localize('aiModels.apiKey.setBtn', 'Set API key')}
                onClick={onSetApiKey}
              >
                <KeyRound size={15} strokeWidth={1.75} />
              </IconButton>
              <IconButton
                label={localize('aiModels.apiKey.clearBtn', 'Clear API key')}
                disabled={!hasApiKey}
                onClick={onClearApiKey}
              >
                <X size={15} strokeWidth={1.75} />
              </IconButton>
            </div>
          </div>

          <div className={styles['modelsHeader']}>
            <span className={styles['label']}>{localize('aiModels.models', 'Models')}</span>
            <IconButton label={localize('aiModels.addModel', 'Add model')} onClick={onAddModel}>
              <Plus size={15} strokeWidth={2} />
            </IconButton>
          </div>

          {models.length > 0 && (
            <Input
              className={styles['modelFilter']}
              value={filter}
              placeholder={localize('aiModels.filter.placeholder', 'Filter models…')}
              onChange={(e) => onFilterChange(e.target.value)}
            />
          )}

          {models.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.noModels', 'No models available (configure baseUrl / API key).')}
            </div>
          ) : filteredModels.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.noMatch', 'No models match the filter.')}
            </div>
          ) : (
            <ul className={styles['modelList']}>
              {filteredModels.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  declared={declaredIds.has(bareModelName(model.id, group.vendor, group.name))}
                  onRemove={() => onRemoveModel(model.id)}
                  onConfigure={onConfigure}
                  getConfiguration={getConfiguration}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

interface ModelRowProps {
  readonly model: AiModelMetadata
  readonly declared: boolean
  readonly onRemove: () => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function ModelRow({ model, declared, onRemove, onConfigure, getConfiguration }: ModelRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({})
  const hasSchema = model.configurationSchema && Object.keys(model.configurationSchema).length > 0

  const toggleConfigure = useCallback(async () => {
    if (!expanded) {
      const current = await getConfiguration(model.id)
      setDraft({ ...current })
    }
    setExpanded((v) => !v)
  }, [expanded, getConfiguration, model.id])

  return (
    <li className={styles['modelRow']}>
      <div className={styles['modelMain']}>
        {declared && (
          <Star
            size={13}
            strokeWidth={2}
            className={styles['declaredIcon']}
            aria-label={localize('aiModels.declared', 'Custom model')}
          />
        )}
        <span className={styles['modelName']}>{model.name}</span>
        <span className={styles['modelFamily']}>{model.family}</span>
        <span className={styles['spacer']} />
        {hasSchema && (
          <IconButton
            label={localize('aiModels.configure', 'Configure model')}
            active={expanded}
            onClick={() => void toggleConfigure()}
          >
            <Settings2 size={15} strokeWidth={1.75} />
          </IconButton>
        )}
        {declared && (
          <IconButton label={localize('aiModels.removeModel', 'Remove model')} onClick={onRemove}>
            <Trash2 size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {expanded && model.configurationSchema && (
        <div className={styles['configForm']}>
          {Object.entries(model.configurationSchema).map(([key, prop]) => {
            const value = draft[key]
            let control: JSX.Element
            if (prop.type === 'enum' && prop.enum) {
              control = (
                <select
                  className={styles['control']}
                  value={String(value ?? '')}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                >
                  <option value="">{localize('aiModels.config.unset', '(default)')}</option>
                  {prop.enum.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )
            } else if (prop.type === 'boolean') {
              control = (
                <Checkbox
                  checked={Boolean(value)}
                  onChange={(checked) => setDraft((d) => ({ ...d, [key]: checked }))}
                />
              )
            } else if (prop.type === 'number') {
              control = (
                <Input
                  type="number"
                  value={value === undefined ? '' : String(value)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    setDraft((d) => ({ ...d, [key]: Number.isNaN(n) ? '' : n }))
                  }}
                />
              )
            } else {
              control = (
                <Input
                  value={value === undefined ? '' : String(value)}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              )
            }
            return (
              <div key={key} className={styles['configRow']}>
                <div className={styles['configMeta']}>
                  <span className={styles['configKey']}>{key}</span>
                  {prop.description && (
                    <span className={styles['configDesc']}>{prop.description}</span>
                  )}
                </div>
                <div className={styles['configControl']}>{control}</div>
              </div>
            )
          })}
          <div className={styles['configActions']}>
            <Button
              size="sm"
              onClick={() => {
                const cleaned: Record<string, string | number | boolean> = {}
                for (const [k, v] of Object.entries(draft)) {
                  if (v !== '' && v !== undefined) cleaned[k] = v
                }
                void onConfigure(model.id, cleaned).then(() => setExpanded(false))
              }}
            >
              {localize('aiModels.config.save', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              {localize('aiModels.config.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
