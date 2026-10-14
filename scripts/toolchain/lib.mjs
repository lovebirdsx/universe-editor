/*---------------------------------------------------------------------------------------------
 *  template-smoke 的纯逻辑（可单测）：SDK 依赖闭包、本地化改写、安装来源断言。
 *  独立成模块是因为 template-smoke.mjs 顶层直接执行 main()，import 它会真跑一遍冒烟。
 *--------------------------------------------------------------------------------------------*/

const SCOPE = '@universe-editor/'

/** 消费者安装树里的运行期依赖桶。 */
const RUNTIME_BUCKETS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/** 加上扩展项目声明依赖用的桶：模板把 SDK 包全放在 devDependencies（扩展产物不进 node_modules）。 */
const DECLARED_BUCKETS = [...RUNTIME_BUCKETS, 'devDependencies']

/** '@universe-editor/uex' -> 'uex'；非本 scope 返回 null。 */
export function sdkShortName(pkgName) {
  return pkgName.startsWith(SCOPE) ? pkgName.slice(SCOPE.length) : null
}

/**
 * manifest 依赖里的 @universe-editor/* 包名（去重）。includeDev 用于取消费者项目的根依赖；
 * 传递展开必须留 false，否则 e2e-harness 的 config-ts/temp-root 这类构建期工具会被当成闭包成员。
 */
export function sdkDepNames(manifest, { includeDev = false } = {}) {
  const buckets = includeDev ? DECLARED_BUCKETS : RUNTIME_BUCKETS
  const names = new Set()
  for (const bucket of buckets) {
    for (const name of Object.keys(manifest[bucket] ?? {})) {
      if (name.startsWith(SCOPE)) names.add(name)
    }
  }
  return [...names]
}

/**
 * roots 沿 SDK 包运行期依赖边递归展开。closure 按 sdkOrder 输出（调用方传发布拓扑序）。
 * errors 非空 = 出现无法本地化的 @universe-editor/* 依赖，冒烟必然退回 registry。
 */
export function computeSdkClosure({ roots, manifests, sdkOrder }) {
  const known = new Set(sdkOrder)
  const errors = []
  const reported = new Set()
  const seen = new Set()
  const fail = (short, message) => {
    if (reported.has(short)) return
    reported.add(short)
    errors.push(message)
  }
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()
    const short = sdkShortName(name)
    if (short === null || seen.has(short)) continue
    if (!known.has(short)) {
      fail(short, `${name} 不在 SDK 发布集合里，冒烟无法本地化它（见 scripts/lib/sdk-packages.mjs）`)
      continue
    }
    const manifest = manifests.get(short)
    if (!manifest) {
      fail(short, `缺少 packages/${short}/package.json，无法展开依赖闭包`)
      continue
    }
    seen.add(short)
    queue.push(...sdkDepNames(manifest))
  }
  return { closure: sdkOrder.filter((short) => seen.has(short)), errors }
}

/**
 * 把闭包成员指向本地 tarball：已声明的改写 spec，未声明的补进 devDependencies（传递依赖也要
 * 落到顶层，npm 才会复用本地副本而不是去 registry 取）。同名包出现在多个桶时全部改写 ——
 * npm 对重复声明的取舍规则与桶顺序无关，只改一个会留下旧 range 被 npm 选中。
 */
export function localizeSdkDeps(manifest, closure, tarballsByShort) {
  const added = []
  const rewritten = []
  const missing = []
  for (const short of closure) {
    const tarball = tarballsByShort[short]
    if (!tarball) {
      missing.push(short)
      continue
    }
    const name = SCOPE + short
    const buckets = DECLARED_BUCKETS.filter((b) => manifest[b]?.[name] !== undefined)
    if (buckets.length === 0) {
      manifest.devDependencies ??= {}
      manifest.devDependencies[name] = `file:${tarball}`
      added.push(short)
      continue
    }
    for (const bucket of buckets) manifest[bucket][name] = `file:${tarball}`
    rewritten.push(short)
  }
  return { added, rewritten, missing }
}

/**
 * 安装后证明树里每个 @universe-editor/* 都来自本地 tarball。同版本但 resolved 指向 registry
 * 就是假绿（本地改了没发时，冒烟跑的是 registry 上的旧副本），必须报出来。
 * lockPackages 是 package-lock.json 的 packages 映射，键即安装路径，天然覆盖 hoist 与嵌套副本。
 * 期望的包在映射里一个都没出现时同样报错（如 lockfileVersion 1 没有 packages 映射）——
 * 证据缺失不能当作证据成立。
 */
export function findNonLocalSdkInstalls(lockPackages, expectedVersionsByName) {
  const issues = []
  const seen = new Set()
  for (const [installPath, entry] of Object.entries(lockPackages)) {
    const match = /(?:^|\/)node_modules\/@universe-editor\/([^/]+)$/.exec(installPath)
    if (!match) continue
    const name = SCOPE + match[1]
    seen.add(name)
    const expected = expectedVersionsByName.get(name)
    if (expected === undefined) {
      issues.push(`${installPath}: 闭包外的 @universe-editor 副本（依赖没被本地化）`)
    } else if (entry?.version !== expected) {
      issues.push(`${name} 装的是 ${entry?.version}，本地待发布版本是 ${expected} —— 解析到了 registry 副本`)
    } else if (typeof entry?.resolved !== 'string' || !entry.resolved.startsWith('file:')) {
      issues.push(`${name}@${expected} 的 resolved 是 ${entry?.resolved ?? '(缺失)'}，不是本地 tarball —— 同版本不同内容即假绿`)
    }
  }
  for (const name of expectedVersionsByName.keys()) {
    if (!seen.has(name)) {
      issues.push(`package-lock 里没有 ${name} 的记录 —— 无法证明它来自本地 tarball`)
    }
  }
  return issues
}
