import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Every `@deepseek-ai/dsh-llm` version published as of 2026-09-18, oldest
 * first; `npm view @deepseek-ai/dsh-llm versions` refreshes it.
 *
 * The list is deliberately frozen: it is a record of what the range was checked
 * against, not a live query. A version published later is not covered by this
 * test — that is what the release checklist is for.
 */
const PUBLISHED = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5',
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

/**
 * The versions this plugin is expected to install against. The seam it needs —
 * `llm/stream`, `EMPTY_RESPONSE_CODE`, and `chunkHasVisibleText` — is complete
 * only from 0.1.3-alpha.2 onward; each line listed here has had the full suite
 * run against it (`npm i --no-save @deepseek-ai/dsh-llm@<line> && npm test`).
 *
 * 0.1.2-rc.1 was claimed by 0.2.0 and is **not** supportable: that release has
 * no `assistant-stream` module at all, so `chunkHasVisibleText` is not merely
 * where the plugin expects it, it does not exist — `tsc` fails on src/index.ts
 * before a single test runs. The range *admitted* the version; nobody had run
 * the code against it. A range is a claim, and a claim is only as good as the
 * last time someone tried it.
 */
const SUPPORTED = [
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
]

/**
 * Guard the peer range by *computing* admission, not by pattern-matching it.
 *
 * Every dsh release published today is a prerelease, and a semver comparator
 * admits a prerelease only when some comparator in the same group shares its
 * major.minor.patch tuple. So the natural-looking ranges fail silently:
 *
 *   ">=0.1.2"               matches NOTHING -> npm install dies with ETARGET
 *   ">=0.1.2-rc.1 <0.2.0"   admits 0.1.2-rc.1 only -> 0.1.5/0.1.6 users get
 *                           ERESOLVE, because no comparator names their tuple
 *
 * The 0.1.6 line was excluded by exactly that second form until 0.2.1, one
 * release after 0.1.6-alpha.2 became the `alpha` dist-tag. A regex cannot see
 * this: both forms *look* right. Only an evaluation over the published version
 * list can, which is what this test does — and it asserts the admitted set
 * exactly, so an accidental extra line (widening to a tuple the plugin was
 * never tested on, the way 0.1.2-rc.1 was) fails as loudly as a missing one.
 *
 * The stakes are higher than usual: `@deepseek-ai/dsh-llm` is a *peer* here, so
 * an unsatisfiable range is not a devDependency nuisance the consumer can paper
 * over with `--legacy-peer-deps` — their install fails.
 */
test('peer range admits exactly the supported dsh prerelease lines', () => {
  const range = pkg.peerDependencies['@deepseek-ai/dsh-llm']
  assert.ok(range, 'the dsh-llm peer dependency must be declared')

  const admitted = PUBLISHED.filter(version => satisfies(version, range))

  assert.deepEqual(
    admitted,
    PUBLISHED.filter(version => SUPPORTED.includes(version)),
    `peer range "${range}" does not admit exactly the supported lines`,
  )

  // Named separately so a failure says which line broke, not just "the sets
  // differ".
  for (const version of SUPPORTED) {
    assert.ok(satisfies(version, range), `peer range must admit ${version}`)
  }
  for (const version of ['0.1.1-rc.2', '0.1.2-alpha.5', '0.1.2-rc.1']) {
    assert.ok(!satisfies(version, range), `peer range must not admit pre-seam ${version}`)
  }
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
