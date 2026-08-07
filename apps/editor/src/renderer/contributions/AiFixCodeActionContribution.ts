/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiFixCodeActionContribution — "Fix with AI" on the marker hover, the vscode
 *  "Fix with Copilot" counterpart. Once Monaco is ready we register a
 *  catch-all CodeActionProvider that returns a single `isAI: true` quickfix
 *  whenever the hover carries markers; monaco 0.55 standalone renders that as
 *  the sparkle button for free. The action's command is registered on monaco's
 *  internal command registry (MonacoLoader does not override commandService),
 *  so the handler closes over constructor-injected services — no accessor.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IEditorGroupsService,
  IInstantiationService,
  ILayoutService,
  ILoggerService,
  IViewsService,
  IWorkspaceService,
  URI,
  localize,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../services/acp/session/acpChatLocationService.js'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpConfigOptionsCacheService } from '../services/acp/session/acpConfigOptionsCache.js'
import { toMentionName } from '../services/dnd/resourceDropTransfer.js'
import {
  composeAiFixPrompt,
  snapshotAiFixArg,
  type AiFixMarker,
  type AiFixModel,
  type AiFixProblemArg,
} from '../services/acp/aiFixPrompt.js'
import { buildAiFixConfigOverrides, readAiFixSettings } from '../services/acp/aiFixConfig.js'
import { revealChat, type RevealServices } from '../actions/_agentChatTarget.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'

export const AI_FIX_COMMAND_ID = 'universe.aiFixProblem'

export interface AiFixCodeAction<M = AiFixMarker> {
  readonly title: string
  readonly kind: 'quickfix'
  readonly isAI: true
  readonly diagnostics: M[]
  readonly command: {
    readonly id: string
    readonly title: string
    readonly arguments: [AiFixProblemArg]
  }
}

export interface AiFixCodeActionList<M = AiFixMarker> {
  readonly actions: AiFixCodeAction<M>[]
  dispose(): void
}

/**
 * The provider is unconditional (no agent-availability probe) to keep hovers
 * cheap; with no agent configured, session creation surfaces its usual error.
 * `relPathFor` maps a resource uri string to a workspace-relative display path.
 */
export function createAiFixCodeActionProvider<M extends AiFixMarker = AiFixMarker>(
  relPathFor: (resource: string) => string,
): {
  provideCodeActions(
    model: AiFixModel,
    range: unknown,
    context: { readonly markers: readonly M[] },
  ): AiFixCodeActionList<M>
} {
  return {
    provideCodeActions(model, _range, context) {
      if (context.markers.length === 0) {
        return { actions: [], dispose: () => {} }
      }
      const title = localize('action.agent.aiFixProblem', 'Fix with AI')
      const arg = snapshotAiFixArg(model, context.markers, relPathFor(model.uri.toString()))
      return {
        actions: [
          {
            title,
            kind: 'quickfix',
            isAI: true,
            diagnostics: [...context.markers],
            command: { id: AI_FIX_COMMAND_ID, title, arguments: [arg] },
          },
        ],
        dispose: () => {},
      }
    },
  }
}

/** Extra services executeAiFix needs beyond the reveal bag: the AI Fix
 *  settings reader and the per-agent configOptions cache used to resolve
 *  category-level settings (model/thinking depth) into wire configIds. */
export interface AiFixRunServices {
  readonly config: IConfigurationService
  readonly configOptionsCache: IAcpConfigOptionsCacheService
}

/** Send the composed prompt first, then reveal — the message is already on
 *  screen when the chat panel surfaces. */
export async function executeAiFix(
  reveal: RevealServices,
  run: AiFixRunServices,
  arg: AiFixProblemArg,
  logger: ILogger,
): Promise<void> {
  try {
    const settings = readAiFixSettings(run.config)
    let agentId = settings.agentId
    if (!reveal.registry.list().some((a) => a.id === agentId)) {
      logger.warn(`aiFix: unknown agentId "${agentId}", falling back to default agent`)
      agentId = reveal.registry.defaultAgentId()
    }
    const configDesiredOverrides = buildAiFixConfigOverrides(
      run.configOptionsCache.get(agentId),
      settings,
      (msg) => logger.warn(msg),
    )
    const relPath = arg.contexts[0]?.relPath ?? arg.resource
    const title = localize('acp.aiFix.sessionTitle', 'AI Fix: {path}', { path: relPath })
    const target = await reveal.sessions.createSession(agentId, {
      title,
      aiFix: true,
      configDesiredOverrides,
    })
    const { text, contexts } = composeAiFixPrompt(arg)
    logger.debug(
      `aiFix: sending ${arg.problems.length} problem(s) from ${arg.resource} to session ${target.id}`,
    )
    await target.sendPrompt(text, [], contexts, [])
    await revealChat(reveal, target.id)
  } catch (err) {
    logger.error(`aiFix: failed to dispatch prompt for ${arg.resource}`, err)
  }
}

export class AiFixCodeActionContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private readonly _reveal: RevealServices
  private readonly _run: AiFixRunServices

  constructor(
    @ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
    @IAcpSessionService sessions: IAcpSessionService,
    @IAcpAgentRegistry registry: IAcpAgentRegistry,
    @IAcpChatLocationService location: IAcpChatLocationService,
    @IAcpChatWidgetService widgets: IAcpChatWidgetService,
    @IEditorGroupsService groups: IEditorGroupsService,
    @IInstantiationService inst: IInstantiationService,
    @ILayoutService layout: ILayoutService,
    @IViewsService views: IViewsService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ILoggerService loggerService: ILoggerService,
    @IConfigurationService config: IConfigurationService,
    @IAcpConfigOptionsCacheService configOptionsCache: IAcpConfigOptionsCacheService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'aiFixCodeAction', name: 'AI Fix Code Action' })
    this._reveal = { sessions, registry, location, widgets, groups, inst, layout, views }
    this._run = { config, configOptionsCache }

    void MonacoLoader.ensureInitialized().then(() => {
      if (this._store.isDisposed) return
      const provider = createAiFixCodeActionProvider<monaco.editor.IMarkerData>((resource) => {
        const { name } = toMentionName(URI.parse(resource), workspace.current?.folder)
        return name
      })
      this._register(languageFeatures.registerCodeActionProvider('*', provider))
      this._register(
        MonacoLoader.get().editor.registerCommand(
          AI_FIX_COMMAND_ID,
          (_acc, arg: AiFixProblemArg) =>
            void executeAiFix(this._reveal, this._run, arg, this._logger),
        ),
      )
    })
  }
}
