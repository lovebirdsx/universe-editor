/*---------------------------------------------------------------------------------------------
 *  Tests for ScmDecorationsService — folding the SCM model into by-URI git status
 *  decorations for the Explorer and editor tabs.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { observableValue, URI } from '@universe-editor/platform'
import type {
  IScmService,
  IScmSourceControlModel,
  IScmGroupModel,
} from '../../extensions/ScmService.js'
import type { ISourceControlResourceStateDto } from '@universe-editor/extensions-common'
import { ScmDecorationsService, scmPathKey } from '../ScmDecorationsService.js'

const ROOT = 'D:/repo'

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

function sourceControl(groups: IScmGroupModel[], rootUri = ROOT): IScmSourceControlModel {
  return {
    handle: 1,
    id: 'git',
    label: 'Git',
    rootUri,
    groups: observableValue('g', groups),
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

describe('ScmDecorationsService', () => {
  it('maps a file to its colour, badge letter and tooltip', () => {
    const svc = new ScmDecorationsService(
      service([sourceControl([group('changes', 1, [res(`${ROOT}/a/file.txt`, 'M')])])]),
    )
    const deco = svc.getFile(URI.file(`${ROOT}/a/file.txt`))
    expect(deco).toEqual({ color: '#e2c08d', letter: 'M', tooltip: 'Modified' })
  })

  it('renders untracked as "U" and deleted with strikethrough', () => {
    const svc = new ScmDecorationsService(
      service([
        sourceControl([
          group('changes', 1, [
            res(`${ROOT}/new.txt`, '?', '#73c991', 'Untracked'),
            res(`${ROOT}/gone.txt`, 'D', '#c74e39', 'Deleted'),
          ]),
        ]),
      ]),
    )
    expect(svc.getFile(URI.file(`${ROOT}/new.txt`))?.letter).toBe('U')
    const deleted = svc.getFile(URI.file(`${ROOT}/gone.txt`))
    expect(deleted?.letter).toBe('D')
    expect(deleted?.strikeThrough).toBe(true)
  })

  it('propagates a change up to every ancestor folder (no letter)', () => {
    const svc = new ScmDecorationsService(
      service([sourceControl([group('changes', 1, [res(`${ROOT}/a/b/file.txt`, 'M')])])]),
    )
    const a = svc.getFolder(URI.file(`${ROOT}/a`))
    const ab = svc.getFolder(URI.file(`${ROOT}/a/b`))
    expect(a?.color).toBe('#e2c08d')
    expect(ab?.color).toBe('#e2c08d')
    expect(a?.letter).toBeUndefined()
  })

  it('a working-tree change overrides the staged entry for the same file', () => {
    const uri = `${ROOT}/a/file.txt`
    const svc = new ScmDecorationsService(
      service([
        sourceControl([
          group('index', 1, [res(uri, 'A', '#73c991', 'Added')]),
          group('workingTree', 2, [res(uri, 'M', '#e2c08d', 'Modified')]),
        ]),
      ]),
    )
    expect(svc.getFile(URI.file(uri))?.letter).toBe('M')
  })

  it('folder colour favours the strongest descendant status', () => {
    const svc = new ScmDecorationsService(
      service([
        sourceControl([
          group('changes', 1, [
            res(`${ROOT}/dir/added.txt`, 'A', '#73c991', 'Added'),
            res(`${ROOT}/dir/conflict.txt`, 'U', '#c74e39', 'Conflict'),
          ]),
        ]),
      ]),
    )
    // Conflict (weight 5) wins over Added (weight 2).
    expect(svc.getFolder(URI.file(`${ROOT}/dir`))?.color).toBe('#c74e39')
  })

  it('keys are case- and separator-insensitive', () => {
    expect(scmPathKey('D:\\Repo\\A')).toBe('d:/repo/a')
  })
})
