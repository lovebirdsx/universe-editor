import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
import { InboxGroups } from '../InboxGroups.js'

describe('InboxGroups trigger row', () => {
  it('shows the trigger badge and the verdict summary', () => {
    render(
      <InboxGroups
        sessions={[
          sessionSummary('s1', {
            automation: {
              triggerName: 'Swarm triage',
              verdict: 'escalate',
              summary: 'needs a human',
            },
          }),
        ]}
      />,
    )
    expect(screen.getByText('⚡ Swarm triage')).toBeTruthy()
    expect(screen.getByText('needs a human')).toBeTruthy()
  })

  it('omits the trigger line while the trigger has not reported yet', () => {
    render(
      <InboxGroups
        sessions={[sessionSummary('s1', { automation: { triggerName: 'Swarm triage' } })]}
      />,
    )
    expect(screen.getByText('⚡ Swarm triage')).toBeTruthy()
    expect(screen.queryByText('needs a human')).toBeNull()
  })

  it('omits the trigger line for manual sessions', () => {
    render(<InboxGroups sessions={[sessionSummary('s1')]} />)
    expect(screen.queryByText(/⚡/)).toBeNull()
  })
})
