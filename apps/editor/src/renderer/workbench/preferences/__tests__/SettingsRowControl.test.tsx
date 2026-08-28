import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SettingsRowControl } from '../SettingsRowControl.js'

afterEach(() => {
  cleanup()
})

// defaultValue mirrors what SettingsEditor passes: the effective Default-layer
// value, which equals schema.default unless a product override replaced it.
function mountControl(
  schema: Parameters<typeof SettingsRowControl>[0]['schema'],
  value: unknown,
  defaultValue: unknown = schema.default,
) {
  const onCommit = vi.fn()
  const utils = render(
    <SettingsRowControl
      configKey="test.key"
      schema={schema}
      value={value}
      defaultValue={defaultValue}
      onCommit={onCommit}
    />,
  )
  return { ...utils, onCommit }
}

describe('SettingsRowControl enum', () => {
  const schema = {
    type: 'string' as const,
    default: 'off',
    enum: ['off', 'afterDelay', 'onFocusChange'],
  }

  it('shows the current value on the trigger and marks the default option', () => {
    const { container } = mountControl(schema, 'off')
    const trigger = container.querySelector('button')!
    expect(trigger.textContent).toContain('off')

    fireEvent.click(trigger)
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent)).toEqual([
      'off (default)',
      'afterDelay',
      'onFocusChange',
    ])
  })

  it('commits the picked value; picking the default commits undefined (reset)', () => {
    const { container, onCommit, rerender } = mountControl(schema, 'off')
    fireEvent.click(container.querySelector('button')!)
    fireEvent.click(
      Array.from(document.querySelectorAll('[role="option"]')).find(
        (o) => o.textContent === 'afterDelay',
      )!,
    )
    expect(onCommit).toHaveBeenLastCalledWith('afterDelay')

    rerender(
      <SettingsRowControl
        configKey="test.key"
        schema={schema}
        value="afterDelay"
        defaultValue={schema.default}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(container.querySelector('button')!)
    fireEvent.click(
      Array.from(document.querySelectorAll('[role="option"]')).find(
        (o) => o.textContent === 'off (default)',
      )!,
    )
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })
})

describe('SettingsRowControl boolean', () => {
  it('commits the toggled value; toggling back to the default commits undefined', () => {
    const onCommit = vi.fn()
    const utils = render(
      <SettingsRowControl
        configKey="test.key"
        schema={{ type: 'boolean', default: true }}
        value={true}
        defaultValue={true}
        onCommit={onCommit}
      />,
    )
    const cb = utils.container.querySelector('input[type=checkbox]') as HTMLInputElement
    fireEvent.click(cb)
    expect(onCommit).toHaveBeenLastCalledWith(false)

    utils.rerender(
      <SettingsRowControl
        configKey="test.key"
        schema={{ type: 'boolean', default: true }}
        value={false}
        defaultValue={true}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(cb)
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })
})

describe('SettingsRowControl number', () => {
  const schema = { type: 'number' as const, default: 14, minimum: 6, maximum: 100 }

  it('commits parsed numbers and ignores non-numeric intermediates', () => {
    const { container, onCommit } = mountControl(schema, 14)
    const input = container.querySelector('input[type=number]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1.' } })
    expect(onCommit).toHaveBeenLastCalledWith(1)
    fireEvent.change(input, { target: { value: '20' } })
    expect(onCommit).toHaveBeenLastCalledWith(20)
  })

  it('typing the default value commits undefined (reset)', () => {
    const { container, onCommit } = mountControl(schema, 20)
    fireEvent.change(container.querySelector('input[type=number]')!, {
      target: { value: '14' },
    })
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })

  it('holds an empty draft until blur, then resets', () => {
    const { container, onCommit } = mountControl(schema, 20)
    const input = container.querySelector('input[type=number]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })

  it('external value changes clear the draft', () => {
    const onCommit = vi.fn()
    const utils = render(
      <SettingsRowControl
        configKey="test.key"
        schema={schema}
        value={14}
        defaultValue={14}
        onCommit={onCommit}
      />,
    )
    const input = utils.container.querySelector('input[type=number]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    utils.rerender(
      <SettingsRowControl
        configKey="test.key"
        schema={schema}
        value={22}
        defaultValue={14}
        onCommit={onCommit}
      />,
    )
    expect(input.value).toBe('22')
  })
})

describe('SettingsRowControl string', () => {
  it('commits text; clearing a default-less string resets', () => {
    const { container, onCommit } = mountControl({ type: 'string' }, 'abc')
    const input = container.querySelector('input[type=text]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abcd' } })
    expect(onCommit).toHaveBeenLastCalledWith('abcd')
    fireEvent.change(input, { target: { value: '' } })
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })

  it('typing the schema default commits undefined', () => {
    const { container, onCommit } = mountControl({ type: 'string', default: 'off' }, 'afterDelay')
    fireEvent.change(container.querySelector('input[type=text]')!, { target: { value: 'off' } })
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })
})

// A product override (build-time injected default) replaces the effective default
// without touching schema.default. Reading schema.default here would both mislabel
// the reset target and swallow "clear the field to disable" — the injected value
// would silently come back.
describe('SettingsRowControl product-overridden default', () => {
  const schema = { type: 'string' as const, default: '' }

  it('clearing the field commits the empty string, not a reset', () => {
    const { container, onCommit } = mountControl(schema, 'http://injected/', 'http://injected/')
    fireEvent.change(container.querySelector('input[type=text]')!, { target: { value: '' } })
    expect(onCommit).toHaveBeenLastCalledWith('')
  })

  it('typing the injected value commits undefined (reset)', () => {
    const { container, onCommit } = mountControl(schema, 'http://mine/', 'http://injected/')
    fireEvent.change(container.querySelector('input[type=text]')!, {
      target: { value: 'http://injected/' },
    })
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })

  it('marks the overridden enum option as the default', () => {
    const enumSchema = {
      type: 'string' as const,
      default: 'off',
      enum: ['off', 'afterDelay'],
    }
    const { container } = mountControl(enumSchema, 'afterDelay', 'afterDelay')
    fireEvent.click(container.querySelector('button')!)
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent)).toEqual(['off', 'afterDelay (default)'])
  })
})
