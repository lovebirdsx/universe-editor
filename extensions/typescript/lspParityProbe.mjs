/**
 * Standalone parity probe: spawn a TS language server over stdio and exercise
 * the same LSP surface our plugin uses, printing what the server supports.
 * Usage:
 *   node scripts/lspParityProbe.mjs native   # tsgo --lsp --stdio
 *   node scripts/lspParityProbe.mjs tsls     # vendored typescript-language-server
 */
import { spawn } from 'node:child_process'
import { realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js'

const mode = process.argv[2] ?? 'native'

function resolveTsgo() {
  const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`
  const previewPkg = realpathSync(
    createRequire(import.meta.url).resolve('@typescript/native-preview/package.json'),
  )
  const pj = createRequire(previewPkg).resolve(`${platformPackage}/package.json`)
  return path.join(path.dirname(pj), 'lib', process.platform === 'win32' ? 'tsgo.exe' : 'tsgo')
}

const vendorCli = path.resolve(
  '../../vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
)

const proc =
  mode === 'native'
    ? spawn(resolveTsgo(), ['--lsp', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, [vendorCli, '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })

proc.stderr.on('data', (b) => console.error(`[server-stderr] ${b.toString('utf8').slice(0, 300)}`))
proc.on('exit', (c, s) => console.error(`[server-exit] code=${c} signal=${s}`))

const conn = createMessageConnection(
  new StreamMessageReader(proc.stdout),
  new StreamMessageWriter(proc.stdin),
)
conn.onRequest('window/workDoneProgress/create', () => null)
conn.onRequest('workspace/codeLens/refresh', () => {
  console.log('<< workspace/codeLens/refresh')
  return null
})
conn.onNotification('$/progress', (p) => {
  if (p.value?.kind === 'begin') console.log(`<< progress begin title=${JSON.stringify(p.value.title)}`)
})
const diags = []
conn.onNotification('textDocument/publishDiagnostics', (p) => diags.push(p))
conn.listen()

// Sample workspace: a.ts exports a symbol referenced twice from b.ts.
const ws = path.resolve('out/lsp-parity-ws')
mkdirSync(ws, { recursive: true })
writeFileSync(path.join(ws, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
writeFileSync(path.join(ws, 'a.ts'), 'export function target(): number {\n  return 42\n}\n')
writeFileSync(
  path.join(ws, 'b.ts'),
  "import { target } from './a'\n\nconst x = target()\nconst y = target()\nconst err: string = 1\nconsole.log(x, y, err)\n",
)
const uriB = pathToFileURL(path.join(ws, 'b.ts')).toString()
const rootUri = pathToFileURL(ws).toString()

const init = await conn.sendRequest('initialize', {
  processId: process.pid,
  rootUri,
  workspaceFolders: [{ uri: rootUri, name: 'ws' }],
  capabilities: {
    textDocument: {
      synchronization: { dynamicRegistration: false },
      completion: { completionItem: { snippetSupport: true }, contextSupport: true },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      definition: { linkSupport: true },
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      rename: { prepareSupport: true },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      codeLens: {},
      semanticTokens: { requests: { full: true }, formats: ['relative'], tokenTypes: [], tokenModifiers: [] },
    },
    workspace: { workspaceFolders: true, symbol: {}, codeLens: { refreshSupport: true } },
    window: { workDoneProgress: true },
  },
})
const caps = init?.capabilities ?? {}
console.log('== capabilities ==')
for (const k of [
  'definitionProvider', 'referencesProvider', 'hoverProvider', 'completionProvider',
  'documentSymbolProvider', 'workspaceSymbolProvider', 'renameProvider',
  'implementationProvider', 'typeDefinitionProvider', 'signatureHelpProvider',
  'codeLensProvider', 'semanticTokensProvider',
]) {
  console.log(`  ${k}: ${JSON.stringify(caps[k])}`)
}

await conn.sendNotification('initialized', {})
await conn.sendNotification('workspace/didChangeConfiguration', {
  settings: {
    typescript: { referencesCodeLens: { enabled: true, showOnAllFunctions: false } },
    javascript: { referencesCodeLens: { enabled: true, showOnAllFunctions: false } },
  },
})

const textB = "import { target } from './a'\n\nconst x = target()\nconst y = target()\nconst err: string = 1\nconsole.log(x, y, err)\n"
await conn.sendNotification('textDocument/didOpen', {
  textDocument: { uri: uriB, languageId: 'typescript', version: 1, text: textB },
})

// Give the server a moment to build the project, then poll codeLens until the
// project is warm (the native server doesn't report load progress).
await new Promise((r) => setTimeout(r, 4000))
for (let i = 0; i < 10; i++) {
  const lenses = await conn.sendRequest('textDocument/codeLens', { textDocument: { uri: uriB } })
  if (Array.isArray(lenses) && lenses.length > 0) break
  await new Promise((r) => setTimeout(r, 500))
}

const pos = { line: 2, character: 10 } // first target() call (0-based)
const doc = { textDocument: { uri: uriB } }
async function probe(name, method, params) {
  try {
    const t0 = Date.now()
    const res = await conn.sendRequest(method, params)
    const summary =
      res == null ? 'null'
      : Array.isArray(res) ? `array(${res.length})`
      : typeof res === 'object' ? `object keys=${Object.keys(res).join(',')}` : String(res)
    console.log(`${name}: OK ${summary} (${Date.now() - t0}ms)`)
    return res
  } catch (err) {
    console.log(`${name}: FAIL ${err.message}`)
    return undefined
  }
}

await probe('hover', 'textDocument/hover', { ...doc, position: pos })
await probe('definition', 'textDocument/definition', { ...doc, position: pos })
await probe('references', 'textDocument/references', { ...doc, position: pos, context: { includeDeclaration: true } })
await probe('completion', 'textDocument/completion', { ...doc, position: { line: 5, character: 8 }, context: { triggerKind: 1 } })
await probe('documentSymbol', 'textDocument/documentSymbol', doc)
await probe('workspaceSymbol', 'workspace/symbol', { query: 'target' })
await probe('semanticTokens', 'textDocument/semanticTokens/full', doc)
const lenses = await probe('codeLens', 'textDocument/codeLens', doc)
if (Array.isArray(lenses) && lenses[0]) {
  const resolved = await probe('codeLens/resolve', 'codeLens/resolve', lenses[0])
  console.log(`  resolved lens command: ${JSON.stringify(resolved?.command)}`)
} else {
  console.log(`  raw lenses: ${JSON.stringify(lenses)}`)
}
await probe('rename', 'textDocument/rename', { ...doc, position: pos, newName: 'renamed' })
if (caps.diagnosticProvider) {
  const report = await probe('diagnostic (pull)', 'textDocument/diagnostic', {
    textDocument: { uri: uriB },
    identifier: 'typescript',
  })
  console.log(`  pull items: ${JSON.stringify(report?.items?.map((d) => d.message))}`)
}
await new Promise((r) => setTimeout(r, 1500))
console.log(`diagnostics (push): ${JSON.stringify(diags.map((d) => d.diagnostics?.map((x) => x.message)))}`)

proc.stdin.end()
setTimeout(() => proc.kill(), 1000).unref()
await new Promise((r) => setTimeout(r, 500))
process.exit(0)
