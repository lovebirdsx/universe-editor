/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiFeatureModelsPanel — the "Feature models" category of the AI settings editor.
 *  Lists each AI feature (chat / inline completion / commit message) with the
 *  model it currently uses. Clicking a row runs that feature's existing pick
 *  command, so the picking experience matches the status-bar model picker.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, GitCommitHorizontal, Heading, WandSparkles, type LucideIcon } from 'lucide-react'
import {
  bareModelName,
  IAiModelService,
  ICommandService,
  localize,
  parseModelRef,
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
  {
    id: 'sessionTitle',
    icon: Heading,
    label: localize('aiFeatures.sessionTitle', 'Session Title'),
    description: localize(
      'aiFeatures.sessionTitle.desc',
      'Model used to generate friendly titles for AGENTS sessions.',
    ),
    command: 'ai.sessionTitle.pickModel',
    read: (ai) => ai.getSessionTitleModelId(),
  },
]

function findModel(
  models: readonly AiModelMetadata[],
  id: string | undefined,
): AiModelMetadata | undefined {
  if (!id) return undefined
  return models.find((m) => m.id === id)
}

/**
 * What a feature row shows on the right. Only a genuinely empty slot is "unset":
 * `activeModels.<slot>` holding an id we can't resolve yet (enumeration still in
 * flight) or can't resolve at all (offline gateway, deleted model) is still a
 * configuration, so the id is decomposed back into its wire name rather than
 * reported as missing.
 */
type FeatureValue =
  | { readonly kind: 'unset' }
  | {
      readonly kind: 'resolved' | 'pending' | 'unavailable'
      readonly name: string
      readonly providerId: string | undefined
    }

function resolveFeatureValue(
  id: string | undefined,
  models: readonly AiModelMetadata[],
  modelsLoading: boolean,
): FeatureValue {
  if (!id) return { kind: 'unset' }
  const model = findModel(models, id)
  if (model) return { kind: 'resolved', name: model.name, providerId: model.providerId }
  const ref = parseModelRef(id)
  return {
    kind: modelsLoading ? 'pending' : 'unavailable',
    name: ref ? bareModelName(id, ref.providerId, ref.protocol) : id,
    providerId: ref?.providerId,
  }
}

export function AiFeatureModelsPanel() {
  const aiModel = useService(IAiModelService)
  const commands = useService(ICommandService)

  const [models, setModels] = useState<readonly AiModelMetadata[]>([])
  const [selected, setSelected] = useState<Readonly<Record<string, string | undefined>>>({})
  /**
   * True while a model enumeration is in flight. Rows use it to tell "we don't
   * know this model's name yet" apart from "this model is gone" — a hung
   * /v1/models can hold it for the full request timeout.
   */
  const [modelsLoading, setModelsLoading] = useState(true)

  /** Monotonic guard so a stale enumeration can never paint over a newer one. */
  const modelsTokenRef = useRef(0)
  /** Set on unmount; async reload continuations skip setState once it flips. */
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      modelsTokenRef.current++
    }
  }, [])

  /**
   * The four active-model reads are main-memory lookups; `getModels` is a network
   * enumeration that can block for METADATA_REQUEST_TIMEOUT_MS against an
   * unreachable endpoint. Binding them into one `Promise.all` is what made every
   * configured row read "Not set" until the enumeration settled, so the fast
   * reads land on their own and the enumeration only upgrades the names.
   */
  const reload = useCallback(async () => {
    try {
      const ids = await Promise.all(FEATURES.map((f) => f.read(aiModel)))
      if (disposedRef.current) return
      const next: Record<string, string | undefined> = {}
      FEATURES.forEach((f, i) => {
        next[f.id] = ids[i]
      })
      setSelected(next)
    } catch (error) {
      console.debug('aiFeatureModels: active model reads failed', error)
    }

    const token = ++modelsTokenRef.current
    setModelsLoading(true)
    void aiModel
      .getModels()
      .then((nextModels) => {
        if (disposedRef.current || token !== modelsTokenRef.current) return
        setModels(nextModels)
        setModelsLoading(false)
      })
      .catch((error) => {
        console.debug('aiFeatureModels: model enumeration failed', error)
        // A stale answer must not clear the flag: a newer enumeration is in flight.
        if (!disposedRef.current && token === modelsTokenRef.current) setModelsLoading(false)
      })
  }, [aiModel])

  useEffect(() => {
    void reload()
    const disposables = [
      aiModel.onDidChangeModels(() => void reload()),
      aiModel.onDidChangeActiveModel(() => void reload()),
      aiModel.onDidChangeInlineCompletionModel(() => void reload()),
      aiModel.onDidChangeCommitModel(() => void reload()),
      aiModel.onDidChangeSessionTitleModel(() => void reload()),
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
          const value = resolveFeatureValue(selected[feature.id], models, modelsLoading)
          const Icon = feature.icon
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
                  {value.kind === 'unset' ? (
                    <span className={styles['featureUnset']}>
                      {localize('aiFeatures.unset', 'Not set')}
                    </span>
                  ) : (
                    <>
                      <span className={styles['featureModelName']}>{value.name}</span>
                      {value.providerId !== undefined && <Badge>{value.providerId}</Badge>}
                      {value.kind === 'unavailable' && (
                        <span className={styles['featureUnavailable']}>
                          {localize('aiFeatures.unavailable', 'Unavailable')}
                        </span>
                      )}
                    </>
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
