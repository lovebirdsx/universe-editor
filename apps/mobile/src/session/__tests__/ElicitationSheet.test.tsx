import type { MobilePendingElicitation } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import {
  ElicitationSheet,
  buildContent,
  initialValues,
  validateFields,
  type ElicitationFieldValue,
} from '../ElicitationSheet.js'

function createClient() {
  return { resolveElicitation: vi.fn(async () => undefined) }
}

function formElicitation(
  overrides: Partial<MobilePendingElicitation> = {},
): MobilePendingElicitation {
  return {
    requestId: 'elicit-1',
    mode: 'form',
    message: 'Configure the run',
    fields: [
      { name: 'branch', title: 'Branch', required: true, kind: 'string' },
      { name: 'count', title: 'Count', required: true, kind: 'number', integer: true, minimum: 1 },
      { name: 'dryRun', title: 'Dry run', required: false, kind: 'boolean' },
      {
        name: 'level',
        title: 'Level',
        required: true,
        kind: 'enum',
        options: [
          { value: 'low', title: 'Low' },
          { value: 'high', title: 'High' },
        ],
      },
      {
        name: 'tags',
        title: 'Tags',
        required: false,
        kind: 'enum-multi',
        options: [
          { value: 'a', title: 'Tag A' },
          { value: 'b', title: 'Tag B' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('ElicitationSheet', () => {
  it('validates required fields before accepting', () => {
    const client = createClient()
    render(
      <ElicitationSheet
        client={client}
        elicitation={formElicitation()}
        online
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('elicitation-accept'))
    expect(screen.getAllByText(strings.elicitationRequired).length).toBeGreaterThanOrEqual(3)
    expect(client.resolveElicitation).not.toHaveBeenCalled()
  })

  it('submits typed form values with the right payload types', async () => {
    const client = createClient()
    render(
      <ElicitationSheet
        client={client}
        elicitation={formElicitation()}
        online
        onNotice={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText(/Branch/), { target: { value: 'main' } })
    fireEvent.change(screen.getByLabelText(/Count/), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText(/Level/), { target: { value: 'high' } })
    fireEvent.click(screen.getByLabelText('Tag B'))

    fireEvent.click(screen.getByTestId('elicitation-accept'))

    await waitFor(() =>
      expect(client.resolveElicitation).toHaveBeenCalledWith('elicit-1', 'accept', {
        branch: 'main',
        count: 3,
        dryRun: true,
        level: 'high',
        tags: ['b'],
      }),
    )
  })

  it('sends decline and cancel without content', async () => {
    const client = createClient()
    render(
      <ElicitationSheet
        client={client}
        elicitation={formElicitation()}
        online
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText(strings.elicitationDecline))
    await waitFor(() =>
      expect(client.resolveElicitation).toHaveBeenCalledWith('elicit-1', 'decline', undefined),
    )
  })

  it('renders URL mode as text and never opens the link', () => {
    const client = createClient()
    render(
      <ElicitationSheet
        client={client}
        elicitation={{
          requestId: 'elicit-2',
          mode: 'url',
          message: 'Authorize in the browser',
          url: 'https://example.com/authorize',
        }}
        online
        onNotice={vi.fn()}
      />,
    )

    expect(screen.getByText('https://example.com/authorize')).toBeTruthy()
    expect(screen.getByText(strings.elicitationUrlHint)).toBeTruthy()
    expect(screen.queryByTestId('elicitation-accept')).toBeNull()
    expect(screen.getByText(strings.elicitationDecline)).toBeTruthy()
  })
})

describe('elicitation helpers', () => {
  const fields = formElicitation().fields!

  it('validates number bounds and multi-select limits', () => {
    const values: Record<string, ElicitationFieldValue> = {
      branch: 'main',
      count: '0',
      dryRun: false,
      level: 'low',
      tags: [],
    }
    const errors = validateFields(fields, values)
    expect(errors['count']).toBe(strings.elicitationNumberTooSmall(1))
  })

  it('applies defaults to the initial values', () => {
    const values = initialValues([
      { name: 'title', required: false, kind: 'string', default: 'hello' },
      { name: 'enabled', required: false, kind: 'boolean', default: true },
      {
        name: 'selected',
        required: false,
        kind: 'enum-multi',
        options: [{ value: 'x', title: 'X' }],
        default: ['x'],
      },
    ])
    expect(values).toEqual({ title: 'hello', enabled: true, selected: ['x'] })
  })

  it('omits empty optional values from the accepted payload', () => {
    const content = buildContent(fields, {
      branch: ' main ',
      count: '2',
      dryRun: false,
      level: 'low',
      tags: [],
    })
    expect(content).toEqual({ branch: 'main', count: 2, dryRun: false, level: 'low' })
  })
})
