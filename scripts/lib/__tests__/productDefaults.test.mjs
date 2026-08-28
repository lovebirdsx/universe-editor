/*---------------------------------------------------------------------------------------------
 *  scripts/lib/productDefaults.mjs 单测：env → settings key 映射与空值语义。
 *  全程传入独立 env 对象，绝不触碰真实 process.env。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIGURATION_DEFAULTS_ENV_MAP,
  collectConfigurationDefaults,
} from '../productDefaults.mjs'

test('collectConfigurationDefaults: 全空返回 undefined（调用方据此完全不写该字段）', () => {
  assert.equal(collectConfigurationDefaults({}), undefined)
})

test('collectConfigurationDefaults: 只收集已配置项，按映射表转成 settings key', () => {
  assert.deepEqual(collectConfigurationDefaults({ UE_SWARM_URL: 'http://swarm/' }), {
    'perforce.swarm.url': 'http://swarm/',
  })
})

test('collectConfigurationDefaults: 空串与纯空白等于未配置', () => {
  assert.equal(
    collectConfigurationDefaults({ UE_SWARM_URL: '', UE_TRACKER_APP_URL: '   ' }),
    undefined,
  )
})

test('collectConfigurationDefaults: 值两端空白被裁掉', () => {
  assert.deepEqual(collectConfigurationDefaults({ UE_TRACKER_APP_URL: '  http://t/  ' }), {
    'issueReporter.tracker.appUrl': 'http://t/',
  })
})

test('collectConfigurationDefaults: 无关的 UE_* 变量不进结果', () => {
  assert.equal(collectConfigurationDefaults({ UE_GALLERY_URL: 'http://g/' }), undefined)
})

test('映射表的 env 名与 settings key 均无重复', () => {
  const envNames = CONFIGURATION_DEFAULTS_ENV_MAP.map((e) => e.env)
  const settings = CONFIGURATION_DEFAULTS_ENV_MAP.map((e) => e.setting)
  assert.equal(new Set(envNames).size, envNames.length)
  assert.equal(new Set(settings).size, settings.length)
})
