import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Guard the peer range against the two ways it has already been wrong.
 *
 * Every dsh release published today is a prerelease (0.1.2-rc.1, 0.1.5-rc.1,
 * ...), and a semver comparator only admits prereleases that share its own
 * major.minor.patch tuple. That makes two natural-looking ranges fail:
 *
 *   ">=0.1.2"             matches NOTHING -> npm install dies with ETARGET
 *   ">=0.1.2-rc.1 <0.2.0" matches only 0.1.2-rc.1 -> a 0.1.5-line user gets
 *                         ERESOLVE, because the 0.1.5 tuple dsh-llm publishes
 *                         peers against is not 0.1.2
 *
 * This package's own consumers hit exactly that: `@deepseek-ai/dsh-llm` is a
 * peer here, so an unsatisfiable range is not a devDependency nuisance the user
 * can paper over with `--legacy-peer-deps` — it breaks the install.
 */
test('peer range admits both supported dsh prerelease lines', () => {
  const range = pkg.peerDependencies['@deepseek-ai/dsh-llm']
  assert.ok(range, 'the dsh-llm peer dependency must be declared')

  // Form 1: a bare release bound resolves to no published version at all.
  assert.ok(
    !/^(>=\^~)?\s*\d+\.\d+\.\d+\s*$/.test(range.trim()),
    `a bare non-prerelease comparator ("${range}") matches no published dsh version`,
  )

  // The lower bound must name a concrete prerelease, not a bare release.
  assert.match(range, /0\.1\.2-rc\.\d+/, 'expected a 0.1.2-rc.N lower bound')

  // Form 2: a single comparator group silently excludes the 0.1.5 line, which
  // the alpha/rc dist-tags serve. Requiring an explicit 0.1.5 prerelease in the
  // range catches that regression.
  assert.match(range, /0\.1\.5-(alpha|rc)\.\d+/, 'expected an explicit 0.1.5-line comparator')

  // Both lines must be joined as alternatives, not as one intersection.
  assert.match(range, /\|\|/, 'the two prerelease lines must be separate comparator groups')
})

test('cordis is a declared peer', () => {
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'])
})

test('the plugin declares the llm service it wraps', () => {
  // `inject: ['llm']` in src/index.ts is what makes ctx.on('llm/stream') legal;
  // the bundle patch and the service name must stay in step with it.
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /export const inject = \['llm'\]/)
  assert.match(src, /ctx\.on\('llm\/stream'/)
})

test('the bundle patch is declared, shipped, and matches the package name', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, new RegExp(pkg.name.replace(/[/@]/g, m => '\\' + m)))
})
