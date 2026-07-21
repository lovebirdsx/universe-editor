import { describe, it, expect } from 'vitest'
import {
  parseReview,
  parseReviewList,
  parseReviewDetail,
  parseTransitions,
  parseComment,
  parseComments,
  parseCreatedReviewId,
} from '../swarm/swarmParser.js'

describe('swarmParser.parseReview', () => {
  it('parses a review with an object-map participants field', () => {
    const review = parseReview({
      id: 1234,
      state: 'needsReview',
      stateLabel: 'Needs Review',
      author: 'alice',
      description: 'Fix the widget\nlonger body here',
      requiredReviewers: ['dave'],
      participants: {
        bob: { vote: { value: 1, isRequired: false } },
        carol: { vote: { value: -1 } },
        dave: { vote: { value: 0, isRequired: true } },
      },
      comments: [5, 2],
      testStatus: 'pass',
      updated: 1_700_000_000,
    })
    expect(review).toBeDefined()
    expect(review!.id).toBe('1234')
    expect(review!.author).toBe('alice')
    expect(review!.description).toBe('Fix the widget')
    expect(review!.upVotes).toBe(1)
    expect(review!.downVotes).toBe(1)
    expect(review!.commentCount).toBe(5)
    expect(review!.openTaskCount).toBe(2)
    expect(review!.testStatus).toBe('pass')
    // Unix seconds → ms.
    expect(review!.updated).toBe(1_700_000_000_000)
  })

  it('returns undefined without an id', () => {
    expect(parseReview({ state: 'approved' })).toBeUndefined()
  })

  it('coerces unknown state to needsReview and unknown test status to none', () => {
    const review = parseReview({ id: '7', state: 'weird', testStatus: 'flaky' })
    expect(review!.state).toBe('needsReview')
    expect(review!.testStatus).toBe('none')
  })

  it('accepts already-millisecond timestamps unchanged', () => {
    const review = parseReview({ id: '7', updated: 1_700_000_000_000 })
    expect(review!.updated).toBe(1_700_000_000_000)
  })

  it('handles an array-of-usernames participants shape with requiredReviewers', () => {
    const review = parseReview({
      id: '9',
      participants: ['bob', 'dave'],
      requiredReviewers: ['dave'],
    })
    expect(review!.upVotes).toBe(0)
    expect(review!.downVotes).toBe(0)
  })

  it('derives stream from the latest version, stripping the leading //', () => {
    const review = parseReview({
      id: '10',
      versions: [
        { rev: 1, change: '100', stream: '//aki/branch_2.1' },
        { rev: 2, change: '105', stream: '//aki/branch_3.6' },
      ],
    })
    expect(review!.stream).toBe('aki/branch_3.6')
  })

  it('omits stream when absent (list shape has no versions)', () => {
    expect(parseReview({ id: '13' })!.stream).toBeUndefined()
    expect(parseReview({ id: '14', versions: [] })!.stream).toBeUndefined()
    expect(parseReview({ id: '15', versions: [{ rev: 1, change: '1' }] })!.stream).toBeUndefined()
  })
})

describe('swarmParser.parseReviewList', () => {
  it('parses a list response and lastSeen', () => {
    const { reviews, lastSeen } = parseReviewList({
      reviews: [{ id: '1' }, { id: '2' }, { notAReview: true }],
      lastSeen: 42,
    })
    expect(reviews.map((r) => r.id)).toEqual(['1', '2'])
    expect(lastSeen).toBe('42')
  })

  it('tolerates a missing reviews array', () => {
    expect(parseReviewList({}).reviews).toEqual([])
    expect(parseReviewList(undefined).lastSeen).toBeNull()
  })
})

describe('swarmParser.parseReviewDetail', () => {
  it('unwraps the review envelope and parses versions', () => {
    const detail = parseReviewDetail({
      review: {
        id: '1234',
        state: 'approved',
        author: 'alice',
        description: 'full\nbody',
        versions: [
          { rev: 1, change: '100', pending: true, time: 1_700_000_000 },
          {
            rev: 2,
            change: '105',
            archiveChange: '106',
            pending: false,
            time: 1_700_000_100,
          },
        ],
        participants: { bob: { vote: { value: 1 } } },
      },
    })
    expect(detail).toBeDefined()
    expect(detail!.description).toBe('full\nbody')
    expect(detail!.versions).toHaveLength(2)
    expect(detail!.versions[1]).toMatchObject({
      version: 2,
      change: '105',
      archiveChange: '106',
      pending: false,
    })
    expect(detail!.participants[0]).toMatchObject({ user: 'bob', vote: 1 })
  })

  it('parses the version stream and uses the real Swarm rev/difference key', () => {
    const detail = parseReviewDetail({
      review: {
        id: '2952448',
        versions: [
          { difference: 1, change: '2952454', stream: '//aki/branch_2.1', pending: true },
          { difference: 2, change: '2952679', stream: '//aki/branch_2.1', pending: false },
        ],
      },
    })
    expect(detail!.versions[0]).toMatchObject({ version: 1, stream: '//aki/branch_2.1' })
    expect(detail!.versions[1]!.version).toBe(2)
  })
})

describe('swarmParser.parseTransitions', () => {
  it('parses the state-key → label map form', () => {
    const t = parseTransitions({
      transitions: { needsReview: 'Needs Review', 'approved:commit': 'Approve and Commit' },
    })
    expect(t).toContainEqual({ state: 'needsReview', label: 'Needs Review' })
    expect(t).toContainEqual({ state: 'approved:commit', label: 'Approve and Commit' })
  })

  it('parses an array form', () => {
    const t = parseTransitions({
      transitions: ['rejected', { state: 'archived', label: 'Archive' }],
    })
    expect(t).toContainEqual({ state: 'rejected', label: 'rejected' })
    expect(t).toContainEqual({ state: 'archived', label: 'Archive' })
  })

  it('returns empty on missing transitions', () => {
    expect(parseTransitions({})).toEqual([])
  })
})

describe('swarmParser.parseComment(s)', () => {
  it('parses an inline comment with context', () => {
    const c = parseComment({
      id: '55',
      body: 'nit: rename',
      user: 'carol',
      taskState: 'open',
      time: 1_700_000_000,
      context: { file: '//depot/a.cpp', rightLine: 42, version: 2 },
    })
    expect(c).toMatchObject({
      id: '55',
      author: 'carol',
      taskState: 'open',
      context: { file: '//depot/a.cpp', rightLine: 42, version: 2 },
    })
  })

  it('drops context entirely for review-level comments', () => {
    const c = parseComment({ id: '1', body: 'lgtm', user: 'bob' })
    expect(c!.context).toBeUndefined()
    expect(c!.taskState).toBe('comment')
  })

  it('parses a comments envelope', () => {
    expect(parseComments({ comments: [{ id: '1', body: 'x' }] })).toHaveLength(1)
    expect(parseComments([{ id: '2', body: 'y' }])).toHaveLength(1)
  })
})

describe('swarmParser.parseCreatedReviewId', () => {
  it('reads the id from the review envelope', () => {
    expect(parseCreatedReviewId({ review: { id: 999 } })).toBe('999')
    expect(parseCreatedReviewId({ id: '888' })).toBe('888')
    expect(parseCreatedReviewId({})).toBeUndefined()
  })
})
