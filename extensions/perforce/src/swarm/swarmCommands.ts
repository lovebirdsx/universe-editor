/**
 * Swarm command registration. Called from the perforce extension's `activate`
 * when `perforce.swarm.enabled` is set. Builds a {@link SwarmClient} lazily from
 * config + the active PerforceClient (for the p4 connection / ticket), and
 * registers every `perforce.swarm.*` command the renderer calls over the
 * contributed-command boundary.
 *
 * All handlers live here (extension host), so these command ids are safe to
 * declare in package.json `commands` (they are not renderer Action2 — see the
 * shadowing guardrail in memory `renderer-action-shadowed-by-extension-command-decl`).
 */
import { commands, window, workspace, type Disposable } from '@universe-editor/extension-api'
import type { ClientManager } from '../clientManager.js'
import { changelistIdFromGroupId } from '../changelist.js'
import { SwarmClient, type SwarmReviewFilter } from './swarmClient.js'
import { SwarmError, SwarmErrorCode } from './swarmApi.js'
import { SwarmStatusBarController } from './swarmStatusBar.js'
import type { SwarmLogger } from './swarmLog.js'
import { buildReviewPicks } from './swarmReviewPick.js'
import { localize } from '../nls.js'

/** Command id constants (mirror of extensions-common `SwarmCommands`; kept local
 *  to avoid bundling that package into the extension). */
const Cmd = {
  ping: 'perforce.swarm.ping',
  requestReview: 'perforce.swarm.requestReview',
  listReviews: 'perforce.swarm.listReviews',
  dashboard: 'perforce.swarm.dashboard',
  getReview: 'perforce.swarm.getReview',
  getTransitions: 'perforce.swarm.getTransitions',
  createReview: 'perforce.swarm.createReview',
  vote: 'perforce.swarm.vote',
  transition: 'perforce.swarm.transition',
  obliterateReview: 'perforce.swarm.obliterateReview',
  addChange: 'perforce.swarm.addChange',
  updateReview: 'perforce.swarm.updateReview',
  updateReviewFromChangelist: 'perforce.swarm.updateReviewFromChangelist',
  listComments: 'perforce.swarm.listComments',
  addComment: 'perforce.swarm.addComment',
  setTaskState: 'perforce.swarm.setTaskState',
  getFileContent: 'perforce.swarm.getFileContent',
  getFileContentBytes: 'perforce.swarm.getFileContentBytes',
  describeVersion: 'perforce.swarm.describeVersion',
} as const

export interface SwarmConfig {
  readonly url: string
  readonly apiVersion: string
  readonly authMode: 'ticket' | 'token'
}

async function readSwarmConfig(): Promise<SwarmConfig | undefined> {
  const cfg = workspace.getConfiguration('perforce')
  if (!(await cfg.get('swarm.enabled', true))) return undefined
  const url = ((await cfg.get('swarm.url', 'http://swarm.aki.kuro.com/')) as string).trim()
  if (!url) return undefined
  const apiVersion = ((await cfg.get('swarm.apiVersion', 'v9')) as string).trim() || 'v9'
  const authMode = ((await cfg.get('swarm.authMode', 'ticket')) as 'ticket' | 'token') ?? 'ticket'
  return { url, apiVersion, authMode }
}

/** The persisted `perforce.swarm.needsActionAuthors` set. Drives an extra
 *  server-side `author=` query in the dashboard so reviews the user is only
 *  linked to through a Swarm project/group (not an individual reviewer) still
 *  surface in Needs My Action. Empty = participants-only behavior. */
