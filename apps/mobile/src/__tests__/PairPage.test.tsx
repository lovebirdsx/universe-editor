import type { PairRequest } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialStore, StoredCredentials } from '../credentials.js'
import { guessDevice, type PairRequestResult } from '../pairing.js'
import { PairPage } from '../pages/PairPage.js'
import { strings } from '../strings.js'

interface StoreHarness {
  readonly store: CredentialStore
  readonly saved: () => StoredCredentials | undefined
  readonly saveCalls: () => number
}

function createStore(): StoreHarness {
  let stored: StoredCredentials | undefined
  let saves = 0
  return {
    store: {
      async load() {
        return stored
      },
      async save(credentials) {
        stored = credentials
        saves += 1
        return { persisted: true }
      },
      async clear() {
        stored = undefined
      },
    },
    saved: () => stored,
    saveCalls: () => saves,
  }
}

function successfulRequester() {
  return vi.fn(
    async (_input: PairRequest): Promise<PairRequestResult> => ({
      ok: true,
      response: {
        deviceId: 'device-12345678',
        token: 'token-value',
        pcName: 'PC-A',
        protocolVersion: 1,
      },
    }),
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/pair')
})

describe('PairPage', () => {
  it('reads the code from the fragment, pairs, and clears the hash', async () => {
    window.history.replaceState(null, '', '/pair#code=ABCD2345')
    const store = createStore()
    const onPaired = vi.fn()
    const requester = successfulRequester()

    render(<PairPage store={store.store} onPaired={onPaired} pairRequest={requester} />)

    const codeInput = screen.getByLabelText(strings.pairCodeLabel) as HTMLInputElement
    const nameInput = screen.getByLabelText(strings.pairDeviceNameLabel) as HTMLInputElement
    expect(codeInput.value).toBe('ABCD2345')
    expect(nameInput.value).not.toBe('')

    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    await waitFor(() => expect(requester).toHaveBeenCalledTimes(1))
    expect(requester.mock.calls[0]?.[0]).toEqual({
      code: 'ABCD2345',
      deviceName: nameInput.value,
      platform: guessDevice(navigator.userAgent).platform,
    })
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
    expect(store.saveCalls()).toBe(1)
    expect(store.saved()).toMatchObject({
      deviceId: 'device-12345678',
      token: 'token-value',
      pcName: 'PC-A',
    })
    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('')
  })

  it('accepts a manually typed code', async () => {
    const store = createStore()
    const onPaired = vi.fn()
    const requester = successfulRequester()

    render(<PairPage store={store.store} onPaired={onPaired} pairRequest={requester} />)

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'abcd-2345' },
    })
    fireEvent.change(screen.getByLabelText(strings.pairDeviceNameLabel), {
      target: { value: '  我的手机  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    await waitFor(() => expect(requester).toHaveBeenCalledTimes(1))
    expect(requester.mock.calls[0]?.[0]).toEqual({
      code: 'ABCD2345',
      deviceName: '我的手机',
      platform: guessDevice(navigator.userAgent).platform,
    })
  })

  it('shows the certificate fingerprint from the pairing link', () => {
    const fingerprint = '00112233445566778899aabbccddeeff'.repeat(2)
    window.history.replaceState(null, '', `/pair#code=ABCD2345&fp=${fingerprint}`)

    render(<PairPage store={createStore().store} onPaired={vi.fn()} pairRequest={vi.fn()} />)

    const block = screen.getByTestId('pair-certificate')
    expect(block.textContent).toContain(strings.pairCertTitle)
    expect(block.textContent).toContain('00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF')
  })

  it('does not show a certificate block when the link has no fingerprint', () => {
    window.history.replaceState(null, '', '/pair#code=ABCD2345')
    render(<PairPage store={createStore().store} onPaired={vi.fn()} pairRequest={vi.fn()} />)
    expect(screen.queryByTestId('pair-certificate')).toBeNull()
  })

  it('rejects a malformed code before calling the gateway', async () => {
    const store = createStore()
    const requester = successfulRequester()

    render(<PairPage store={store.store} onPaired={vi.fn()} pairRequest={requester} />)

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'ABCD' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(strings.pairInvalidCode)
    expect(requester).not.toHaveBeenCalled()
  })

  it('maps gateway failures to Chinese copy', async () => {
    window.history.replaceState(null, '', '/pair#code=ABCD2345')
    const store = createStore()
    const requester = vi.fn(
      async (_input: PairRequest): Promise<PairRequestResult> => ({
        ok: false,
        code: 'rate_limited',
        network: false,
      }),
    )

    render(<PairPage store={store.store} onPaired={vi.fn()} pairRequest={requester} />)
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(strings.pairErrorRateLimited)
    expect(store.saveCalls()).toBe(0)
  })
})
