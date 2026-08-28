/*---------------------------------------------------------------------------------------------
 *  构建期注入的产品默认配置（settings.json 配置项的出厂默认值）。
 *
 *  单一真相：env 名 → settings key 的映射表。加一个可注入的配置项只需两步：
 *    1. 在下面的 CONFIGURATION_DEFAULTS_ENV_MAP 加一行
 *    2. 在 .env.example 对应分组下补一行注释说明（真实值只进 gitignored 的 .env.<mode>）
 *
 *  两条消费链路共用本表：
 *    - 打包：scripts/release/runtime-resources.mjs 写进 resources/product.json
 *    - dev ：apps/editor/scripts/dev*.mjs 序列化成 UNIVERSE_CONFIGURATION_DEFAULTS 环境变量
 *
 *  注入值的优先级是「高于配置项 schema 的 default，低于用户 settings.json」——
 *  打包版开箱可用，用户仍可覆盖。渲染端接线见 packages/platform 的
 *  IConfigurationRegistry.registerDefaultOverrides。
 *--------------------------------------------------------------------------------------------*/

/** main 侧读取该 JSON 的环境变量名（apps/editor/src/main/environment/configItems.ts 声明同名 ConfigItem）。 */
export const CONFIGURATION_DEFAULTS_ENV = 'UNIVERSE_CONFIGURATION_DEFAULTS'

/** product.json 里承载注入值的字段名。 */
export const CONFIGURATION_DEFAULTS_FIELD = 'configurationDefaults'

export const CONFIGURATION_DEFAULTS_ENV_MAP = [
  { env: 'UE_SWARM_URL', setting: 'perforce.swarm.url' },
  { env: 'UE_TRACKER_SERVER_URL', setting: 'issueReporter.tracker.serverUrl' },
  { env: 'UE_TRACKER_APP_URL', setting: 'issueReporter.tracker.appUrl' },
]

/**
 * 从环境变量收集已配置的产品默认值。
 * 未配置与空串一律跳过（空串等于「不注入」，让配置项回落到自己的 schema default）。
 * 全都没配则返回 undefined —— 调用方据此完全不写该字段，而不是写一个空对象。
 */
export function collectConfigurationDefaults(env = process.env) {
  const defaults = {}
  for (const { env: name, setting } of CONFIGURATION_DEFAULTS_ENV_MAP) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      defaults[setting] = value.trim()
    }
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined
}
