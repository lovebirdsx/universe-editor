/*---------------------------------------------------------------------------------------------
 *  Tests for ScmDecorationsService — folding the SCM model into by-URI git status
 *  decorations for the Explorer and editor tabs.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { observableValue, REMOTE_SCHEME, URI } from '@universe-editor/platform'
import type { IWorkspaceService } from '@universe-editor/platform'
import type {
  IScmService,
  IScmSourceControlModel,
  IScmGroupModel,
  IScmSupplementaryDecoration,
} from '../../extensions/ScmService.js'
import type { ISourceControlResourceStateDto } from '@universe-editor/extensions-common'
import { ScmDecorationsService, scmPathKey } from '../ScmDecorationsService.js'

const ROOT = 'D:/repo'
const REMOTE_AUTHORITY = 'myhost'
const REMOTE_ROOT = '/home/u/repo'

function group(
  id: string,
  handle: number,
  resources: ISourceControlResourceStateDto[],
): IScmGroupModel {
  return {
    id,
    handle,
    label: observableValue('l', id),
    hideWhenEmpty: observableValue('h', false),
    resources: observableValue('r', resources),
  } as unknown as IScmGroupModel
}

function sourceControl(
  groups: IScmGroupModel[],
  rootUri = ROOT,
  supplementary: IScmSupplementaryDecoration[] = [],
): IScmSourceControlModel {
  return {
    handle: 1,
    id: 'git',
    label: 'Git',
    rootUri,
    groups: observableValue('g', groups),
    supplementary: observableValue('supp', new Map(supplementary.map((s) => [s.resourceUri, s]))),
  } as unknown as IScmSourceControlModel
}

function service(scs: IScmSourceControlModel[]): IScmService {
  return { sourceControls: observableValue('sc', scs) } as unknown as IScmService
}

function res(
  uri: string,
  contextValue: string,
  color = '#e2c08d',
  tooltip = 'Modified',
): ISourceControlResourceStateDto {
  return { resourceUri: uri, contextValue, decorations: { color, tooltip } }
}

/** Workspace stub; `folder` undefined means "no workspace" (local window). */
function workspaceOf(folder?: URI): IWorkspaceService {
  return {
    current: folder ? { folder } : null,
    onDidChangeWorkspace: () => ({ dispose: () => {} }),
  } as unknown as IWorkspaceService
}

/** Service over the given source controls, scoped to a local workspace. */
function local(scs: IScmSourceControlModel[]): ScmDecorationsService {
  return new ScmDecorationsService(service(scs), workspaceOf(URI.file(ROOT)))
}

/** `remote-ssh://<authority>/<path>`. */
function remote(path: string, authority = REMOTE_AUTHORITY): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

