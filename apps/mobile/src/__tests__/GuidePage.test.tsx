import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guessDevice, type PairRequestResult } from '../pairing.js'
import { GuidePage } from '../pages/GuidePage.js'
import { strings } from '../strings.js'
import {
  createPairingStoreHarness,
  failingPairRequester,
  successfulPairRequester,
} from '../test/fakes.js'

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('GuidePage', () => {
  it('shows the guide copy and an inline pairing form', () => {
    const store = createPairingStoreHarness()

    render(<GuidePage store={store.store} onPaired={vi.fn()} onDismissNotice={vi.fn()} />)

    expect(screen.getByText(strings.guideTitle)).toBeDefined()
    expect(screen.getByText(strings.guideBody)).toBeDefined()
    expect(screen.getByText(strings.guideHint)).toBeDefined()
    expect(screen.getByText(strings.guidePairTitle)).toBeDefined()

    const codeInput = screen.getByLabelText(strings.pairCodeLabel) as HTMLInputElement
    const nameInput = screen.getByLabelText(strings.pairDeviceNameLabel) as HTMLInputElement
    expect(codeInput.value).toBe('')
    expect(nameInput.value).toBe(guessDevice(navigator.userAgent).deviceName)
    expect(screen.getByText(strings.pairCodeHint)).toBeDefined()
    expect(screen.queryByTestId('pair-certificate')).toBeNull()
  })

  it('pairs from the guide page and clears a stale deep link', async () => {
    window.history.replaceState(null, '', '/s/stale')
    const store = createPairingStoreHarness()
    const onPaired = vi.fn()
    const requester = successfulPairRequester()

    render(
      <GuidePage
        store={store.store}
        onPaired={onPaired}
        onDismissNotice={vi.fn()}
        pairRequest={requester}
      />,
    )

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
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
    expect(store.saveCalls()).toBe(1)
    expect(onPaired.mock.calls[0]?.[0]).toMatchObject({
      deviceId: 'device-12345678',
      token: 'token-value',
      pcName: 'PC-A',
      deviceName: '我的手机',
    })
    expect(onPaired.mock.calls[0]?.[1]).toEqual({ persisted: true })
    expect(window.location.pathname).toBe('/')
  })

  it('forwards a storage fallback result to the caller', async () => {
    const store = createPairingStoreHarness({ persisted: false })
    const onPaired = vi.fn()

    render(
      <GuidePage
        store={store.store}
        onPaired={onPaired}
        onDismissNotice={vi.fn()}
        pairRequest={successfulPairRequester()}
      />,
    )

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'ABCD2345' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
    expect(onPaired.mock.calls[0]?.[1]).toEqual({ persisted: false })
  })

  it('maps gateway failures to Chinese copy', async () => {
    const store = createPairingStoreHarness()
    const onPaired = vi.fn()

    render(
      <GuidePage
        store={store.store}
        onPaired={onPaired}
        onDismissNotice={vi.fn()}
        pairRequest={failingPairRequester('rate_limited')}
      />,
    )

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'ABCD2345' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(strings.pairErrorRateLimited)
    expect(store.saveCalls()).toBe(0)
    expect(onPaired).not.toHaveBeenCalled()
  })

  it('rejects a malformed code before calling the gateway', async () => {
    const requester = successfulPairRequester()

    render(
      <GuidePage
        store={createPairingStoreHarness().store}
        onPaired={vi.fn()}
        onDismissNotice={vi.fn()}
        pairRequest={requester}
      />,
    )

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'ABCD' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(strings.pairInvalidCode)
    expect(requester).not.toHaveBeenCalled()
  })

  it('disables the form while pairing', async () => {
    let resolveRequest: ((result: PairRequestResult) => void) | undefined
    const requester = vi.fn(
      () =>
        new Promise<PairRequestResult>((resolve) => {
          resolveRequest = resolve
        }),
    )
    const onPaired = vi.fn()

    render(
      <GuidePage
        store={createPairingStoreHarness().store}
        onPaired={onPaired}
        onDismissNotice={vi.fn()}
        pairRequest={requester}
      />,
    )

    fireEvent.change(screen.getByLabelText(strings.pairCodeLabel), {
      target: { value: 'ABCD2345' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.pairSubmit }))

    const submit = screen.getByRole('button', {
      name: strings.pairSubmitting,
    }) as HTMLButtonElement
    const codeInput = screen.getByLabelText(strings.pairCodeLabel) as HTMLInputElement
    const nameInput = screen.getByLabelText(strings.pairDeviceNameLabel) as HTMLInputElement
    expect(submit.disabled).toBe(true)
    expect(codeInput.disabled).toBe(true)
    expect(nameInput.disabled).toBe(true)

    resolveRequest?.({
      ok: true,
      response: {
        deviceId: 'device-12345678',
        token: 'token-value',
        pcName: 'PC-A',
        protocolVersion: 1,
      },
    })
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
  })

  it('shows and dismisses a notice', () => {
    const onDismissNotice = vi.fn()

    render(
      <GuidePage
        store={createPairingStoreHarness().store}
        onPaired={vi.fn()}
        notice={strings.pairStorageUnavailable}
        onDismissNotice={onDismissNotice}
      />,
    )

    expect(screen.getByRole('status').textContent).toContain(strings.pairStorageUnavailable)
    fireEvent.click(screen.getByRole('button', { name: strings.noticeDismiss }))
    expect(onDismissNotice).toHaveBeenCalledTimes(1)
  })
})
