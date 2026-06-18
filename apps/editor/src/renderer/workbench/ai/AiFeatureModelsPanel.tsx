/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiFeatureModelsPanel — the "Feature models" category of the AI settings editor.
 *  Lists each AI feature (chat / inline completion / commit message) with the
 *  model it currently uses. Clicking a row runs that feature's existing pick
 *  command, so the picking experience matches the status-bar model picker.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { Bot, GitCommitHorizontal, WandSparkles, type LucideIcon } from 'lucide-react'
import {
  IAiModelService,
  ICommandService,
  localize,
  type AiModelMetadata,
} from '@universe-editor/platform'
import { Badge } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import styles from './AiSettingsEditor.module.css'

interface FeatureDef {
  readonly id: string
  readonly icon: LucideIcon
  readonly label: string
  readonly description: string
  readonly command: string
  readonly read: (ai: IAiModelService) => Promise<string | undefined>
}

const FEATURES: readonly FeatureDef[] = [
  {
    id: 'chat',
    icon: Bot,
    label: localize('aiFeatures.chat', 'Chat'),
    description: localize(
      'aiFeatures.chat.desc',
      'Model used by AGENTS sessions and chat completions.',
    ),
    command: 'ai.pickModel',
    read: (ai) => ai.getActiveModelId(),
  },
  {
    id: 'inline',
    icon: WandSparkles,
    label: localize('aiFeatures.inline', 'Inline Completion'),
    description: localize(
      'aiFeatures.inline.desc',
      'Model used for editor ghost-text suggestions (may be smaller / faster).',
    ),
    command: 'ai.inlineCompletion.pickModel',
    read: (ai) => ai.getInlineCompletionModelId(),
  },
  {
    id: 'commit',
    icon: GitCommitHorizontal,
    label: localize('aiFeatures.commit', 'Commit Message'),
    description: localize('aiFeatures.commit.desc', 'Model used to generate Git commit messages.'),
    command: 'ai.commitMessage.pickModel',
    read: (ai) => ai.getCommitModelId(),
  },
]

function findModel(
  models: readonly AiModelMetadata[],
  id: string | undefined,
): AiModelMetadata | undefined {
  if (!id) return undefined
  return models.find((m) => m.id === id)
}

export function AiFeatureModelsPanel() {
  const aiModel = useService(IAiModelService)
  const commands = useService(ICommandService)

  const [models, setModels] = useState<readonly AiModelMetadata[]>([])
  const [selected, setSelected] = useState<Readonly<Record<string, string | undefined>>>({})

  const reload = useCallback(async () => {
    const [allModels, ...ids] = await Promise.all([
      aiModel.getModels(),
      ...FEATURES.map((f) => f.read(aiModel)),
    ])
    const next: Record<string, string | undefined> = {}
    FEATURES.forEach((f, i) => {
      next[f.id] = ids[i]
    })
    setModels(allModels)
    setSelected(next)
  }, [aiModel])

  useEffect(() => {
    void reload()
    const disposables = [
      aiModel.onDidChangeModels(() => void reload()),
      aiModel.onDidChangeActiveModel(() => void reload()),
      aiModel.onDidChangeInlineCompletionModel(() => void reload()),
      aiModel.onDidChangeCommitModel(() => void reload()),
    ]
    return () => disposables.forEach((d) => d.dispose())
  }, [aiModel, reload])

  const pick = useCallback(
    async (command: string) => {
      await commands.executeCommand(command)
      await reload()
    },
    [commands, reload],
  )

  return (
    <div className={styles['panel']}>
      <ul className={styles['featureList']}>
        {FEATURES.map((feature) => {
          const model = findModel(models, selected[feature.id])
          const Icon = feature.icon
          const source = model ? `${model.vendor}/${model.groupName ?? 'default'}` : undefined
          return (
            <li key={feature.id}>
              <button
                type="button"
                className={styles['featureRow']}
                onClick={() => void pick(feature.command)}
              >
                <Icon size={18} strokeWidth={1.75} className={styles['featureIcon']} />
                <div className={styles['featureMeta']}>
                  <span className={styles['featureName']}>{feature.label}</span>
                  <span className={styles['featureDesc']}>{feature.description}</span>
                </div>
                <div className={styles['featureValue']}>
                  {model ? (
                    <>
                      <span className={styles['featureModelName']}>{model.name}</span>
                      {source && <Badge>{source}</Badge>}
                    </>
                  ) : (
                    <span className={styles['featureUnset']}>
                      {localize('aiFeatures.unset', 'Not set')}
                    </span>
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
