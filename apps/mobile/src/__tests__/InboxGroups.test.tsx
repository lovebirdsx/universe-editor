import type { MobileSessionBucket, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { groupSessions } from '../inbox/groupSessions.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { strings } from '../strings.js'

function session(
  localId: string,
  bucket: MobileSessionBucket,
  title: string,
): MobileSessionSummary {
  return {
    ref: { windowId: 1, localId },
    agentId: 'claude',
    title,
    status: 'running',
    displayStatus: bucket === 'in_progress' ? 'working' : bucket,
    bucket,
    workspaceName: 'demo-workspace',
    readOnly: false,
    hasPendingPermission: false,
    hasPendingElicitation: false,
    backgroundTaskCount: 0,
    updatedAt: Date.now(),
  }
}

describe('InboxGroups', () => {
  it('orders buckets by urgency and renders each session', () => {
    render(
      <InboxGroups
        sessions={[
          session('done', 'completed', 'Finished task'),
          session('failed', 'failed', 'Broken task'),
          session('running', 'in_progress', 'Running task'),
          session('ask', 'input_needed', 'Needs approval'),
        ]}
      />,
    )

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings).toEqual([
      `${strings.bucketInputNeeded}1`,
      `${strings.bucketInProgress}1`,
      `${strings.bucketFailed}1`,
      `${strings.bucketCompleted}1`,
    ])
    expect(screen.getByText('Needs approval')).toBeTruthy()
    expect(screen.getByText('Broken task')).toBeTruthy()
    expect(screen.getByText('Running task')).toBeTruthy()
    expect(screen.getByText('Finished task')).toBeTruthy()
  })

  it('omits empty buckets', () => {
    render(<InboxGroups sessions={[session('ask', 'input_needed', 'Needs approval')]} />)
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings).toEqual([`${strings.bucketInputNeeded}1`])
  })

  it('renders nothing for an empty inbox', () => {
    const { container } = render(<InboxGroups sessions={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('groupSessions returns no groups for an empty list', () => {
    expect(groupSessions([])).toEqual([])
  })
})
