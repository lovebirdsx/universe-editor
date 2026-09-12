/*---------------------------------------------------------------------------------------------
 *  Tests for the DOM-node gauge: which readings pay for a full document walk.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleDomGauges } from '../domHeapGauges.js'
import { readHeapGauges, setHeapGauge } from '../heapFlowCounters.js'
import { MemoryPressureLevel } from '../memoryPressureLevels.js'

type Doc = Parameters<typeof sampleDomGauges>[0]

const documentWith = (walk: () => { length: number }): Doc =>
  ({ getElementsByTagName: walk }) as unknown as Doc

describe('sampleDomGauges', () => {
  afterEach(() => setHeapGauge('domnodes', 0))

  it('records the node count for a reading taken under pressure', () => {
    sampleDomGauges(
      documentWith(() => ({ length: 1234 })),
      MemoryPressureLevel.Critical,
    )

    expect(readHeapGauges()).toEqual([{ name: 'domnodes', value: 1234 }])
  })

  it('does not walk the document for a normal reading', () => {
    // Normal readings are 30s apart and the walk is O(nodes), so charging it there would
    // put a recurring hitch on the main thread of every window — to produce a number that
    // is only ever read once something is already wrong.
    const walk = vi.fn(() => ({ length: 1234 }))
    sampleDomGauges(documentWith(walk), MemoryPressureLevel.Normal)

    expect(walk).not.toHaveBeenCalled()
    expect(readHeapGauges()).toEqual([])
  })
})
