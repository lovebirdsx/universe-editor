/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GatewayProviderPicker — the shared "select a provider instance" control used
 *  by the Claude and Codex gateway credential forms. It lists the instances
 *  that can serve the agent's protocol (including via a model-level `protocol`
 *  override), offers a connectivity dot + "Test" probe (only on an explicit
 *  click, never from render), and delegates the derived-preview rendering to the
 *  caller via a render prop. A saved-but-now-incompatible selection stays
 *  visible in the dropdown with a warning rather than disappearing.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  IAiModelService,
  ICommandService,
  localize,
  providerKey,
  resolveModelBaseUrl,
  type AiProviderInstance,
  type AiProviderType,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { Button, Spinner } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  providerSupportsProtocol,
  resolveProviderRef,
} from '../../../shared/ai/providerDerivation.js'
import { ManageModelsAction } from '../../actions/aiActions.js'
import styles from './AgentSettingsEditor.module.css'

export interface ResolvedProvider {
  readonly instance: AiProviderInstance
  readonly type: AiProviderType
}

/** Which credential piece prevents the CLI derivation, if any. */
export function missingProviderPiece(
  instance: AiProviderInstance,
  type: AiProviderType,
): 'apiKey' | 'baseUrl' | undefined {
  if (instance.apiKey === undefined || instance.apiKey.trim() === '') return 'apiKey'
  const baseUrl = resolveModelBaseUrl(undefined, instance.baseUrl, type.defaultBaseUrl)
  if (baseUrl === undefined || baseUrl.trim() === '') return 'baseUrl'
  return undefined
}

type VerifyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

export function GatewayProviderPicker({
  providers,
  types,
  protocol,
  value,
  onChange,
  children,
}: {
  readonly providers: readonly AiProviderInstance[]
  readonly types: Readonly<Record<string, AiProviderType>>
  readonly protocol: AiWireProtocol
  readonly value: string
  readonly onChange: (ref: string) => void
  readonly children: (resolved: ResolvedProvider | undefined) => ReactNode
}) {
  const aiModel = useService(IAiModelService)
  const commands = useService(ICommandService)
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })

  const selectable = useMemo(
    () => providers.filter((p) => providerSupportsProtocol(p, types[p.type], protocol)),
    [providers, types, protocol],
  )

  // Resolve the saved ref against the full list — a selected instance that has
  // since become incompatible must stay visible, not vanish from the UI.
  const resolved = useMemo(
    () => (value ? resolveProviderRef(value, providers, types) : undefined),
    [value, providers, types],
  )

  const incompatible = useMemo(() => {
    if (resolved === undefined) return undefined
    return providerSupportsProtocol(resolved.instance, resolved.type, protocol)
      ? undefined
      : resolved
  }, [resolved, protocol])

  const options = useMemo(
    () => (incompatible ? [...selectable, incompatible.instance] : selectable),
    [selectable, incompatible],
  )

  useEffect(() => {
    setVerify({ kind: 'idle' })
  }, [value])

  const test = useCallback(() => {
    if (!resolved) return
    const { instance, type } = resolved
    const baseUrl = resolveModelBaseUrl(undefined, instance.baseUrl, type.defaultBaseUrl)
    setVerify({ kind: 'checking' })
    void aiModel
      .verifyProvider({
        type: instance.type,
        name: instance.name,
        protocol: type.protocol,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(instance.apiKey !== undefined ? { apiKey: instance.apiKey } : {}),
      })
      .then((result) => {
        setVerify(
          result.ok
            ? { kind: 'ok', modelCount: result.modelCount }
            : {
                kind: 'fail',
                error:
                  result.error ??
                  localize('agentSettings.auth.provider.verifyFail', 'Connection failed.'),
              },
        )
      })
  }, [resolved, aiModel])

  if (providers.length === 0) {
    return (
      <div className={styles['noProviders']}>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.provider.none',
            'No provider instances with a compatible protocol yet. Add one in the AI settings, then select it here.',
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void commands.executeCommand(ManageModelsAction.ID)}
        >
          {localize('agentSettings.auth.provider.add', 'Add a provider…')}
        </Button>
      </div>
    )
  }

  if (selectable.length === 0 && resolved === undefined) {
    return (
      <div className={styles['noProviders']}>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.provider.noneCompatible',
            'You have {count} provider instance(s), but none declares the {protocol} protocol. Adjust a type protocol or add a model with this protocol in the AI settings.',
            { count: providers.length, protocol },
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void commands.executeCommand(ManageModelsAction.ID)}
        >
          {localize('agentSettings.auth.provider.configure', 'Open AI settings…')}
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className={styles['providerPickerRow']}>
        <select
          className={styles['providerSelect']}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {localize('agentSettings.auth.form.provider.none', 'Select a provider…')}
          </option>
          {options.map((p) => {
            const key = providerKey(p)
            const isIncompatible =
              incompatible !== undefined && key === providerKey(incompatible.instance)
            return (
              <option key={key} value={key}>
                {p.label ?? p.name}
                {isIncompatible
                  ? ` (${localize('agentSettings.auth.provider.incompatibleOption', 'incompatible')})`
                  : ''}
              </option>
            )
          })}
        </select>
        <VerifyDot state={verify} />
        <Button
          size="sm"
          variant="ghost"
          busy={verify.kind === 'checking'}
          disabled={resolved === undefined}
          onClick={test}
        >
          {localize('agentSettings.auth.provider.test', 'Test')}
        </Button>
      </div>
      {incompatible !== undefined ? (
        <div className={styles['deriveError']}>
          {localize(
            'agentSettings.auth.provider.incompatible',
            'This provider instance does not declare the {protocol} protocol. Adjust its type protocol or add a model with this protocol in the AI settings.',
            { protocol },
          )}
        </div>
      ) : (
        children(resolved)
      )}
    </>
  )
}

/** Error shown when a provider can't produce a CLI credential (missing key or URL). */
export function DerivationError({ missing }: { readonly missing: 'apiKey' | 'baseUrl' }) {
  const message =
    missing === 'apiKey'
      ? localize(
          'agentSettings.auth.provider.missingApiKey',
          'This provider has no API key. Set it in the AI settings (Model configuration → Provider Instances).',
        )
      : localize(
          'agentSettings.auth.provider.missingBaseUrl',
          'This provider has no base URL. Set it in the AI settings (Model configuration → Provider Instances).',
        )
  return <div className={styles['deriveError']}>{message}</div>
}

function VerifyDot({ state }: { readonly state: VerifyState }) {
  if (state.kind === 'checking') {
    return (
      <span
        className={styles['verifyDotWrap']}
        data-tooltip={localize('agentSettings.auth.provider.checking', 'Checking…')}
      >
        <Spinner size={11} />
      </span>
    )
  }
  const info =
    state.kind === 'ok'
      ? {
          className: styles['verifyDotOk'],
          tooltip: localize('agentSettings.auth.provider.ok', 'Connected · {count} models', {
            count: state.modelCount,
          }),
        }
      : state.kind === 'fail'
        ? { className: styles['verifyDotFail'], tooltip: state.error }
        : {
            className: styles['verifyDotIdle'],
            tooltip: localize('agentSettings.auth.provider.idle', 'Not tested'),
          }
  return (
    <span
      className={`${styles['verifyDot'] ?? ''} ${info.className ?? ''}`}
      data-tooltip={info.tooltip}
      data-status={state.kind}
      role="img"
      aria-label={info.tooltip}
    />
  )
}
