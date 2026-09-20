import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const before =
  '    const actions = await this.codeActionsManager.provideCodeActions(document, params.range, params.context, token);'
const after = `    const version = document.version;
${before}
    // 等待诊断时文档可能已被撤销、关闭或重开，原 range 不再有效。
    if (token.isCancellationRequested || document.version !== version || this.tsClient.toOpenDocument(params.textDocument.uri) !== document) {
      this.logger.log('Discarding stale codeAction', document.uri, version, document.version, params.range);
      return [];
    }`

export function patchCodeAction(source) {
  if (source.split(after).length === 2) return source
  if (source.includes("'Discarding stale codeAction'")) {
    throw new Error('TSLS 已有不同版本补丁，请重新运行 npm ci')
  }
  if (source.split(before).length !== 2) {
    throw new Error('TSLS codeAction 补丁锚点不唯一或已变化，请检查上游实现')
  }
  return source.replace(before, after)
}

export function applyPatch() {
  const cli = new URL('./node_modules/typescript-language-server/lib/cli.mjs', import.meta.url)
  const source = readFileSync(cli, 'utf8')
  const patched = patchCodeAction(source)
  if (patched !== source) {
    writeFileSync(cli, patched)
    console.log('[tsls-patch] 已添加 codeAction 文档版本守卫')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) applyPatch()
