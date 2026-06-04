import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  type IWindowsService,
} from '@universe-editor/platform'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { StartupPerformanceStatusContribution } from '../StartupPerformanceStatusContribution.js'
import type { ITimerService, IStartupMetrics } from '../../services/performance/TimerService.js'
import {
  DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS,
  DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS,
  STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY,
  STARTUP_WARNING_ENABLED_KEY,
  STARTUP_WARNING_RELEASE_THRESHOLD_KEY,
  startupWarningEnabled,
  startupWarningThresholdMs,
} from '../../services/performance/startupPerformanceSettings.js'

const EMPTY_METRICS: IStartupMetrics = {
  totalTime: 0,
  phases: [],
  marks: [],
}

function timerStub(metrics: IStartupMetrics = EMPTY_METRICS): ITimerService {
  return {
    _serviceBrand: undefined,
    getStartupMetrics: vi.fn(() => Promise.resolve(metrics)),
    getPerfMarks: vi.fn(() => Promise.resolve([])),
  }
}

interface WindowsStub extends IWindowsService {
  isCurrentWindowFirst: ReturnType<typeof vi.fn>
}

function windowsStub(isFirst = true): WindowsStub {
  return {
    _serviceBrand: undefined,
    onDidChangeWindows: vi.fn(() => ({ dispose: vi.fn() })),
    getWindows: vi.fn(() => Promise.resolve([])),
    isCurrentWindowFirst: vi.fn(() => Promise.resolve(isFirst)),
    focusWindow: vi.fn(() => Promise.resolve()),
    openWindow: vi.fn(() => Promise.resolve()),
    quit: vi.fn(() => Promise.resolve()),
  } as WindowsStub
}

async function flushAsyncRender(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('startup performance warning settings', () => {
  it('enables warnings by default in development and disables them by default in release', () => {
    const config = new ConfigurationService()

    expect(startupWarningEnabled(config, true)).toBe(true)
    expect(startupWarningEnabled(config, false)).toBe(false)
  })

  it('uses configured enabled value in both modes', () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, false, ConfigurationTarget.Memory)

    expect(startupWarningEnabled(config, true)).toBe(false)
    expect(startupWarningEnabled(config, false)).toBe(false)

    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)

    expect(startupWarningEnabled(config, true)).toBe(true)
    expect(startupWarningEnabled(config, false)).toBe(true)
  })

  it('uses release and development defaults by mode', () => {
    const config = new ConfigurationService()

    expect(startupWarningThresholdMs(config, false)).toBe(
      DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS,
    )
    expect(startupWarningThresholdMs(config, true)).toBe(
      DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS,
    )
  })

  it('uses configured release and development thresholds by mode', () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 1200, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 4500, ConfigurationTarget.Memory)

    expect(startupWarningThresholdMs(config, false)).toBe(1200)
    expect(startupWarningThresholdMs(config, true)).toBe(4500)
  })
})

describe('StartupPerformanceStatusContribution', () => {
  it('does not measure startup metrics when explicitly disabled', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, false, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 5000 })

    const contribution = new StartupPerformanceStatusContribution(
      timer,
      statusBar,
      config,
      windowsStub(),
    )
    await flushAsyncRender()

    expect(timer.getStartupMetrics).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
  })

  it('does not show an entry when enabled but under the active threshold', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 10_000, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 10_000, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 1000 })

    const contribution = new StartupPerformanceStatusContribution(
      timer,
      statusBar,
      config,
      windowsStub(),
    )
    await flushAsyncRender()

    expect(timer.getStartupMetrics).toHaveBeenCalledOnce()
    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
  })

  it('shows a prominent entry when enabled and over the active threshold', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 2500 })

    const contribution = new StartupPerformanceStatusContribution(
      timer,
      statusBar,
      config,
      windowsStub(),
    )
    await flushAsyncRender()

    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('$(dashboard) 2.50s')
    expect(entry?.kind).toBe('prominent')
    expect(entry?.command).toBe('workbench.action.showStartupPerformance')

    contribution.dispose()
  })

  it('shows the entry when settings load enables the warning after construction', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, false, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 2500 })

    const contribution = new StartupPerformanceStatusContribution(
      timer,
      statusBar,
      config,
      windowsStub(),
    )
    await flushAsyncRender()
    expect(statusBar.entries.get()).toHaveLength(0)
    expect(timer.getStartupMetrics).not.toHaveBeenCalled()

    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
    await flushAsyncRender()

    expect(timer.getStartupMetrics).toHaveBeenCalledOnce()
    expect(statusBar.entries.get()).toHaveLength(1)

    contribution.dispose()
  })

  it('hides the entry when the warning is disabled', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 2500 })

    const contribution = new StartupPerformanceStatusContribution(
      timer,
      statusBar,
      config,
      windowsStub(),
    )
    await flushAsyncRender()
    expect(statusBar.entries.get()).toHaveLength(1)

    config.update(STARTUP_WARNING_ENABLED_KEY, false, ConfigurationTarget.Memory)
    await flushAsyncRender()

    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
  })

  it('does not measure startup metrics in secondary windows', async () => {
    const config = new ConfigurationService()
    config.update(STARTUP_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    config.update(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY, 1, ConfigurationTarget.Memory)
    const statusBar = new StatusBarService()
    const timer = timerStub({ ...EMPTY_METRICS, totalTime: 2500 })
    const windows = windowsStub(false)

    const contribution = new StartupPerformanceStatusContribution(timer, statusBar, config, windows)
    await flushAsyncRender()

    expect(windows.isCurrentWindowFirst).toHaveBeenCalledOnce()
    expect(timer.getStartupMetrics).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)

    config.update(STARTUP_WARNING_RELEASE_THRESHOLD_KEY, 2, ConfigurationTarget.Memory)
    await flushAsyncRender()

    expect(windows.isCurrentWindowFirst).toHaveBeenCalledOnce()
    expect(timer.getStartupMetrics).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
  })
})
