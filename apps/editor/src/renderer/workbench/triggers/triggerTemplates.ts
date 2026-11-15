/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Skill skeletons shipped under docs/user/zh-CN/ai-agent/trigger-templates/.
 *  Selecting one in the create wizard prefills skill / prompt / budget / source
 *  and links to its guide. Keep this list in sync with that directory.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { TriggerSourceDraft } from './triggerSources/types.js'

export interface TriggerSkillTemplate {
  readonly id: string
  readonly label: string
  readonly description: string
  /** Doc-center id (path under docs/user/zh-CN minus `.md`). */
  readonly docId: string
  readonly skill: string
  readonly mode?: string
  readonly prompt: string
  readonly maxCostUsd: string
  readonly timeoutMin: string
  readonly approvalTimeoutMin: string
  readonly source: TriggerSourceDraft
}

const TRIGGER_TEMPLATES_DOC_DIR = 'ai-agent/trigger-templates'

export const TRIGGER_SKILL_TEMPLATES: readonly TriggerSkillTemplate[] = [
  {
    id: 'swarm-triage',
    label: localize('trigger.manager.wizard.skill.swarmTriage', 'Swarm review triage'),
    description: localize(
      'trigger.manager.wizard.skill.swarmTriageDesc',
      'Reads a Swarm review that needs action, judges the risk and votes / comments / approves with the bundled CLI.',
    ),
    docId: `${TRIGGER_TEMPLATES_DOC_DIR}/swarm-triage/SKILL`,
    skill: 'swarm-triage',
    prompt: '分诊 Swarm 审核 #{{event.reviewId}}（作者 {{event.author}}）。',
    maxCostUsd: '1',
    timeoutMin: '30',
    approvalTimeoutMin: '1440',
    source: { type: 'event', eventName: 'swarm.reviewNeedsAction' },
  },
  {
    id: 'biweekly-report',
    label: localize('trigger.manager.wizard.skill.biweeklyReport', 'Biweekly report'),
    description: localize(
      'trigger.manager.wizard.skill.biweeklyReportDesc',
      'Collects the last two weeks of progress and drafts a report; publishing is escalated for review.',
    ),
    docId: `${TRIGGER_TEMPLATES_DOC_DIR}/biweekly-report/SKILL`,
    skill: 'biweekly-report',
    prompt: '整理过去两周的进展，生成双周报草稿。',
    maxCostUsd: '2',
    timeoutMin: '60',
    approvalTimeoutMin: '1440',
    source: { type: 'schedule', cron: '0 10 1,15 * *', everyMin: '', onMissed: 'skip' },
  },
  {
    id: 'team-weekly-digest',
    label: localize('trigger.manager.wizard.skill.teamWeeklyDigest', 'Weekly team digest'),
    description: localize(
      'trigger.manager.wizard.skill.teamWeeklyDigestDesc',
      'Summarizes last week’s commits and reviews into a read-only internal digest (always info).',
    ),
    docId: `${TRIGGER_TEMPLATES_DOC_DIR}/team-weekly-digest/SKILL`,
    skill: 'team-weekly-digest',
    prompt: '汇总上周的提交与 Swarm 审核，输出一份内部摘要。',
    maxCostUsd: '1',
    timeoutMin: '30',
    approvalTimeoutMin: '1440',
    source: { type: 'schedule', cron: '0 9 * * 1', everyMin: '', onMissed: 'skip' },
  },
  {
    id: 'fix-ci-failure',
    label: localize('trigger.manager.wizard.skill.fixCiFailure', 'Fix failed CI runs'),
    description: localize(
      'trigger.manager.wizard.skill.fixCiFailureDesc',
      'Polls GitHub Actions for a failed main build, reruns suspected flakes or fixes real regressions behind a push gate.',
    ),
    docId: `${TRIGGER_TEMPLATES_DOC_DIR}/fix-ci-failure/SKILL`,
    skill: 'fix-ci-failure',
    prompt: '修复 CI run {{event.runId}}（attempt {{event.attempt}}，{{event.title}}）。',
    maxCostUsd: '',
    timeoutMin: '90',
    approvalTimeoutMin: '1440',
    source: {
      type: 'poll',
      intervalSec: '300',
      command: 'node scripts/github/ci-failures.mjs',
      pollTimeoutSec: '60',
      keyField: 'id',
    },
  },
]
