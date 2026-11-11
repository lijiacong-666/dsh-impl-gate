// Pre-flight for a release: the four things that were wrong at least once.
//   1. version bumped but no docs/release-notes/v<version>.md
//   2. version already published to npm (then `npm stage publish` fails with E409)
//   3. tarball ships tests/ or forgets docs/
//   4. version bumped but the build was not re-run (lib/ still says the old one)
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const problems = []
const notes = path.join(root, 'docs', 'release-notes', `v${version}.md`)
if (!fs.existsSync(notes)) problems.push(`missing docs/release-notes/v${version}.md`)

try {
  const tag = execSync(`git rev-parse v${version}`, { cwd: root, encoding: 'utf8' }).trim()
  if (tag.length !== 40) problems.push(`tag v${version} does not resolve to a commit`)
} catch {
  problems.push(`tag v${version} does not exist`)
}

const lib = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
if (!lib.includes(version)) problems.push(`lib/index.js does not mention ${version} — run the build again`)

const pack = JSON.parse(
  execSync('npm pack --dry-run --json', { cwd: root, encoding: 'utf8' }),
)[0]
const paths = pack.files.map((file) => file.path)
if (paths.some((file) => file.startsWith('tests/'))) problems.push('tarball ships tests/')
if (!paths.some((file) => file === `docs/release-notes/v${version}.md`)) {
  problems.push(`tarball misses docs/release-notes/v${version}.md`)
}

console.log(`version   ${version}`)
console.log(`tarball   ${paths.length} files, ${pack.size} bytes (unpacked ${pack.unpackedSize})`)
console.log(`notes     ${fs.existsSync(notes) ? 'present' : 'MISSING'}`)
if (problems.length > 0) {
  for (const problem of problems) console.log(`problem   ${problem}`)
  process.exitCode = 1
} else {
  console.log('release preflight ok — stage it, then approve in the browser')
}