describe('ScmDecorationsService', () => {
  it('maps a file to its colour, badge letter and tooltip', () => {
    const svc = local([sourceControl([group('changes', 1, [res(`${ROOT}/a/file.txt`, 'M')])])])
    const deco = svc.getFile(URI.file(`${ROOT}/a/file.txt`))
    expect(deco).toEqual({ color: '#e2c08d', letter: 'M', tooltip: 'Modified' })
  })

  it('renders untracked as "U" and deleted with strikethrough', () => {
    const svc = local([
      sourceControl([
        group('changes', 1, [
          res(`${ROOT}/new.txt`, '?', '#73c991', 'Untracked'),
          res(`${ROOT}/gone.txt`, 'D', '#c74e39', 'Deleted'),
        ]),
      ]),
    ])
    expect(svc.getFile(URI.file(`${ROOT}/new.txt`))?.letter).toBe('U')
    const deleted = svc.getFile(URI.file(`${ROOT}/gone.txt`))
    expect(deleted?.letter).toBe('D')
    expect(deleted?.strikeThrough).toBe(true)
  })

  it('propagates a change up to every ancestor folder (no letter)', () => {
    const svc = local([sourceControl([group('changes', 1, [res(`${ROOT}/a/b/file.txt`, 'M')])])])
    const a = svc.getFolder(URI.file(`${ROOT}/a`))
    const ab = svc.getFolder(URI.file(`${ROOT}/a/b`))
    expect(a?.color).toBe('#e2c08d')
    expect(ab?.color).toBe('#e2c08d')
    expect(a?.letter).toBeUndefined()
  })

  it('a working-tree change overrides the staged entry for the same file', () => {
    const uri = `${ROOT}/a/file.txt`
    const svc = local([
      sourceControl([
        group('index', 1, [res(uri, 'A', '#73c991', 'Added')]),
        group('workingTree', 2, [res(uri, 'M', '#e2c08d', 'Modified')]),
      ]),
    ])
    expect(svc.getFile(URI.file(uri))?.letter).toBe('M')
  })

  it('folder colour favours the strongest descendant status', () => {
    const svc = local([
      sourceControl([
        group('changes', 1, [
          res(`${ROOT}/dir/added.txt`, 'A', '#73c991', 'Added'),
          res(`${ROOT}/dir/conflict.txt`, 'U', '#c74e39', 'Conflict'),
        ]),
      ]),
    ])
    // Conflict (weight 5) wins over Added (weight 2).
    expect(svc.getFolder(URI.file(`${ROOT}/dir`))?.color).toBe('#c74e39')
  })

  it('keys are case- and separator-insensitive', () => {
    expect(scmPathKey('D:\\Repo\\A')).toBe('d:/repo/a')
  })

  describe('host scoping', () => {
    it('decorates a remote resource from the remote git state', () => {
      const svc = new ScmDecorationsService(
        service([
          sourceControl([group('changes', 1, [res(`${REMOTE_ROOT}/a/file.ts`, 'M')])], REMOTE_ROOT),
        ]),
        workspaceOf(remote(REMOTE_ROOT)),
      )
      expect(svc.getFile(remote(`${REMOTE_ROOT}/a/file.ts`))?.letter).toBe('M')
      expect(svc.getFolder(remote(`${REMOTE_ROOT}/a`))?.color).toBe('#e2c08d')
    })

    it('never decorates a same-path resource from another host', () => {
      // A Windows remote's C:/repo/a.ts is not the client's own C:/repo/a.ts.
      const winPath = '/C:/repo/a.ts'
      const svc = new ScmDecorationsService(
        service([sourceControl([group('changes', 1, [res('C:/repo/a.ts', 'M')])], 'C:/repo')]),
        workspaceOf(remote('/C:/repo', 'winhost')),
      )
      expect(svc.getFile(remote(winPath, 'winhost'))?.letter).toBe('M')
      expect(svc.getFile(URI.file('C:/repo/a.ts'))).toBeUndefined()
      expect(svc.getFile(remote(winPath, 'otherhost'))).toBeUndefined()
    })

    it('never decorates a remote resource in a local window', () => {
      const svc = local([sourceControl([group('changes', 1, [res(`${ROOT}/a.txt`, 'M')])])])
      expect(svc.getFile(remote(`/${ROOT}/a.txt`))).toBeUndefined()
    })
  })

  it('surfaces a supplementary decoration for a file with no group row', () => {
    const svc = local([
      sourceControl([], ROOT, [
        { resourceUri: `${ROOT}/behind.umap`, description: '可更新', tooltip: '#4 → #7' },
      ]),
    ])
    const snapshot = svc.decorations.get()
    expect(snapshot.supplementary.get(scmPathKey(`${ROOT}/behind.umap`))).toEqual({
      description: '可更新',
      tooltip: '#4 → #7',
    })
    // A clean-but-behind file must NOT read as "has local changes": dirty-diff
    // gating tests exactly that via getFile(...) !== undefined.
    expect(svc.getFile(URI.file(`${ROOT}/behind.umap`))).toBeUndefined()
  })

  it('keeps group-derived and supplementary fields independent for one file', () => {
    const uri = `${ROOT}/Config.ini`
    const svc = local([
      sourceControl([group('changes', 1, [res(uri, 'M', '#e2c08d', 'Modified')])], ROOT, [
        { resourceUri: uri, description: '可更新', tooltip: '#4 → #7' },
      ]),
    ])
    // Letter / colour / tooltip stay group-derived; the grey text is separate.
    expect(svc.getFile(URI.file(uri))).toEqual({
      color: '#e2c08d',
      letter: 'M',
      tooltip: 'Modified',
    })
    expect(svc.decorations.get().supplementary.get(scmPathKey(uri))?.description).toBe('可更新')
  })

  it('does not propagate supplementary decorations up to folders', () => {
    const svc = local([
      sourceControl([], ROOT, [{ resourceUri: `${ROOT}/dir/x.fbx`, description: '他人占用' }]),
    ])
    expect(svc.getFolder(URI.file(`${ROOT}/dir`))).toBeUndefined()
  })

  it('merges supplementary decorations across providers, keyed path-insensitively', () => {
    const svc = local([
      sourceControl([], ROOT, [{ resourceUri: `${ROOT}\\A.ts`, description: '可更新' }]),
      sourceControl([], '/other', [{ resourceUri: '/other/b.ts', description: '他人占用' }]),
    ])
    const supp = svc.decorations.get().supplementary
    expect(supp.get(scmPathKey(`${ROOT}/a.ts`))?.description).toBe('可更新')
    expect(supp.get('/other/b.ts')?.description).toBe('他人占用')
  })
})
