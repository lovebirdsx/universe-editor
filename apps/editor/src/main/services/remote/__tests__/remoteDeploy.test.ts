import { describe, expect, it } from 'vitest'
import {
  buildCheckCommand,
  buildDeployRemoteScript,
  buildStartCommand,
  buildStopCommand,
  forwardArgs,
  parseAuthority,
  parseDaemonInfoLine,
  scpArgs,
  sshCommandArgs,
  validateAuthority,
} from '../remoteDeploy.js'

describe('validateAuthority', () => {
  it('accepts a bare host, user@host, host:port and user@host:port', () => {
    expect(() => validateAuthority('host')).not.toThrow()
    expect(() => validateAuthority('user@host')).not.toThrow()
    expect(() => validateAuthority('host:22')).not.toThrow()
    expect(() => validateAuthority('user@host:22')).not.toThrow()
    expect(() => validateAuthority('e2e-local')).not.toThrow()
    expect(() => validateAuthority('user.name_1@host-2.example.com:2222')).not.toThrow()
  })

  it('rejects empty, leading dash and malformed authorities', () => {
    expect(() => validateAuthority('')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('-oProxyCommand=evil')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('user@')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('@host')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:abc')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('a b')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:22:33')).toThrow(/invalid remote authority/)
  })
})

describe('parseAuthority', () => {
  it('splits user, host and port', () => {
    expect(parseAuthority('user@host:22')).toEqual({ host: 'host', user: 'user', port: 22 })
    expect(parseAuthority('host')).toEqual({ host: 'host' })
    expect(parseAuthority('host:22')).toEqual({ host: 'host', port: 22 })
  })
})

describe('argv assembly', () => {
  it('builds the ssh check command with the remote data-dir path', () => {
    expect(sshCommandArgs('user@host', buildCheckCommand('0.0.0'))).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'user@host',
      'node ~/.universe-editor-server/0.0.0/bootstrap.js check',
    ])
  })

  it('adds -p for an explicit ssh port', () => {
    expect(sshCommandArgs('host:2222', buildStartCommand('0.0.0'))).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-p',
      '2222',
      'host',
      'node ~/.universe-editor-server/0.0.0/bootstrap.js start',
    ])
  })

  it('uses -P for scp and does not let the source path slip into options', () => {
    expect(scpArgs('host:22', '/tmp/a.tgz', 'host:/tmp/a.tgz')).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-P',
      '22',
      '/tmp/a.tgz',
      'host:/tmp/a.tgz',
    ])
  })

  it('builds forward args with keepalive and ExitOnForwardFailure', () => {
    expect(forwardArgs('user@host', 1234, 5678)).toEqual([
      '-N',
      '-L',
      '1234:127.0.0.1:5678',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      'user@host',
    ])
  })

  it('builds the remote deploy install script', () => {
    const script = buildDeployRemoteScript('0.0.0', 'universe-server-abc123.tgz')
    expect(script).toContain('mkdir -p ~/.universe-editor-server/0.0.0')
    expect(script).toContain('tar xzf /tmp/universe-server-abc123.tgz')
    expect(script).toContain('npm install --omit=dev --no-audit --no-fund')
    expect(script).toContain('rm /tmp/universe-server-abc123.tgz')
  })

  it('builds check/start/stop commands against the versioned bootstrap', () => {
    expect(buildCheckCommand('1.2.3')).toBe(
      'node ~/.universe-editor-server/1.2.3/bootstrap.js check',
    )
    expect(buildStartCommand('1.2.3')).toBe(
      'node ~/.universe-editor-server/1.2.3/bootstrap.js start',
    )
    expect(buildStopCommand('1.2.3')).toBe('node ~/.universe-editor-server/1.2.3/bootstrap.js stop')
  })
})

describe('parseDaemonInfoLine', () => {
  it('parses a well-formed info line', () => {
    const info = parseDaemonInfoLine(
      'UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":1234,"token":"t","pid":99}\n',
    )
    expect(info).toEqual({
      serverVersion: '0.0.0',
      protocolVersion: 2,
      port: 1234,
      token: 't',
      pid: 99,
    })
  })

  it('parses an info line with surrounding noise', () => {
    const info = parseDaemonInfoLine(
      'some log\nUNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":5,"token":"x","pid":1}\nmore',
    )
    expect(info?.port).toBe(5)
  })

  it('returns null for garbage / missing line', () => {
    expect(parseDaemonInfoLine('no info here')).toBeNull()
    expect(parseDaemonInfoLine('UNIVERSE_REMOTE_DAEMON_INFO={bad json}')).toBeNull()
    expect(parseDaemonInfoLine('UNIVERSE_REMOTE_DAEMON_INFO={"token":"no-port"}')).toBeNull()
  })
})
