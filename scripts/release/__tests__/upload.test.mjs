/*---------------------------------------------------------------------------------------------
 *  Tests for upload.mjs pure helpers. Run with `node --test`.
 *
 *  The upload order is the safety property that matters: installers first, the release-notes
 *  bundle next, latest.yml LAST — autoUpdater reads that manifest, so it may only be replaced
 *  once every file it can point at has landed.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  assertPlanConsistency,
  buildRemoteListCommand,
  buildRemoteMkdirCommand,
  buildRemoteProbeCommand,
  buildRemoteReplaceCommand,
  buildRemoteReplaceFallback,
  buildUploadPlan,
  classifyReleaseDir,
  createCaptureRunner,
  createExecutor,
  createRunner,
  isNotePagePath,
  listRemoteNoteNames,
  loadUploadBundle,
  orderNotesFiles,
  parseArgs,
  parseRemoteNoteNames,
  remoteDirs,
  resolveNotesUpload,
  resolveUploadConfig,
  runUploadPlan,
  tempRemotePath,
} from '../upload.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('parseArgs reads flags and values', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--no-mkdir']), { dryRun: true, mkdir: false })
  assert.deepEqual(parseArgs(['--host', '192.0.2.10', '--dir', '/srv/x']), {
    host: '192.0.2.10',
    dir: '/srv/x',
  })
  // A flag followed by another flag stays boolean.
  assert.deepEqual(parseArgs(['--host', '--dry-run']), { host: true, dryRun: true })
  // pnpm forwards the `--` separator verbatim (pnpm 11); it must not become a key.
  assert.deepEqual(parseArgs(['--', '--dry-run']), { dryRun: true })
})

test('resolveUploadConfig merges env, strips trailing separators and lists what is missing', () => {
  const fromEnv = resolveUploadConfig(
    {},
    { UE_RELEASE_HOST: '192.0.2.10', UE_RELEASE_USER: 'deploy', UE_RELEASE_DIR: 'D:\\site\\' },
  )
  assert.deepEqual(fromEnv.missing, [])
  assert.equal(fromEnv.config.dir, 'D:\\site')
  assert.equal(fromEnv.config.port, '22')
  assert.equal(fromEnv.isWindowsTarget, true)

  const missing = resolveUploadConfig({}, {})
  assert.equal(missing.missing.length, 3)
  assert.match(missing.missing[0], /--host/)

  // Explicit CLI wins over env, and --remote-os overrides path sniffing.
  const cli = resolveUploadConfig(
    { host: 'example.com', 'remote-os': 'linux' },
    { UE_RELEASE_HOST: '192.0.2.10', UE_RELEASE_DIR: '/srv/site' },
  )
  assert.equal(cli.config.host, 'example.com')
  assert.equal(cli.isWindowsTarget, false)
  assert.equal(resolveUploadConfig({ dir: 'X:/site' }, {}).isWindowsTarget, true)
})

test('classifyReleaseDir splits payloads from the manifest in a stable order', () => {
  const { payloads, manifests } = classifyReleaseDir([
    'latest.yml',
    'b.blockmap',
    'A Setup.exe',
    'notes',
    'a.blockmap',
  ])
  assert.deepEqual(payloads, ['A Setup.exe', 'a.blockmap', 'b.blockmap'])
  assert.deepEqual(manifests, ['latest.yml'])
})

function bundleFixture(overrides = {}) {
  const dir = mkTempDir('ue-upload-bundle-')
  const runtime = '[]\n'
  const index = '{"notes":[]}\n'
  const page = '<html></html>\n'
  const github = '# notes\n'
  const artifacts = [
    {
      path: 'release-notes.json',
      kind: 'runtime',
      upload: true,
      mode: 'atomic',
      bytes: Buffer.byteLength(runtime),
      sha256: sha256(runtime),
    },
    {
      path: 'notes/index.json',
      kind: 'index',
      upload: true,
      mode: 'atomic',
      bytes: Buffer.byteLength(index),
      sha256: sha256(index),
    },
    {
      path: 'notes/v0.15.0.html',
      kind: 'page',
      upload: true,
      mode: 'direct',
      requiredUpload: true,
      bytes: Buffer.byteLength(page),
      sha256: sha256(page),
    },
    {
      path: 'github-release-0.15.0.md',
      kind: 'github',
      upload: false,
      mode: 'direct',
      bytes: Buffer.byteLength(github),
      sha256: sha256(github),
    },
  ]
  mkdirSync(join(dir, 'notes'), { recursive: true })
  writeFileSync(join(dir, 'release-notes.json'), runtime, 'utf8')
  writeFileSync(join(dir, 'notes/index.json'), index, 'utf8')
  writeFileSync(join(dir, 'notes/v0.15.0.html'), page, 'utf8')
  writeFileSync(join(dir, 'github-release-0.15.0.md'), github, 'utf8')
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ schema: 1, version: '0.15.0', artifacts, ...overrides }, null, 2),
    'utf8',
  )
  return dir
}

test('loadUploadBundle verifies every uploadable artifact against the manifest', () => {
  const dir = bundleFixture()
  try {
    const { manifest, files } = loadUploadBundle({ bundleDir: dir })
    assert.equal(manifest.version, '0.15.0')
    // upload:false artifacts (the GitHub body) stay local.
    assert.deepEqual(
      files.map((file) => file.path),
      ['release-notes.json', 'notes/index.json', 'notes/v0.15.0.html'],
    )
    assert.equal(files[0].mode, 'atomic')
    assert.equal(files[2].mode, 'direct')
    // 没有 requiredUpload 标记的产物（共享文件、旧发布包）一律 false → 增量判断退回全量。
    assert.deepEqual(
      files.map((file) => file.requiredUpload),
      [false, false, true],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadUploadBundle refuses tampered, resized or missing artifacts', () => {
  const dir = bundleFixture()
  try {
    writeFileSync(join(dir, 'release-notes.json'), '[]\n\n', 'utf8')
    assert.throws(() => loadUploadBundle({ bundleDir: dir }), /哈希不符/)

    writeFileSync(join(dir, 'release-notes.json'), '[]\n', 'utf8')
    const longPage = '<html></html>\n\n'
    writeFileSync(join(dir, 'notes/v0.15.0.html'), longPage, 'utf8')
    assert.throws(() => loadUploadBundle({ bundleDir: dir }), /哈希不符/)

    writeFileSync(join(dir, 'notes/v0.15.0.html'), '<html></html>\n', 'utf8')
    rmSync(join(dir, 'notes/index.json'))
    assert.throws(() => loadUploadBundle({ bundleDir: dir }), /上传包缺少产物/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadUploadBundle reports a missing bundle instead of uploading half of it', () => {
  const dir = mkTempDir('ue-upload-empty-')
  try {
    assert.throws(() => loadUploadBundle({ bundleDir: dir }), /缺少 release notes 上传包/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildUploadPlan orders payload → notes（版本页先于索引）→ latest.yml', () => {
  const bundle = {
    manifest: { version: '0.15.0' },
    files: [
      { path: 'notes/index.html', src: '/b/notes/index.html', mode: 'atomic' },
      { path: 'release-notes.json', src: '/b/release-notes.json', mode: 'atomic' },
      { path: 'notes/v0.15.0.html', src: '/b/notes/v0.15.0.html', mode: 'direct' },
      { path: 'notes/index.json', src: '/b/notes/index.json', mode: 'atomic' },
    ],
  }
  const plan = buildUploadPlan({
    payloads: ['Universe Editor Setup 0.15.0.exe', 'Universe Editor Setup 0.15.0.exe.blockmap'],
    manifests: ['latest.yml'],
    bundle,
  })
  assert.deepEqual(
    plan.map((step) => [step.phase, step.label, step.mode]),
    [
      ['payload', 'Universe Editor Setup 0.15.0.exe', 'direct'],
      ['payload', 'Universe Editor Setup 0.15.0.exe.blockmap', 'direct'],
      ['notes', 'release-notes.json', 'atomic'],
      ['notes', 'notes/v0.15.0.html', 'direct'],
      ['notes', 'notes/index.html', 'atomic'],
      ['notes', 'notes/index.json', 'atomic'],
      ['manifest', 'latest.yml', 'atomic'],
    ],
  )
  assert.deepEqual(remoteDirs(plan), ['notes'])
})

test('orderNotesFiles keeps the rest first, then pages, then the index', () => {
  const files = [
    { path: 'notes/index.json' },
    { path: 'release-notes.json' },
    { path: 'notes/v0.13.0.html' },
    { path: 'notes/index.html' },
    { path: 'notes/v0.15.0.html' },
  ]
  assert.deepEqual(
    orderNotesFiles(files).map((file) => file.path),
    [
      'release-notes.json',
      'notes/v0.13.0.html',
      'notes/v0.15.0.html',
      'notes/index.json',
      'notes/index.html',
    ],
  )
})

test('isNotePagePath 只认版本页', () => {
  assert.equal(isNotePagePath('notes/v0.15.0.html'), true)
  assert.equal(isNotePagePath('notes/index.html'), false)
  assert.equal(isNotePagePath('notes/index.json'), false)
  assert.equal(isNotePagePath('release-notes.json'), false)
  assert.equal(isNotePagePath('notes/v0.15.0.html/x.html'), false)
  assert.equal(isNotePagePath('notes/sub/v0.15.0.html'), false)
})

test('resolveNotesUpload skips history pages the remote already has', () => {
  const files = [
    { path: 'release-notes.json', requiredUpload: false },
    { path: 'notes/index.json', requiredUpload: false },
    { path: 'notes/v0.15.0.html', requiredUpload: true },
    { path: 'notes/v0.14.0.html', requiredUpload: false },
    { path: 'notes/v0.13.0.html', requiredUpload: false },
  ]
  const kept = (result) => result.files.map((file) => file.path)

  // ① 远端只有必传页：老页补齐
  const partial = resolveNotesUpload({
    files,
    listNoteNames: () => new Set(['v0.15.0.html']),
  })
  assert.equal(partial.source, 'incremental')
  assert.deepEqual(kept(partial), [
    'release-notes.json',
    'notes/index.json',
    'notes/v0.15.0.html',
    'notes/v0.14.0.html',
    'notes/v0.13.0.html',
  ])
  assert.deepEqual(partial.skipped, [])

  // ② 远端有全部老页：只留必传页与共享文件（这就是每次发版的常态）
  const full = resolveNotesUpload({
    files,
    listNoteNames: () =>
      new Set(['v0.15.0.html', 'v0.14.0.html', 'v0.13.0.html', 'index.html', 'index.json']),
  })
  assert.equal(full.source, 'incremental')
  assert.deepEqual(kept(full), ['release-notes.json', 'notes/index.json', 'notes/v0.15.0.html'])
  assert.deepEqual(full.skipped, ['notes/v0.14.0.html', 'notes/v0.13.0.html'])
  assert.deepEqual(full.requiredPaths, ['notes/v0.15.0.html'])

  // ③ 远端连必传页都有（--upload-only 重跑）：仍必须传，否则补丁并稿 / 模板刷新上不去
  const targetPresent = resolveNotesUpload({
    files,
    listNoteNames: () => new Set(files.map((file) => file.path.replace('notes/', ''))),
  })
  assert.ok(kept(targetPresent).includes('notes/v0.15.0.html'))
  assert.deepEqual(targetPresent.skipped, ['notes/v0.14.0.html', 'notes/v0.13.0.html'])

  // ⑤ 空目录（首装）：一张都不能省，且不告警
  const warnings = []
  const fresh = resolveNotesUpload({
    files,
    listNoteNames: () => new Set(),
    warn: (message) => warnings.push(message),
  })
  assert.equal(fresh.source, 'incremental')
  assert.deepEqual(
    kept(fresh),
    files.map((file) => file.path),
  )
  assert.deepEqual(warnings, [])
})

test('resolveNotesUpload always ships every page the manifest marked required', () => {
  // 补丁并稿会让「不是当版」的页也变字节：两页都标了必传就必须都传。
  const files = [
    { path: 'notes/index.json', requiredUpload: false },
    { path: 'notes/v0.16.0.html', requiredUpload: true },
    { path: 'notes/v0.15.1.html', requiredUpload: true },
    { path: 'notes/v0.15.0.html', requiredUpload: false },
  ]
  const result = resolveNotesUpload({
    files,
    listNoteNames: () => new Set(['v0.16.0.html', 'v0.15.1.html', 'v0.15.0.html']),
  })
  assert.deepEqual(result.requiredPaths, ['notes/v0.16.0.html', 'notes/v0.15.1.html'])
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['notes/index.json', 'notes/v0.16.0.html', 'notes/v0.15.1.html'],
  )
  assert.deepEqual(result.skipped, ['notes/v0.15.0.html'])
})

test('resolveNotesUpload falls back to a full upload whenever the remote is unknown', () => {
  const files = [
    { path: 'release-notes.json', requiredUpload: false },
    { path: 'notes/index.json', requiredUpload: false },
    { path: 'notes/v0.15.0.html', requiredUpload: true },
    { path: 'notes/v0.14.0.html', requiredUpload: false },
  ]
  const allPaths = files.map((file) => file.path)
  const warnings = []

  // ④ 列目录失败 / dry-run → 全传
  const unknown = resolveNotesUpload({
    files,
    listNoteNames: () => null,
    warn: (message) => warnings.push(message),
  })
  assert.equal(unknown.source, 'unknown')
  assert.deepEqual(
    unknown.files.map((file) => file.path),
    allPaths,
  )
  assert.deepEqual(unknown.skipped, [])
  assert.deepEqual(warnings, [])

  // ⑥ --all-notes：全传，且一条 ssh 都不发
  let listed = 0
  const forced = resolveNotesUpload({
    files,
    allNotes: true,
    listNoteNames: () => {
      listed++
      return new Set()
    },
  })
  assert.equal(forced.source, 'all')
  assert.deepEqual(
    forced.files.map((file) => file.path),
    allPaths,
  )
  assert.equal(listed, 0)

  // ⑦ 旧发布包没有 requiredUpload 标记：无从判断 → 告警 + 全传
  const legacy = resolveNotesUpload({
    files: files.map(({ path }) => ({ path })),
    listNoteNames: () => new Set(['v0.14.0.html']),
    warn: (message) => warnings.push(message),
  })
  assert.equal(legacy.source, 'unknown')
  assert.deepEqual(
    legacy.files.map((file) => file.path),
    allPaths,
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /没有标出必传页/)
})

test('parseRemoteNoteNames trusts a plain file list and rejects anything else', () => {
  assert.deepEqual(
    [...parseRemoteNoteNames('v0.15.0.html\nindex.json\n')],
    ['v0.15.0.html', 'index.json'],
  )
  assert.deepEqual(
    [...parseRemoteNoteNames('v0.15.0.html\r\nindex.html\r\n')],
    ['v0.15.0.html', 'index.html'],
  )
  assert.deepEqual([...parseRemoteNoteNames('')], [], '目录存在但为空是合法结果')
  assert.deepEqual([...parseRemoteNoteNames('sub/\n')], [], 'ls -1p 的目录条目被忽略')
  assert.deepEqual(
    [...parseRemoteNoteNames('.ue-tmp-9-index.json\n.DS_Store\nv0.15.0.html\n')],
    ['v0.15.0.html'],
    '点文件（含本脚本自己的临时文件残留）被忽略，不会拖累成每次全量',
  )
  assert.equal(parseRemoteNoteNames('File Not Found\n'), null)
  assert.equal(parseRemoteNoteNames(' v0.15.0.html\n'), null)
  assert.equal(parseRemoteNoteNames('v0.15.0.html \n'), null)
  assert.equal(parseRemoteNoteNames(`${'a'.repeat(129)}.html\n`), null)
  assert.equal(parseRemoteNoteNames('notes/v0.15.0.html\n'), null)
  assert.equal(parseRemoteNoteNames(undefined), null)
})

test('listRemoteNoteNames turns a failed or unparsable listing into "remote unknown"', () => {
  const warnings = []
  const warn = (message) => warnings.push(message)

  assert.equal(
    listRemoteNoteNames({
      executor: {
        listDir: () => {
          throw new Error('命令返回非零退出码 (2)')
        },
      },
      warn,
    }),
    null,
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /列目录失败/)

  // dry-run：capture 返回 null，不该当成故障告警
  assert.equal(listRemoteNoteNames({ executor: { listDir: () => null }, warn }), null)
  assert.equal(warnings.length, 1)

  assert.equal(listRemoteNoteNames({ executor: { listDir: () => 'File Not Found\n' }, warn }), null)
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /无法解析/)

  const targets = []
  const names = listRemoteNoteNames({
    executor: {
      listDir: (target) => {
        targets.push(target)
        return 'v0.15.0.html\n'
      },
    },
    warn,
  })
  assert.deepEqual([...names], ['v0.15.0.html'])
  assert.deepEqual(targets, ['notes'])
})

test('assertPlanConsistency keeps latest.yml last and pins the version', () => {
  const plan = [
    { phase: 'payload', label: 'app.exe', mode: 'direct' },
    { phase: 'notes', label: 'release-notes.json', mode: 'atomic' },
    { phase: 'manifest', label: 'latest.yml', mode: 'atomic' },
  ]
  const ok = assertPlanConsistency({
    plan,
    latestYml: { version: '0.15.0', path: 'app.exe' },
    notesVersion: '0.15.0',
    payloads: ['app.exe'],
  })
  assert.equal(ok.version, '0.15.0')

  assert.throws(
    () =>
      assertPlanConsistency({
        plan: [plan[2], ...plan.slice(0, 2)],
        latestYml: { version: '0.15.0', path: 'app.exe' },
        payloads: ['app.exe'],
      }),
    /必须是上传计划的最后一步/,
  )
  assert.throws(
    () =>
      assertPlanConsistency({
        plan,
        latestYml: { version: '0.15.0', path: 'app.exe' },
        notesVersion: '0.14.9',
        payloads: ['app.exe'],
      }),
    /不一致/,
  )
  assert.throws(
    () =>
      assertPlanConsistency({
        plan,
        latestYml: { version: '0.15.0', path: 'missing.exe' },
        payloads: ['app.exe'],
      }),
    /但 release\/ 下没有这个产物/,
  )
  assert.throws(
    () => assertPlanConsistency({ plan: [], latestYml: {}, payloads: [] }),
    /上传计划为空/,
  )

  // 当版页面被增量过滤丢掉 = 内容静默不更新；版本页排到索引之后 = 先换索引留下一屏死链。
  const withPages = [
    { phase: 'notes', label: 'notes/v0.15.0.html', remotePath: 'notes/v0.15.0.html' },
    { phase: 'notes', label: 'notes/index.json', remotePath: 'notes/index.json' },
    { phase: 'manifest', label: 'latest.yml', remotePath: 'latest.yml' },
  ]
  assert.deepEqual(
    assertPlanConsistency({
      plan: withPages,
      latestYml: { version: '0.15.0' },
      payloads: [],
      requiredPaths: ['notes/v0.15.0.html'],
    }),
    { version: '0.15.0' },
  )
  assert.throws(
    () =>
      assertPlanConsistency({
        plan: withPages.slice(1),
        latestYml: { version: '0.15.0' },
        payloads: [],
        requiredPaths: ['notes/v0.15.0.html'],
      }),
    /必传版本页 notes\/v0\.15\.0\.html 不在上传计划里/,
  )
  assert.throws(
    () =>
      assertPlanConsistency({
        plan: [withPages[1], withPages[0], withPages[2]],
        latestYml: { version: '0.15.0' },
        payloads: [],
        requiredPaths: ['notes/v0.15.0.html'],
      }),
    /版本页必须排在 notes\/index\.\* 之前/,
  )
})

test('remote commands are POSIX on Linux and cmd on Windows', () => {
  assert.equal(
    buildRemoteMkdirCommand({ dir: '/srv/site', isWindowsTarget: false }),
    "mkdir -p '/srv/site'",
  )
  assert.equal(
    buildRemoteMkdirCommand({ dir: 'D:\\site', isWindowsTarget: true }),
    'cmd /c if not exist "D:\\site" md "D:\\site"',
  )
  assert.equal(
    buildRemoteProbeCommand({ dir: '/srv/site', isWindowsTarget: false }),
    "touch '/srv/site/.ue-write-probe' && rm -f '/srv/site/.ue-write-probe'",
  )
  assert.match(buildRemoteProbeCommand({ dir: 'D:\\site', isWindowsTarget: true }), /type nul > /)
  assert.equal(
    buildRemoteListCommand({ dir: '/srv/site/notes', isWindowsTarget: false }),
    "ls -1p '/srv/site/notes'",
  )
  assert.equal(
    buildRemoteListCommand({ dir: 'D:\\site\\notes', isWindowsTarget: true }),
    'cmd /c dir /b /a-d "D:\\site\\notes"',
  )
  assert.equal(
    buildRemoteReplaceCommand({
      tempPath: '/srv/site/.ue-tmp-1-latest.yml',
      targetPath: '/srv/site/latest.yml',
      isWindowsTarget: false,
    }),
    "mv -f '/srv/site/.ue-tmp-1-latest.yml' '/srv/site/latest.yml'",
  )
  assert.equal(
    buildRemoteReplaceCommand({
      tempPath: 'D:\\site\\.ue-tmp-1-latest.yml',
      targetPath: 'D:\\site\\latest.yml',
      isWindowsTarget: true,
    }),
    'cmd /c move /Y "D:\\site\\.ue-tmp-1-latest.yml" "D:\\site\\latest.yml"',
  )
  assert.match(
    buildRemoteReplaceFallback({ tempPath: 'a', targetPath: 'b' }),
    /copy \/Y "a" "b" && del "a"/,
  )
})

test('tempRemotePath keeps the temp file in the target directory', () => {
  assert.equal(tempRemotePath('/srv/site/latest.yml', 42), '/srv/site/.ue-tmp-42-latest.yml')
  assert.equal(
    tempRemotePath('/srv/site/notes/index.html', 'a1'),
    '/srv/site/notes/.ue-tmp-a1-index.html',
  )
  assert.equal(tempRemotePath('D:\\site\\latest.yml', 7), 'D:\\site\\.ue-tmp-7-latest.yml')
  assert.equal(tempRemotePath('bare.yml', 1), '.ue-tmp-1-bare.yml')
})

test('runUploadPlan uploads shared files via a temp name and replaces atomically', () => {
  const calls = []
  const executor = {
    upload: (src, remotePath) => calls.push(['upload', src, remotePath]),
    move: (tmp, target) => calls.push(['move', tmp, target]),
    moveFallback: () => calls.push(['fallback']),
  }
  runUploadPlan(
    [
      {
        phase: 'payload',
        label: 'app.exe',
        mode: 'direct',
        src: '/r/app.exe',
        remotePath: 'app.exe',
      },
      {
        phase: 'notes',
        label: 'release-notes.json',
        mode: 'atomic',
        src: '/b/notes.json',
        remotePath: 'release-notes.json',
      },
      {
        phase: 'manifest',
        label: 'latest.yml',
        mode: 'atomic',
        src: '/r/latest.yml',
        remotePath: 'latest.yml',
      },
    ],
    executor,
    { nonce: '9' },
  )
  assert.deepEqual(calls, [
    ['upload', '/r/app.exe', 'app.exe'],
    ['upload', '/b/notes.json', '.ue-tmp-9-release-notes.json'],
    ['move', '.ue-tmp-9-release-notes.json', 'release-notes.json'],
    ['upload', '/r/latest.yml', '.ue-tmp-9-latest.yml'],
    ['move', '.ue-tmp-9-latest.yml', 'latest.yml'],
  ])
})

test('a POSIX target rethrows the move failure instead of running a cmd fallback', () => {
  const commands = []
  const run = (cmd, args) => {
    const command = String(args.at(-1))
    commands.push(command)
    if (command.startsWith('mv ')) throw new Error('mv: cannot move: Permission denied')
  }
  const executor = createExecutor({
    config: { remoteOs: 'linux' },
    sshBase: [],
    scpBase: [],
    remote: 'deploy@192.0.2.10',
    run,
    warn: () => {},
  })
  assert.throws(
    () =>
      runUploadPlan(
        [
          {
            phase: 'manifest',
            label: 'latest.yml',
            mode: 'atomic',
            src: '/r/latest.yml',
            remotePath: 'latest.yml',
          },
        ],
        executor,
      ),
    /Permission denied/,
  )
  assert.ok(
    !commands.some((command) => command.includes('cmd /c copy')),
    'POSIX 目标不得退化到 cmd',
  )
})

test('a Windows target keeps the copy /Y + del fallback', () => {
  const commands = []
  const run = (cmd, args) => {
    const command = String(args.at(-1))
    commands.push(command)
    if (command.startsWith('cmd /c move ')) throw new Error('move failed')
  }
  const warnings = []
  const executor = createExecutor({
    config: { remoteOs: 'windows' },
    sshBase: [],
    scpBase: [],
    remote: 'deploy@192.0.2.10',
    run,
    warn: (line) => warnings.push(line),
  })
  runUploadPlan(
    [
      {
        phase: 'manifest',
        label: 'latest.yml',
        mode: 'atomic',
        src: '/r/latest.yml',
        remotePath: 'latest.yml',
      },
    ],
    executor,
  )
  assert.ok(commands.some((command) => /cmd \/c copy \/Y .* && del /.test(command)))
  assert.equal(warnings.length, 1)
})

// scp 目标写相对路径会落在远端用户 home，而不是 --dir（2026-10 发版事故）；plan 里的路径
// 一律相对 --dir，executor 必须解析成绝对路径后再拼进 scp / mv。
test('an executor resolves relative plan paths under --dir', () => {
  const scpTargets = []
  const sshCommands = []
  const run = (cmd, args) => {
    if (cmd === 'scp') scpTargets.push(String(args.at(-1)))
    else sshCommands.push(String(args.at(-1)))
  }
  const executor = createExecutor({
    config: { dir: '/srv/site', remoteOs: 'linux' },
    sshBase: [],
    scpBase: [],
    remote: 'deploy@192.0.2.10',
    run,
    warn: () => {},
  })
  executor.upload('E:/r/index.json', 'notes/.ue-tmp-1-index.json')
  executor.move('notes/.ue-tmp-1-index.json', 'notes/index.json')
  assert.deepEqual(scpTargets, ['deploy@192.0.2.10:/srv/site/notes/.ue-tmp-1-index.json'])
  assert.deepEqual(sshCommands, [
    "mv -f '/srv/site/notes/.ue-tmp-1-index.json' '/srv/site/notes/index.json'",
  ])
})

test('a Windows executor joins --dir with backslashes for cmd commands', () => {
  const scpTargets = []
  const sshCommands = []
  const run = (cmd, args) => {
    if (cmd === 'scp') scpTargets.push(String(args.at(-1)))
    else sshCommands.push(String(args.at(-1)))
  }
  const executor = createExecutor({
    config: { dir: 'D:\\site', remoteOs: 'windows' },
    sshBase: [],
    scpBase: [],
    remote: 'deploy@192.0.2.10',
    run,
    warn: () => {},
  })
  executor.upload('E:/r/notes/index.html', 'notes/index.html')
  executor.move('notes/.ue-tmp-1-latest.yml', 'latest.yml')
  assert.deepEqual(scpTargets, ['deploy@192.0.2.10:D:\\site/notes/index.html'])
  assert.deepEqual(sshCommands, [
    'cmd /c move /Y "D:\\site\\notes\\.ue-tmp-1-latest.yml" "D:\\site\\latest.yml"',
  ])
})

test('a failing payload step aborts the plan before latest.yml is touched', () => {
  const calls = []
  const executor = {
    upload: (src, remotePath) => {
      calls.push(remotePath)
      if (remotePath.endsWith('.exe')) throw new Error('scp failed')
    },
    move: () => {},
    moveFallback: () => {},
  }
  assert.throws(
    () =>
      runUploadPlan(
        [
          {
            phase: 'payload',
            label: 'app.exe',
            mode: 'direct',
            src: '/r/app.exe',
            remotePath: 'app.exe',
          },
          {
            phase: 'manifest',
            label: 'latest.yml',
            mode: 'atomic',
            src: '/r/latest.yml',
            remotePath: 'latest.yml',
          },
        ],
        executor,
      ),
    /scp failed/,
  )
  assert.deepEqual(calls, ['app.exe'])
})

test('createRunner never spawns in dry-run', () => {
  const spawned = []
  const lines = []
  const run = createRunner({
    dryRun: true,
    spawn: (...args) => spawned.push(args),
    log: (line) => lines.push(line),
  })
  run('ssh', ['-n', 'deploy@192.0.2.10', 'echo hi'])
  assert.deepEqual(spawned, [])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\[dry-run\] ssh/)
})

test('createCaptureRunner returns stdout, null in dry-run, and throws on failure', () => {
  const spawned = []
  const lines = []
  const capture = createCaptureRunner({
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return { status: 0, signal: null, stdout: 'v0.15.0.html\n' }
    },
    log: (line) => lines.push(line),
  })
  assert.equal(
    capture('ssh', ['-n', 'deploy@192.0.2.10', "ls -1p '/srv/x/notes'"], { timeoutMs: 15000 }),
    'v0.15.0.html\n',
  )
  assert.equal(spawned[0].opts.encoding, 'utf8')
  assert.equal(spawned[0].opts.timeout, 15000)
  assert.equal(spawned[0].args.at(-1), "ls -1p '/srv/x/notes'")

  const dry = createCaptureRunner({
    dryRun: true,
    spawn: () => assert.fail('dry-run 不该 spawn'),
    log: (line) => lines.push(line),
  })
  assert.equal(dry('ssh', ['-n', 'x', 'ls']), null)
  assert.match(lines[0], /\[dry-run\] ssh/)

  const nonzero = createCaptureRunner({
    spawn: () => ({ status: 2, signal: null, stdout: '' }),
    log: () => {},
  })
  assert.throws(() => nonzero('ssh', ['x', 'ls']), /非零退出码 \(2\)/)
  const killed = createCaptureRunner({
    spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '' }),
    log: () => {},
  })
  assert.throws(() => killed('ssh', ['x', 'ls']), /被信号终止/)
  const broken = createCaptureRunner({
    spawn: () => ({ error: new Error('spawn ssh ENOENT'), status: null, signal: null }),
    log: () => {},
  })
  assert.throws(() => broken('ssh', ['x', 'ls']), /spawn ssh ENOENT/)
})

test('an executor lists a remote dir under --dir on both platforms', () => {
  const list = (config) => {
    const commands = []
    const executor = createExecutor({
      config,
      sshBase: [],
      scpBase: [],
      remote: 'deploy@192.0.2.10',
      run: () => {},
      capture: (cmd, args, opts) => {
        commands.push({ command: args.at(-1), timeoutMs: opts.timeoutMs })
        return ''
      },
      warn: () => {},
    })
    executor.listDir('notes')
    return commands
  }
  assert.deepEqual(list({ dir: '/srv/site' }), [
    { command: "ls -1p '/srv/site/notes'", timeoutMs: 15000 },
  ])
  assert.deepEqual(list({ dir: 'D:\\site', remoteOs: 'windows' }), [
    { command: 'cmd /c dir /b /a-d "D:\\site\\notes"', timeoutMs: 15000 },
  ])
})

test('createRunner throws on failure, warns on warnOnly failures', () => {
  const warnLines = []
  const failing = createRunner({
    spawn: () => ({ status: 1, signal: null }),
    warn: (line) => warnLines.push(line),
    log: () => {},
  })
  assert.throws(() => failing('scp', ['a', 'b']), /非零退出码/)
  failing('ssh', ['-n', 'x', 'y'], { warnOnly: true })
  assert.equal(warnLines.length, 1)

  const ok = createRunner({ spawn: () => ({ status: 0, signal: null }), log: () => {} })
  ok('scp', ['a', 'b'])

  const crashed = createRunner({
    spawn: () => ({ status: null, signal: 'SIGTERM' }),
    log: () => {},
  })
  assert.throws(() => crashed('scp', ['a']), /被信号终止/)
})
