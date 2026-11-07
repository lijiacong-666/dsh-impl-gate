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
 * Locates a specgraph source checkout by walking up from `start`. Besides the
 * plain `<dir>/specgraph` layout it also accepts a sibling `spec-graph`
 * checkout (`<dir>/spec-graph/specgraph`) and a nested `specgraph` repo
 * (`<dir>/specgraph/specgraph`). Every visited ancestor is appended to
 * `probed` — hit or miss — so a failed resolution shows where it stopped.
 * It never imports or reads that source.
 */
export function findSpecgraphHome(start: string, probed: string[] = []): string | undefined {
  let dir = path.resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    const hit = specgraphPackageRoot(dir)
    pushProbe(probed, hit === undefined ? dir : `${dir} -> hit`)
    if (hit !== undefined) return hit
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const PACKAGE_CANDIDATES = ['specgraph', path.join('spec-graph', 'specgraph'), path.join('specgraph', 'specgraph')]

/** Returns the checkout root whose `specgraph/__init__.py` exists, if any. */
function specgraphPackageRoot(dir: string): string | undefined {
  for (const candidate of PACKAGE_CANDIDATES) {
    const init = path.join(dir, candidate, '__init__.py')
    if (fs.existsSync(init)) return path.dirname(path.dirname(init))
  }
  return undefined
}

function pushProbe(probed: string[], entry: string): void {
  if (!probed.includes(entry)) probed.push(entry)
}

function formatProbed(probed: string[], limit = 6): string {
  if (probed.length === 0) return 'none'
  const shown = probed.slice(0, limit).join(', ')
  const extra = probed.length - limit
  return extra > 0 ? `${shown}, …(+${extra} more)` : shown
}

export function runSpecgraph(runner: RunnerOptions, args: string[]): Promise<RunOutput> {
  const executable = runner.argv[0]
  if (executable === undefined) {
    return Promise.reject(new SpecgraphError('E_PYTHON_MISSING', 'specgraphCommand resolved to an empty argv'))
  }
  return runProcess([executable, ...runner.argv.slice(1), ...args], runner)
}

export interface SpecgraphEnvInput {
  /** Full command line, e.g. `python -m specgraph`. */
  command: string
  /** Optional interpreter override for a `python …` command. */
  pythonPath: string
  /** Tool argument or plan field; wins over every other source. */
  home?: string
  /** Walk-up starts, in priority order (normally implRoot, then outDir). */
  startDirs?: string[]
  env?: NodeJS.ProcessEnv
}

export interface SpecgraphEnv {
  argv: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  home?: string
  probed: string[]
}

/**
 * Resolves the python environment shared by `impl_gate_check` and
 * `impl_gate_compose` materialize:
 *   explicit home > walk-up from startDirs > SPECGRAPH_HOME.
 * A home always sets PYTHONPATH so an uninstalled source checkout works.
 */
export function resolveSpecgraphEnv(input: SpecgraphEnvInput): SpecgraphEnv {
  const baseEnv = input.env ?? process.env
  const probed: string[] = []
  let home: string | undefined
  const explicit = input.home?.trim() ?? ''
  if (explicit.length > 0) {
    home = path.resolve(explicit)
    probed.push(home)
  }
  if (home === undefined) {
    for (const start of input.startDirs ?? []) {
      if (start === undefined || start.trim().length === 0) continue
      const found = findSpecgraphHome(start, probed)
      if (found !== undefined) {
        home = found
        break
      }
    }
  }
  if (home === undefined) {
    const fromEnv = baseEnv.SPECGRAPH_HOME
    if (fromEnv !== undefined && fromEnv.length > 0) {
      const found = specgraphPackageRoot(path.resolve(fromEnv))
      probed.push(found === undefined ? `SPECGRAPH_HOME=${fromEnv}` : `SPECGRAPH_HOME=${fromEnv} -> hit`)
      if (found !== undefined) home = found
    }
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (home !== undefined) {
    const existing = env.PYTHONPATH
    env.PYTHONPATH = existing === undefined || existing.length === 0 ? home : `${home}${path.delimiter}${existing}`
  }
  return { argv: resolveArgv(input.command, input.pythonPath), cwd: home, env, home, probed }
}

function importArgv(argv: string[]): string[] {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === '-m' && argv[index + 1] === 'specgraph') {
      return [...argv.slice(0, index), '-c', 'import specgraph']
    }
  }
  return [...argv, '-c', 'import specgraph']
}

/**
 * Runs `python -c "import specgraph"` before any file is written. The first
 * attempt deliberately drops PYTHONPATH; the second retries with the resolved
 * home. Two failures mean the interpreter cannot see specgraph at all.
 */
export async function preflightSpecgraph(environment: SpecgraphEnv, timeoutMs: number): Promise<void> {
  const argv = importArgv(environment.argv)
  const attempts: NodeJS.ProcessEnv[] = []
  const bare = { ...environment.env }
  delete bare.PYTHONPATH
  attempts.push(bare)
  if (environment.home !== undefined) {
    attempts.push({ ...environment.env, PYTHONPATH: environment.home })
  }
  let lastError = ''
  for (const env of attempts) {
    try {
      const output = await runProcess(argv, { cwd: environment.cwd, env, timeoutMs })
      if (output.exitCode === 0) return
      lastError = `${output.stderr}\n${output.stdout}`.trim()
    } catch (error) {
      lastError = (error as Error).message
    }
  }
  throw new SpecgraphError(
    'PYTHON_ENV_MISSING',
    `python cannot import specgraph; set PYTHONPATH to the spec-graph root or configure specgraphCwd (probed: ${formatProbed(environment.probed)})`,
    lastError.slice(-2000),
  )
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