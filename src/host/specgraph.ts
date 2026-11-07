// Thin spawn wrapper around the specgraph CLI.
// The plugin never imports specgraph's Python modules or re-implements its
// checks (§1.2): every judgement comes from `python -m specgraph ...`.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export class SpecgraphError extends Error {
  readonly code: string
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export interface RunOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunnerOptions {
  argv: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}

const MAX_STDOUT = 4 * 1024 * 1024
const MAX_STDERR = 64 * 1024

/** Splits a command line honouring simple single/double quotes. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

/**
 * Resolves the configured command into an argv.
 * B §3: when specgraphCommand starts with `python` and pythonPath is set, the
 * first token is replaced by pythonPath; otherwise the command stays verbatim.
 */
export function resolveArgv(command: string, pythonPath: string): string[] {
  const argv = splitCommand(command)
  if (argv.length === 0) argv.push('python', '-m', 'specgraph')
  const first = argv[0]
  if (first === undefined) return argv
  if (pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path.basename(first))) {
    argv[0] = pythonPath
  }
  return argv
}

/**
 * Locates a specgraph source checkout by walking up from `start` and looking
 * for the `specgraph/__init__.py` package marker. Used only when the plugin is
 * configured without `specgraphCwd` so that `python -m specgraph` also works
 * for uninstalled source checkouts; it never imports or reads that source.
 */
export function findSpecgraphHome(start: string): string | undefined {
  let dir = path.resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'specgraph', '__init__.py'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function runSpecgraph(runner: RunnerOptions, args: string[]): Promise<RunOutput> {
  const executable = runner.argv[0]
  if (executable === undefined) {
    return Promise.reject(new SpecgraphError('E_PYTHON_MISSING', 'specgraphCommand resolved to an empty argv'))
  }
  return runProcess([executable, ...runner.argv.slice(1), ...args], runner)
}

/** Spawns one process with the shared timeout / exit-code / stdio policy. */
export function runProcess(argv: string[], runner: Omit<RunnerOptions, 'argv'>): Promise<RunOutput> {
  return new Promise<RunOutput>((resolve, reject) => {
    const executable = argv[0]
    if (executable === undefined) {
      reject(new SpecgraphError('E_PYTHON_MISSING', 'empty argv'))
      return
    }
    const child = spawn(executable, argv.slice(1), {
      cwd: runner.cwd !== undefined && runner.cwd.length > 0 ? runner.cwd : undefined,
      env: runner.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(1000, runner.timeoutMs))

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new SpecgraphError('E_PYTHON_MISSING', `cannot start "${executable}": ${error.message}`))
        } else if (error.code === 'EPERM' || error.code === 'EACCES') {
          reject(new SpecgraphError('E_SPAWN_DENIED', `permission denied starting "${executable}"`, error.message))
        } else {
          reject(new SpecgraphError('E_SPAWN_DENIED', `failed to start "${executable}": ${error.message}`))
        }
      })
    })
    child.on('close', (code: number | null) => {
      finish(() => {
        if (timedOut) {
          reject(new SpecgraphError('E_TIMEOUT', `specgraph did not finish within ${runner.timeoutMs} ms`, stderr.slice(-4096)))
          return
        }
        resolve({ exitCode: code ?? -1, stdout, stderr })
      })
    })
  })
}