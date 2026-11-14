/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for `<workspace>/.universe-editor/triggers.json` and the
 *  machine-wide `triggers.maxConcurrentRuns` setting. The file lives in every
 *  workspace that opts into triggers, so a glob fileMatch is used (the same shape
 *  as `.vscode/settings.json`). The scheduler reads / writes the file in main; this
 *  contribution adds completion + validation and forwards setting changes to main.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  type IDisposable,
  type IJSONSchema,
  type IWorkbenchContribution,
  JSONContributionRegistry,
  MutableDisposable,
  localize,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../shared/ipc/triggerService.js'
import {
  ELEVATED_MODE_IDS,
  TRIGGER_ACTION_TYPES,
  TRIGGER_DEFAULTS,
  TRIGGERS_MAX_CONCURRENT_RUNS_KEY,
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  TRIGGERS_WORKSPACE_DIR,
} from '../../shared/triggers/types.js'

const TRIGGERS_SCHEMA_URI = 'universe-editor://schemas/triggers'

/** Workspace-relative path; `makeGlobMatcher` matches it at any depth. */
export const TRIGGERS_SCHEMA_FILE_MATCH = `**/${TRIGGERS_WORKSPACE_DIR}/${TRIGGERS_WORKSPACE_CONFIG_FILE}`

/** Adds draft-7 `exclusiveMinimum` and `minLength`, which Monaco's JSON service accepts. */
type TriggerJSONSchema = Omit<IJSONSchema, 'properties' | 'items' | 'oneOf' | 'anyOf'> & {
  properties?: Record<string, TriggerJSONSchema>
  items?: TriggerJSONSchema
  oneOf?: TriggerJSONSchema[]
  anyOf?: TriggerJSONSchema[]
  exclusiveMinimum?: number
  minLength?: number
}

const SOURCE_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '触发源：四选一，由 type 区分。',
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      enum: ['manual', 'schedule', 'poll', 'swarm-review'],
      description:
        'manual = 手动运行；schedule = 定时；poll = 周期性执行命令取数；swarm-review = Swarm 审核。',
    },
  },
  oneOf: [
    {
      type: 'object',
      description: '手动触发：只有「Triggers: 立即运行」或其它命令会触发。',
      required: ['type'],
      properties: { type: { type: 'string', enum: ['manual'] } },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: '定时触发：cron 与 everyMin 必须且只能设置一个。',
      required: ['type'],
      oneOf: [{ required: ['cron'] }, { required: ['everyMin'] }],
      properties: {
        type: { type: 'string', enum: ['schedule'] },
        cron: {
          type: 'string',
          minLength: 1,
          description: '5 字段 cron（分 时 日 月 周），如 "0 9 * * 1"；支持 * , - /。',
        },
        everyMin: {
          type: 'integer',
          minimum: 1,
          description: '固定间隔（分钟，整数），与 cron 二选一。',
        },
        onMissed: {
          type: 'string',
          enum: ['skip', 'catch-up-once'],
          default: 'skip',
          description:
            '编辑器关闭期间错过的触发如何处理：skip = 丢弃；catch-up-once = 启动后补跑一次。',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: '命令轮询：按间隔执行取数命令，用 keyField 去重后逐个触发。',
      required: ['type', 'intervalSec', 'fetch', 'keyField'],
      properties: {
        type: { type: 'string', enum: ['poll'] },
        intervalSec: {
          type: 'integer',
          minimum: 30,
          description: '轮询间隔（秒，整数），至少 30。',
        },
        fetch: {
          type: 'object',
          description:
            '取数命令：在 main 进程执行；stdout 必须是 JSON 数组，或包含 items 数组的对象。',
          required: ['type', 'command'],
          properties: {
            type: { type: 'string', enum: ['command'] },
            command: { type: 'string', minLength: 1, description: '要执行的命令行。' },
            timeoutSec: {
              type: 'integer',
              minimum: 1,
              maximum: 600,
              default: TRIGGER_DEFAULTS.pollTimeoutSec,
              description: '命令超时（秒，整数），默认 60。',
            },
          },
          additionalProperties: false,
        },
        keyField: {
          type: 'string',
          minLength: 1,
          description: '数组元素中用作去重键的字段名，如 "id"。',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: 'Swarm 审核源：每个待处理审核触发一次（同一审核只触发一次）。',
      required: ['type'],
      properties: { type: { type: 'string', enum: ['swarm-review'] } },
      additionalProperties: false,
    },
  ],
}

const BUDGET_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '单次运行预算：数值字段都必须大于 0；maxCostUsd 写 null 表示不限费用。',
  properties: {
    maxCostUsd: {
      type: ['number', 'null'],
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.maxCostUsd,
      description: '单次运行费用上限（美元），超出后取消该轮；null 表示不限。',
    },
    timeoutMin: {
      type: 'number',
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.timeoutMin,
      description: '会话活跃时间上限（分钟）；等待审批/提问的时间不计入。',
    },
    approvalTimeoutMin: {
      type: 'number',
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.approvalTimeoutMin,
      description: '审批卡等待上限（分钟），超时后取消该轮并记为 approval-timeout。',
    },
  },
  additionalProperties: false,
}

const SESSION_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '会话配置：prompt 与 skill 至少设置一个。',
  anyOf: [{ required: ['prompt'] }, { required: ['skill'] }],
  properties: {
    agent: {
      type: 'string',
      minLength: 1,
      description: 'Agent id，缺省使用默认 agent。',
    },
    cwd: {
      type: 'string',
      minLength: 1,
      description: '相对 workspace 的工作目录，必须位于其下（不允许 ".." 或绝对路径）。',
    },
    mode: {
      type: 'string',
      minLength: 1,
      description: `显式 mode id；缺省使用该 agent 的保守档。高权限 mode（${ELEVATED_MODE_IDS.join(' / ')}）需先执行「确认高权限模式」，否则该触发器不会运行。`,
    },
    model: { type: 'string', minLength: 1, description: '模型 id，缺省使用默认模型。' },
    skill: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]*$',
      description: '要调用的 skill 名，作为 prompt 首行的 /skill。',
    },
    prompt: {
      type: 'string',
      description: '提示词模板；可用 {{event.字段}} 引用事件负载中的标量值。',
    },
    mcpServers: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: '创建会话时 pin 的 MCP 服务器名；之后不会随设置变化。',
    },
    budget: BUDGET_SCHEMA,
  },
  additionalProperties: false,
}

