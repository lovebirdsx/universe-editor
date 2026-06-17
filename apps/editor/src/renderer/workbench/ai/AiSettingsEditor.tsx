/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Graphical AI model manager (mirrors VSCode's "Manage Language Models" widget).
 *  Reads provider groups + resolved models live from IAiModelService; edits to
 *  groups / baseUrl / custom models are written back through updateGroups, while
 *  API keys go through the secret-backed setApiKey / clearApiKey path (never into
 *  aiSettings.json). Per-model parameters are edited from each model's
 *  configurationSchema and persisted via setModelConfiguration.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState, type JSX } from 'react'
import {
  bareModelName,
  groupKey,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUserDataFilesService,
  Severity,
  URI,
  UserDataFile,
  localize,
  type AiCustomModelConfig,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiProviderGroup,
} from '@universe-editor/platform'
import { Button, Input } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import styles from './AiSettingsEditor.module.css'

interface GroupState {
  readonly group: AiProviderGroup
  readonly hasApiKey: boolean
  readonly models: readonly AiModelMetadata[]
}

export function AiSettingsEditor() {
  const aiModel = useService(IAiModelService)
  const quickInput = useService(IQuickInputService)
  const dialog = useService(IDialogService)
  const notifications = useService(INotificationService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)

  const [groupStates, setGroupStates] = useState<readonly GroupState[]>([])
  const [activeModelId, setActiveModelId] = useState<string | undefined>(undefined)

  const reload = useCallback(async () => {
    const [groups, models, active] = await Promise.all([
      aiModel.getGroups(),
      aiModel.getModels(),
      aiModel.getActiveModelId(),
    ])
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
    setActiveModelId(active)
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

  const addGroup = useCallback(async () => {
    const vendor = await quickInput.input({
      prompt: localize('aiModels.addGroup.vendor', 'Vendor (e.g. openai, ollama)'),
      placeholder: 'openai',
      validateInput: (v) =>
        v.trim().length === 0
          ? localize('aiModels.addGroup.vendorEmpty', 'Vendor must not be empty.')
          : undefined,
    })
    const trimmedVendor = vendor?.trim()
    if (!trimmedVendor) return
    const name = await quickInput.input({
      prompt: localize('aiModels.addGroup.name', 'Group name'),
      value: 'default',
      validateInput: (v) =>
        v.includes('/')
          ? localize('aiModels.addGroup.nameSlash', "Group name must not contain '/'.")
          : v.trim().length === 0
            ? localize('aiModels.addGroup.nameEmpty', 'Group name must not be empty.')
            : undefined,
    })
    const trimmedName = name?.trim()
    if (!trimmedName) return
    if (groupStates.some((s) => s.group.vendor === trimmedVendor && s.group.name === trimmedName)) {
      notifications.notify({
        severity: Severity.Warning,
        message: localize('aiModels.addGroup.exists', 'That provider group already exists.'),
      })
      return
    }
    await writeGroups([
      ...groupStates.map((s) => s.group),
      { vendor: trimmedVendor, name: trimmedName },
    ])
  }, [groupStates, notifications, quickInput, writeGroups])

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

  const setActive = useCallback(
    async (modelId: string) => {
      await aiModel.setActiveModelId(modelId)
      setActiveModelId(modelId)
    },
    [aiModel],
  )

  const openJson = useCallback(async () => {
    await aiModel.updateGroups(await aiModel.getGroups())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, URI.revive(uri) as URI)
    void editorGroups.activeGroup.openEditor(input, { activate: true })
  }, [aiModel, editorGroups, instantiation, userData])

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <h1 className={styles['title']}>{localize('aiModels.title', 'AI Models')}</h1>
        <div className={styles['headerActions']}>
          <Button onClick={() => void addGroup()}>
            {localize('aiModels.addGroup', 'Add Provider Group')}
          </Button>
          <Button variant="ghost" onClick={() => void openJson()}>
            {localize('aiSettings.openJson', 'Open aiSettings.json')}
          </Button>
        </div>
      </div>

      <div className={styles['body']}>
        {groupStates.length === 0 ? (
          <div className={styles['empty']}>
            {localize('aiModels.empty', 'No provider groups configured.')}
          </div>
        ) : (
          groupStates.map((state, index) => (
            <GroupCard
              key={groupKey(state.group)}
              state={state}
              activeModelId={activeModelId}
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
              onSetActive={(modelId) => void setActive(modelId)}
              onConfigure={(modelId, config) =>
                aiModel.setModelConfiguration(modelId, config).then(() => reload())
              }
              getConfiguration={(modelId) => aiModel.getModelConfiguration(modelId)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface GroupCardProps {
  readonly state: GroupState
  readonly activeModelId: string | undefined
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onSetApiKey: () => void
  readonly onClearApiKey: () => void
  readonly onRemoveGroup: () => void
  readonly onAddModel: () => void
  readonly onRemoveModel: (modelId: string) => void
  readonly onSetActive: (modelId: string) => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function GroupCard({
  state,
  activeModelId,
  onBaseUrlChange,
  onSetApiKey,
  onClearApiKey,
  onRemoveGroup,
  onAddModel,
  onRemoveModel,
  onSetActive,
  onConfigure,
  getConfiguration,
}: GroupCardProps) {
  const { group, hasApiKey, models } = state
  const [baseUrl, setBaseUrl] = useState(group.baseUrl ?? '')
  const declaredIds = new Set((group.models ?? []).map((m) => m.id))

  useEffect(() => setBaseUrl(group.baseUrl ?? ''), [group.baseUrl])

  return (
    <section className={styles['card']}>
      <div className={styles['cardHeader']}>
        <span className={styles['cardTitle']}>{groupKey(group)}</span>
        <Button variant="ghost" size="sm" onClick={onRemoveGroup}>
          {localize('aiModels.removeGroup', 'Remove')}
        </Button>
      </div>

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
          <Button size="sm" onClick={onSetApiKey}>
            {localize('aiModels.apiKey.setBtn', 'Set')}
          </Button>
          <Button size="sm" variant="ghost" disabled={!hasApiKey} onClick={onClearApiKey}>
            {localize('aiModels.apiKey.clearBtn', 'Clear')}
          </Button>
        </div>
      </div>

      <div className={styles['modelsHeader']}>
        <span className={styles['label']}>{localize('aiModels.models', 'Models')}</span>
        <Button size="sm" variant="ghost" onClick={onAddModel}>
          {localize('aiModels.addModel', 'Add Model')}
        </Button>
      </div>

      {models.length === 0 ? (
        <div className={styles['noModels']}>
          {localize('aiModels.noModels', 'No models available (configure baseUrl / API key).')}
        </div>
      ) : (
        <ul className={styles['modelList']}>
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              active={model.id === activeModelId}
              declared={declaredIds.has(bareModelName(model.id, group.vendor, group.name))}
              onSetActive={() => onSetActive(model.id)}
              onRemove={() => onRemoveModel(model.id)}
              onConfigure={onConfigure}
              getConfiguration={getConfiguration}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

interface ModelRowProps {
  readonly model: AiModelMetadata
  readonly active: boolean
  readonly declared: boolean
  readonly onSetActive: () => void
  readonly onRemove: () => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function ModelRow({
  model,
  active,
  declared,
  onSetActive,
  onRemove,
  onConfigure,
  getConfiguration,
}: ModelRowProps) {
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
        <span className={styles['modelName']}>{model.name}</span>
        <span className={styles['modelFamily']}>{model.family}</span>
        {active && (
          <span className={styles['activeBadge']}>{localize('aiModels.active', 'Active')}</span>
        )}
        <span className={styles['spacer']} />
        <Button size="sm" variant="ghost" disabled={active} onClick={onSetActive}>
          {localize('aiModels.setActive', 'Set Active')}
        </Button>
        {hasSchema && (
          <Button size="sm" variant="ghost" onClick={() => void toggleConfigure()}>
            {localize('aiModels.configure', 'Configure')}
          </Button>
        )}
        {declared && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            {localize('aiModels.removeModel', 'Remove')}
          </Button>
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
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
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