async function readNeedsActionAuthors(): Promise<string[]> {
  const cfg = workspace.getConfiguration('perforce')
  const raw = await cfg.get<unknown>('swarm.needsActionAuthors', [])
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** The persisted `perforce.swarm.reviewWindowDays` (default 7). Limits the review
 *  lists to those updated within the last N days; 0 = no time limit. Swarm has no
 *  server-side "updated since" filter, so the window is applied client-side in
 *  {@link SwarmClient.dashboard}. */
async function readReviewWindowDays(): Promise<number> {
  const cfg = workspace.getConfiguration('perforce')
  const raw = (await cfg.get('swarm.reviewWindowDays', 7)) as number
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Registers Swarm commands. Returns a Disposable that tears down every command +
 * the SwarmClient. `getManager` yields the active PerforceClient for connection
 * coordinates. The SwarmClient is (re)built lazily whenever config or the active
 * client changes, so switching workspaces / editing the URL takes effect without
 * a reload.
 */
export function registerSwarmCommands(
  mgr: ClientManager,
  logger: SwarmLogger,
  cacheEnabled = true,
): Disposable {
  let client: SwarmClient | undefined
  let signature = ''

  const swarm = async (): Promise<SwarmClient | undefined> => {
    const config = await readSwarmConfig()
    if (!config) {
      client?.dispose()
      client = undefined
      signature = ''
      return undefined
    }
    const active = mgr.active
    const user = active?.user
    const sig = `${config.url}|${config.apiVersion}|${config.authMode}|${user ?? ''}`
    if (!client || sig !== signature) {
      if (!active) return undefined
      client?.dispose()
      logger.info(
        'client',
        `(re)building SwarmClient: url=${config.url} api=${config.apiVersion} auth=${config.authMode} user=${user ?? '(unknown)'}`,
      )
      client = new SwarmClient(
        active.p4Service,
        { baseUrl: config.url, apiVersion: config.apiVersion, user },
        logger,
        { enabled: cacheEnabled },
      )
      signature = sig
    }
    return client
  }

  /** Run a Swarm operation, mapping a missing-config / unauthorized failure to a
   *  friendly toast and returning a fallback. Auth failures trigger a p4 login.
   *  `label` names the operation so the panel reads as an action trace. */
  const guard = async <T>(
    label: string,
    op: (c: SwarmClient) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const c = await swarm()
    if (!c) {
      logger.warn(
        'cmd',
        `${label}: not configured (perforce.swarm.enabled/url) or no active client`,
      )
      return fallback
    }
    logger.debug('cmd', `${label}: start`)
    const startedAt = Date.now()
    try {
      const result = await op(c)
      logger.debug('cmd', `${label}: ok in ${Date.now() - startedAt}ms`)
      return result
    } catch (err) {
      if (err instanceof SwarmError && err.code === SwarmErrorCode.Unauthorized) {
        logger.warn('cmd', `${label}: unauthorized → prompting p4 login`)
        const picked = await window.showErrorMessage(
          localize(
            'perforce.swarm.error.unauthorized',
            'Swarm authentication failed. Log in to Perforce and retry.',
          ),
          localize('perforce.swarm.btn.login', 'Login'),
        )
        if (picked) await commands.executeCommand('perforce.login')
        return fallback
      }
      const message = err instanceof Error ? err.message : String(err)
      logger.error('cmd', `${label}: failed in ${Date.now() - startedAt}ms: ${message}`)
      await window.showErrorMessage(
        localize('perforce.swarm.error.generic', 'Swarm request failed: {0}', { 0: message }),
      )
      return fallback
    }
  }

  const subs: Disposable[] = [
    // Connectivity self-check (command palette): GET /reviews?max=1.
    commands.registerCommand(Cmd.ping, async () => {
      const config = await readSwarmConfig()
      if (!config) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.notConfigured',
            'Swarm is not configured. Set perforce.swarm.enabled and perforce.swarm.url.',
          ),
        )
        return { ok: false, count: 0 }
      }
      return guard(
        'ping',
        async (c) => {
          const res = await c.ping()
          await window.showInformationMessage(
            localize('perforce.swarm.ping.ok', 'Connected to Swarm at {0}.', { 0: config.url }),
          )
          return res
        },
        { ok: false, count: 0 },
      )
    }),

    // Request a Swarm review for a changelist. Entry points: SCM changelist group
    // header (arg carries `scmResourceGroupId`), Perforce Graph node, or the
    // command palette. Ensures the CL is numbered + shelved, prompts for optional
    // reviewers, POSTs /reviews, then opens the review detail tab.
    commands.registerCommand(Cmd.requestReview, async (arg: unknown) => {
      const active = mgr.resolveClient(arg) ?? mgr.active
      if (!active) return
      const config = await readSwarmConfig()
      if (!config) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.notConfigured',
            'Swarm is not configured. Set perforce.swarm.enabled and perforce.swarm.url.',
          ),
        )
        return
      }
      // Resolve the target changelist from the group arg, or prompt for one.
      const groupId = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      let changelist = groupId ? changelistIdFromGroupId(groupId) : undefined
      if (!changelist) {
        const typed = await window.showInputBox({
          prompt: localize(
            'perforce.swarm.requestReview.clPrompt',
            'Changelist to review (number, or "default")',
          ),
          value: 'default',
        })
        if (typed === undefined) return
        changelist = typed.trim() || 'default'
      }
      // Default description = the changelist's own description.
      const defaultDesc =
        changelist === 'default'
          ? active.description
          : await active.getChangelistDescription(changelist)
      const description = await window.showInputBox({
        prompt: localize('perforce.swarm.requestReview.descPrompt', 'Review description'),
        value: defaultDesc,
      })
      if (description === undefined) return
      const reviewersRaw = await window.showInputBox({
        prompt: localize(
          'perforce.swarm.requestReview.reviewersPrompt',
          'Reviewers (comma-separated, optional). Prefix with ! for required.',
        ),
      })
      if (reviewersRaw === undefined) return
      const reviewers: string[] = []
      const requiredReviewers: string[] = []
      for (const raw of reviewersRaw.split(',').map((s) => s.trim())) {
        if (!raw) continue
        if (raw.startsWith('!')) requiredReviewers.push(raw.slice(1))
        else reviewers.push(raw)
      }

      // Ensure the changelist is a numbered, shelved change.
      const change = await active.shelveForReview(changelist, description)
      if (!change) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.requestReview.shelveFailed',
            'Could not shelve the changelist for review (is it empty?).',
          ),
        )
        return
      }

      const reviewId = await guard(
        `requestReview change=${change}`,
        (c) =>
          c.createReview({
            change,
            description,
            ...(reviewers.length ? { reviewers } : {}),
            ...(requiredReviewers.length ? { requiredReviewers } : {}),
          }),
        undefined as string | undefined,
      )
      if (!reviewId) return
      await window.showInformationMessage(
        localize('perforce.swarm.requestReview.created', 'Created Swarm review #{0}.', {
          0: reviewId,
        }),
      )
      // Open the review detail tab (renderer Action2 via the _workbench.* lane).
      await commands.executeCommand('_workbench.openSwarmReview', reviewId)
      void statusBar.refresh()
    }),

    commands.registerCommand(Cmd.listReviews, (arg: unknown) =>
      guard('listReviews', async (c) => c.listReviews((arg ?? {}) as SwarmReviewFilter), {
        reviews: [],
        lastSeen: null,
      }),
    ),

    commands.registerCommand(Cmd.dashboard, (arg: unknown) =>
      guard(
        'dashboard',
        async (c) => {
          const r = (arg ?? {}) as { force?: boolean; keywords?: string }
          const needsActionAuthors = await readNeedsActionAuthors()
          const windowDays = await readReviewWindowDays()
          return c.dashboard({
            ...(r.force ? { force: true } : {}),
            ...(r.keywords ? { keywords: r.keywords } : {}),
            ...(needsActionAuthors.length ? { needsActionAuthors } : {}),
            ...(windowDays > 0 ? { windowDays } : {}),
          })
        },
        {
          needsAction: [],
          authored: [],
          participating: [],
        },
      ),
    ),

    commands.registerCommand(Cmd.getReview, (arg: unknown) => {
      const request =
        typeof arg === 'object' && arg !== null
          ? (arg as { reviewId: string; force?: boolean })
          : { reviewId: String(arg) }
      return guard(
        `getReview #${request.reviewId}`,
        (c) => c.getReview(request.reviewId, request.force),
        undefined,
      )
    }),

    commands.registerCommand(Cmd.getTransitions, (id: unknown) =>
      guard(`getTransitions #${String(id)}`, (c) => c.getTransitions(String(id)), []),
    ),

    commands.registerCommand(Cmd.createReview, (req: unknown) =>
      guard(
        'createReview',
        (c) =>
          c.createReview(
            req as {
              change: string
              description?: string
              reviewers?: string[]
              requiredReviewers?: string[]
            },
          ),
        undefined,
      ),
    ),

    commands.registerCommand(Cmd.vote, (req: unknown) =>
      guard(
        `vote #${(req as { reviewId?: string })?.reviewId ?? '?'}=${(req as { vote?: string })?.vote ?? '?'}`,
        async (c) => {
          const r = req as { reviewId: string; vote: 'up' | 'down' | 'clear'; version?: number }
          await c.vote(r.reviewId, r.vote, r.version)
          return true
        },
        false,
      ),
    ),

    commands.registerCommand(Cmd.transition, (req: unknown) =>
      guard(
        `transition #${(req as { reviewId?: string })?.reviewId ?? '?'}→${(req as { state?: string })?.state ?? '?'}`,
        async (c) => {
          const r = req as {
            reviewId: string
            state: string
            commit?: boolean
            description?: string
          }
          await c.transition(r.reviewId, r.state, {
            ...(r.commit ? { commit: true } : {}),
            ...(r.description ? { description: r.description } : {}),
          })
          return true
        },
        false,
      ),
    ),

    commands.registerCommand(Cmd.obliterateReview, (req: unknown) =>
      guard(
        `obliterateReview #${(req as { reviewId?: string })?.reviewId ?? '?'}`,
        async (c) => {
          const r = req as { reviewId: string }
          await c.obliterateReview(r.reviewId)
          return true
        },
        false,
      ),
    ),

    commands.registerCommand(Cmd.addChange, (req: unknown) =>
      guard(
        `addChange #${(req as { reviewId?: string })?.reviewId ?? '?'}`,
        async (c) => {
          const r = req as { reviewId: string; change: string; mode?: 'replace' | 'append' }
          await c.addChange(r.reviewId, r.change, r.mode)
          return true
        },
        false,
      ),
    ),

    // Author closure: re-shelve a changelist and link it to the review as a new
    // version (needsRevision → needsReview). Prompts for the changelist when the
    // request doesn't carry one.
    commands.registerCommand(Cmd.updateReview, async (req: unknown) => {
      const r = (req ?? {}) as { reviewId?: string; changelist?: string }
      if (!r.reviewId) return false
      const active = mgr.active
      if (!active) return false
      let changelist = r.changelist
      if (!changelist) {
        const typed = await window.showInputBox({
          prompt: localize(
            'perforce.swarm.updateReview.clPrompt',
            'Changelist to re-shelve for this review (number, or "default")',
          ),
          value: 'default',
        })
        if (typed === undefined) return false
        changelist = typed.trim() || 'default'
      }
      const change = await active.shelveForReview(changelist)
      if (!change) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.requestReview.shelveFailed',
            'Could not shelve the changelist for review (is it empty?).',
          ),
        )
        return false
      }
      const ok = await guard(
        `updateReview #${r.reviewId} change=${change}`,
        async (c) => {
          await c.addChange(r.reviewId as string, change, 'replace')
          return true
        },
        false,
      )
      if (ok) {
        await window.showInformationMessage(
          localize('perforce.swarm.updateReview.done', 'Updated Swarm review #{0}.', {
            0: r.reviewId,
          }),
        )
        void statusBar.refresh()
      }
      return ok
    }),

    // "Update a Swarm Review…" (P4V parity): from a changelist, pick one of the
    // reviews you authored and attach a fresh version. Entry points: SCM
    // changelist group header (arg carries `scmResourceGroupId`) or the command
    // palette. Unlike `updateReview` (driven by the review detail tab, which
    // already knows its reviewId), this flow starts from the changelist and lets
    // the author choose which existing review to update.
    commands.registerCommand(Cmd.updateReviewFromChangelist, async (arg: unknown) => {
      const active = mgr.resolveClient(arg) ?? mgr.active
      if (!active) return
      const config = await readSwarmConfig()
      if (!config) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.notConfigured',
            'Swarm is not configured. Set perforce.swarm.enabled and perforce.swarm.url.',
          ),
        )
        return
      }
      // Resolve the target changelist from the group arg, or prompt for one.
      const groupId = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      let changelist = groupId ? changelistIdFromGroupId(groupId) : undefined
      if (!changelist) {
        const typed = await window.showInputBox({
          prompt: localize(
            'perforce.swarm.requestReview.clPrompt',
            'Changelist to review (number, or "default")',
          ),
          value: 'default',
        })
        if (typed === undefined) return
        changelist = typed.trim() || 'default'
      }

      // Let the author pick which of their open reviews to update.
      const me = active.user
      const reviews = await guard(
        'updateReviewFromChangelist: listReviews',
        (c) => c.listReviews({ ...(me ? { author: [me] } : {}), max: 100 }).then((r) => r.reviews),
        [],
      )
      const picks = buildReviewPicks(reviews)
      const enterManually = localize(
        'perforce.swarm.updateReview.enterId',
        'Enter a review number…',
      )
      const chosen = await window.showQuickPick(
        [...picks, { label: enterManually, description: '', detail: '', reviewId: '' }],
        {
          placeHolder: picks.length
            ? localize(
                'perforce.swarm.updateReview.pickPlaceholder',
                'Select a Swarm review to update with changelist {0}',
                { 0: changelist },
              )
            : localize(
                'perforce.swarm.updateReview.noneAuthored',
                'You have no open reviews — enter a review number to update',
              ),
        },
      )
      if (!chosen) return
      let reviewId = (chosen as { reviewId?: string }).reviewId ?? ''
      if (!reviewId) {
        const typed = await window.showInputBox({
          prompt: localize('perforce.swarm.updateReview.idPrompt', 'Swarm review number to update'),
        })
        if (typed === undefined) return
        reviewId = typed.trim()
        if (!reviewId) return
      }

      const change = await active.shelveForReview(changelist)
      if (!change) {
        await window.showWarningMessage(
          localize(
            'perforce.swarm.requestReview.shelveFailed',
            'Could not shelve the changelist for review (is it empty?).',
          ),
        )
        return
      }
      const ok = await guard(
        `updateReviewFromChangelist #${reviewId} change=${change}`,
        async (c) => {
          await c.addChange(reviewId, change, 'replace')
          return true
        },
        false,
      )
      if (!ok) return
      await window.showInformationMessage(
        localize('perforce.swarm.updateReview.done', 'Updated Swarm review #{0}.', {
          0: reviewId,
        }),
      )
      await commands.executeCommand('_workbench.openSwarmReview', reviewId)
      void statusBar.refresh()
    }),

    commands.registerCommand(Cmd.listComments, (req: unknown) =>
      guard(
        `listComments #${(req as { reviewId?: string })?.reviewId ?? '?'}`,
        (c) => {
          const r = (req ?? {}) as {
            reviewId: string
            tasksOnly?: boolean
            max?: number
            after?: string
            force?: boolean
          }
          return c.listComments(r.reviewId, {
            ...(r.tasksOnly ? { tasksOnly: true } : {}),
            ...(r.max ? { max: r.max } : {}),
            ...(r.after ? { after: r.after } : {}),
            ...(r.force ? { force: true } : {}),
          })
        },
        [],
      ),
    ),

    commands.registerCommand(Cmd.addComment, (req: unknown) =>
      guard(
        `addComment #${(req as { reviewId?: string })?.reviewId ?? '?'}`,
        (c) => {
          const r = req as {
            reviewId: string
            body: string
            asTask?: boolean
            content?: string[]
            context?: {
              file?: string
              leftLine?: number
              rightLine?: number
              content?: string[]
              version?: number
            }
          }
          // Swarm anchors inline comments with context.content (the line + a few
          // preceding lines) to survive drift; fold the renderer's top-level content
          // into the context.
          const context =
            r.context || r.content
              ? { ...(r.context ?? {}), ...(r.content ? { content: r.content } : {}) }
              : undefined
          return c.addComment(r.reviewId, r.body, {
            ...(r.asTask ? { taskState: 'open' } : {}),
            ...(context ? { context } : {}),
          })
        },
        undefined,
      ),
    ),

    commands.registerCommand(Cmd.setTaskState, (req: unknown) =>
      guard(
        `setTaskState comment=${(req as { commentId?: string })?.commentId ?? '?'}→${(req as { taskState?: string })?.taskState ?? '?'}`,
        async (c) => {
          const r = req as { reviewId: string; commentId: string; taskState: string }
          await c.setTaskState(r.reviewId, r.commentId, r.taskState)
          return true
        },
        false,
      ),
    ),

    // List the files in a review version's backing (shelved) change. Uses the
    // active PerforceClient's p4 connection (not the Swarm REST API) — the review
    // snapshot lives in the depot as a shelved change.
    commands.registerCommand(Cmd.describeVersion, async (arg: unknown) => {
      const active = mgr.active
      const request =
        typeof arg === 'object' && arg !== null
          ? (arg as { change: string; force?: boolean; immutable?: boolean })
          : { change: String(arg) }
      if (!active || !request.change) return []
      logger.debug('cmd', `describeVersion change=${request.change} (p4 describe)`)
      return active.describeChangeFiles(request.change, request.force, request.immutable)
    }),

    // Print a depot file at either its review-base revision (`#<rev>`) or an
    // immutable version snapshot (`@=<change>`). The suffix is deliberately
    // constrained before it reaches p4 so this data command cannot become a
    // general filespec escape hatch.
    commands.registerCommand(Cmd.getFileContent, async (req: unknown) => {
      const r = req as { depotFile: string; revision: string }
      const active = mgr.active
      if (!active || !r?.depotFile || !/^#\d+$|^@=\d+$/.test(r.revision)) return ''
      logger.debug('cmd', `getFileContent ${r.depotFile}${r.revision} (p4 print)`)
      return active.printRevision(`${r.depotFile}${r.revision}`)
    }),

    // Same as getFileContent but returns raw bytes base64-encoded, for binary
    // files (e.g. xlsx) that UTF-8 decoding would corrupt — consumed by the
    // spreadsheet webview diff. Same revision-suffix guard as the text variant.
    commands.registerCommand(Cmd.getFileContentBytes, async (req: unknown) => {
      const r = req as { depotFile: string; revision: string }
      const active = mgr.active
      if (!active || !r?.depotFile || !/^#\d+$|^@=\d+$/.test(r.revision)) return ''
      logger.debug('cmd', `getFileContentBytes ${r.depotFile}${r.revision} (p4 print, binary)`)
      const bytes = await active.printRevisionBytes(`${r.depotFile}${r.revision}`)
      return bytes.toString('base64')
    }),
  ]

  // Status bar: "N reviews need my attention", polled on an interval. Reuses the
  // same lazily-built SwarmClient so it shares connection + credential resolution.
  const statusBar = new SwarmStatusBarController(
    swarm,
    logger,
    readNeedsActionAuthors,
    readReviewWindowDays,
  )
  void readSwarmConfig().then(async () => {
    const cfg = workspace.getConfiguration('perforce')
    const pollInterval = (await cfg.get('swarm.pollInterval', 0)) as number
    statusBar.startPolling(pollInterval)
  })

  // A manual refresh command that re-polls the status bar (the renderer view has
  // its own refresh; this keeps the badge current after an action).
  subs.push(commands.registerCommand('perforce.swarm.refreshStatus', () => statusBar.refresh()))

  return {
    dispose: () => {
      statusBar.dispose()
      for (const s of subs) s.dispose()
      client?.dispose()
      client = undefined
    },
  }
}