const TRIGGER_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  required: ['id', 'source', 'session'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
      description: '唯一 id：小写字母、数字与连字符；在同一工作区的 triggers.json 内唯一。',
    },
    name: {
      type: 'string',
      minLength: 1,
      description: '显示名称；缺省使用 id。',
    },
    enabled: {
      type: 'boolean',
      default: false,
      description: '是否启用；缺省关闭。首次启用前需在本机确认一次。',
    },
    showSession: {
      type: 'boolean',
      default: false,
      description:
        '启动会话后自动切到该会话。仅当窗口已可见时生效：后台打开的隐藏窗口、最小化/不可见窗口不会被唤醒或拉到前台。修改它会改变配置指纹，需要重新确认。',
    },
    source: SOURCE_SCHEMA,
    session: SESSION_SCHEMA,
    allowedActions: {
      type: 'array',
      items: { type: 'string', enum: [...TRIGGER_ACTION_TYPES], minLength: 1 },
      description: '判决可自动执行的动作白名单；不在列表内的动作会降级为 escalate。',
    },
    concurrency: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      default: TRIGGER_DEFAULTS.concurrency,
      description: '该触发器的并发上限（整数）；缺省 1。',
    },
    overflow: {
      type: 'string',
      enum: ['queue', 'drop'],
      default: TRIGGER_DEFAULTS.overflow,
      description: '并发已满时的处理：queue = 排队（上限 20）；drop = 丢弃该次触发。',
    },
  },
  additionalProperties: false,
}

export const TRIGGERS_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: {
      type: 'number',
      enum: [1],
      default: 1,
      description: '配置格式版本，当前固定为 1。',
    },
    triggers: {
      type: 'array',
      items: TRIGGER_SCHEMA,
      description: '触发器列表；单个触发器配置非法只影响它自己。',
    },
  },
}

export class TriggersConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _schema = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IConfigurationService config: IConfigurationService,
    @ITriggerMainService triggers: ITriggerMainService,
  ) {
    super()
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: TRIGGERS_SCHEMA_URI,
      fileMatch: [TRIGGERS_SCHEMA_FILE_MATCH],
      schema: TRIGGERS_SCHEMA,
    })
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'triggers',
        title: localize('settings.triggers', 'Agent Triggers'),
        properties: {
          [TRIGGERS_MAX_CONCURRENT_RUNS_KEY]: {
            type: 'integer',
            default: TRIGGER_DEFAULTS.maxConcurrentRuns,
            minimum: 1,
            maximum: 10,
            description: localize(
              'settings.triggers.maxConcurrentRuns',
              'Maximum number of trigger-initiated agent runs that may execute at the same time on this machine. Individual triggers also have their own `concurrency` limit.',
            ),
          },
        },
      }),
    )
    this._register(
      config.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(TRIGGERS_MAX_CONCURRENT_RUNS_KEY)) return
        const value = config.get<number>(TRIGGERS_MAX_CONCURRENT_RUNS_KEY)
        void triggers.setMaxConcurrentRuns(value ?? TRIGGER_DEFAULTS.maxConcurrentRuns)
      }),
    )
  }
}
