import { describe, expect, test, beforeEach } from 'bun:test'
import { PersistentShell } from '../tools/exec'

describe('PersistentShell', () => {
  let sh: PersistentShell

  beforeEach(() => { sh = new PersistentShell('/tmp') })

  test('basic command returns stdout', async () => {
    const { stdout, exitCode } = await sh.exec('echo hello')
    expect(stdout.trim()).toBe('hello')
    expect(exitCode).toBe(0)
  })

  test('env vars persist across calls', async () => {
    await sh.exec('export MY_VAR=codectl')
    const { stdout } = await sh.exec('echo $MY_VAR')
    expect(stdout.trim()).toBe('codectl')
  })

  test('working directory persists across calls', async () => {
    await sh.exec('cd /tmp')
    const { stdout } = await sh.exec('pwd')
    expect(stdout.trim()).toBe('/tmp')
    expect(sh.getCwd()).toBe('/tmp')
  })

  test('exit code is captured correctly', async () => {
    const { exitCode: ok } = await sh.exec('true')
    expect(ok).toBe(0)
    const { exitCode: fail } = await sh.exec('false')
    expect(fail).toBe(1)
    const { exitCode: custom } = await sh.exec('bash -c "exit 42"')
    expect(custom).toBe(42)
  })

  test('stderr is captured', async () => {
    const { stderr } = await sh.exec('echo err >&2')
    expect(stderr).toContain('err')
  })

  test('restart clears env vars', async () => {
    await sh.exec('export MY_VAR=before')
    sh.restart()
    const { stdout } = await sh.exec('echo "${MY_VAR:-empty}"')
    expect(stdout.trim()).toBe('empty')
  })

  test('multiline command works', async () => {
    const { stdout } = await sh.exec('for i in 1 2 3; do echo $i; done')
    expect(stdout.trim()).toBe('1\n2\n3')
  })
  test('heredoc writes file correctly', async () => {
    const { exitCode } = await sh.exec(
      'cat > /tmp/codectl_heredoc_test.txt <<EOF\nhello\nworld\nEOF'
    )
    expect(exitCode).toBe(0)
    const { stdout } = await sh.exec('cat /tmp/codectl_heredoc_test.txt; rm /tmp/codectl_heredoc_test.txt')
    expect(stdout.trim()).toBe('hello\nworld')
  })

  test('heredoc exit code propagates', async () => {
    const { exitCode } = await sh.exec(
      'cat > /tmp/codectl_hd2.txt <<EOF\ndata\nEOF\nfalse'
    )
    expect(exitCode).toBe(1)
    await sh.exec('rm -f /tmp/codectl_hd2.txt')
  })
})
