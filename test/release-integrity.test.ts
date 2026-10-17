import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../scripts/release-integrity.mjs', import.meta.url))
const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')
const cleanEnv = { ...process.env }
for (const key of Object.keys(cleanEnv)) {
  if (/^(GIT_|GITHUB_|ACTIONS_|NODE_AUTH_TOKEN$|NPM_TOKEN$|NPM_CONFIG_|npm_config_|RELEASE_|EXPECTED_SHA256$|PUBLISH_TAG$)/.test(key)) delete cleanEnv[key]
}

function workflowStep(name: string) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `Missing workflow step: ${name}`)
  const end = workflow.indexOf('\n      - name:', start + 1)
  const step = workflow.slice(start, end < 0 ? undefined : end)
  const run = step.split('        run: |\n')[1]
  assert.ok(run, `Missing shell body: ${name}`)
  return run.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n').trimEnd()
}

function fixture(t: TestContext, version = '1.2.3', tag = `v${version}`, annotated = false) {
  const directory = mkdtempSync(join(tmpdir(), 'release-integrity-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cwd = join(directory, 'repo')
  mkdirSync(cwd)
  const output = join(directory, 'outputs')
  const env = {
    ...cleanEnv,
    // Isolate fixtures from local/global npm configuration and credentials.
    NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(directory, 'global-npmrc'),
    NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
    NPM_CONFIG_FETCH_RETRIES: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Release fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GITHUB_OUTPUT: output,
    RELEASE_TAG: tag,
    RELEASE_SHA: '',
    RELEASE_DIRECTORY: join(directory, 'archive'),
    PATH: `${dirname(process.execPath)}:${cleanEnv.PATH}`,
  }
  writeFileSync(env.NPM_CONFIG_USERCONFIG, '')
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '')
  function json(file: string, value: unknown) {
    writeFileSync(join(cwd, file), JSON.stringify(value, null, 2))
  }
  json('package.json', {
    name: '@release-fixture/package', version, files: ['index.js'],
    scripts: {
      prepare: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'prepare\'); process.exit(91)"',
      prepack: 'node -e "process.exit(92)"',
      postpack: 'node -e "process.exit(93)"',
      prepublishOnly: 'node -e "process.exit(94)"',
    },
  })
  json('package-lock.json', { name: '@release-fixture/package', version, lockfileVersion: 3, packages: { '': { name: '@release-fixture/package', version } } })
  writeFileSync(join(cwd, 'index.js'), 'export const released = true\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--initial-branch=main')
  git('add', '.')
  git('commit', '-m', 'Release fixture')
  env.RELEASE_SHA = git('rev-parse', 'HEAD')
  if (annotated) git('tag', '-a', tag, '-m', 'Annotated release fixture')
  else git('tag', tag)
  const run = (command = 'guard', overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [helper, command], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
  const shell = (name: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', workflowStep(name)], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
  return { directory, cwd, env, output, json, git, run, shell }
}

function success(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function failure(result: ReturnType<typeof spawnSync>, message: RegExp) {
  assert.notEqual(result.status, 0)
  assert.match(String(result.stderr), message)
}

describe('release source and version guards', () => {
  for (const [version, tag, publishTag] of [
    ['1.2.3', 'v1.2.3', 'latest'],
    ['1.2.3', '1.2.3', 'latest'],
    ['1.2.3-beta.2', 'v1.2.3-beta.2', 'beta'],
    ['1.2.3-0.2', 'v1.2.3-0.2', 'next'],
    ['1.2.3-v2.1', 'v1.2.3-v2.1', 'next'],
    ['1.2.3--foo', 'v1.2.3--foo', 'next'],
  ]) {
    it(`accepts exact ${tag} and chooses ${publishTag}`, t => {
      const f = fixture(t, version, tag)
      success(f.shell('Verify immutable release commit before running repository code'))
      success(f.run())
      assert.match(readFileSync(f.output, 'utf8'), new RegExp(`publish_tag=${publishTag}\n`))
      assert.match(publishTag, /^[A-Za-z][0-9A-Za-z-]*$/)
      assert.equal(f.git('status', '--porcelain'), '')
    })
  }

  it('accepts annotated tags fetched into a fresh depth-one checkout', t => {
    const f = fixture(t, '1.2.3', 'v1.2.3', true)
    const checkout = join(f.directory, 'checkout')
    mkdirSync(checkout)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '--initial-branch=main')
    git('remote', 'add', 'origin', f.cwd)
    git('fetch', '--no-tags', '--depth=1', 'origin', '+refs/tags/v1.2.3:refs/tags/v1.2.3')
    git('checkout', '--detach', 'refs/tags/v1.2.3')
    assert.notEqual(git('rev-parse', 'refs/tags/v1.2.3'), f.env.RELEASE_SHA)
    success(spawnSync('bash', ['-c', workflowStep('Verify immutable release commit before running repository code')], { cwd: checkout, env: f.env, encoding: 'utf8' }))
    success(spawnSync(process.execPath, [helper, 'guard'], { cwd: checkout, env: f.env, encoding: 'utf8' }))
  })

  it('ignores a moved target branch but rejects checking out its new HEAD', t => {
    const f = fixture(t)
    writeFileSync(join(f.cwd, 'index.js'), 'export const released = false\n')
    f.git('add', 'index.js')
    f.git('commit', '-m', 'Advance branch')
    failure(f.run(), /immutable release event SHA/)
    failure(f.shell('Verify immutable release commit before running repository code'), /immutable release event SHA/)
    f.git('checkout', '--detach', 'refs/tags/v1.2.3')
    success(f.run())
    success(f.shell('Verify immutable release commit before running repository code'))
  })

  it('rejects a moved tag even if HEAD follows that tag', t => {
    const f = fixture(t)
    writeFileSync(join(f.cwd, 'index.js'), 'export const replaced = true\n')
    f.git('add', 'index.js')
    f.git('commit', '-m', 'Replacement commit')
    f.git('tag', '-f', 'v1.2.3')
    failure(f.run(), /immutable release event SHA/)
    failure(f.shell('Verify immutable release commit before running repository code'), /immutable release event SHA/)
    f.git('checkout', '--detach', f.env.RELEASE_SHA)
    failure(f.run(), /immutable release event SHA/)
    failure(f.shell('Verify immutable release commit before running repository code'), /immutable release event SHA/)
  })

  for (const field of ['package', 'lock', 'lock-root', 'missing-lock-root']) {
    it(`rejects ${field} version mismatch without mutating versions`, t => {
      const f = fixture(t)
      if (field === 'package') f.json('package.json', { name: '@release-fixture/package', version: '1.2.4' })
      else f.json('package-lock.json', { version: field === 'lock' ? '1.2.4' : '1.2.3', packages: field === 'missing-lock-root' ? {} : { '': { version: field === 'lock-root' ? '1.2.4' : '1.2.3' } } })
      const before = f.git('diff')
      failure(f.run(), /must match package.json/)
      assert.equal(f.git('diff'), before)
    })
  }

  for (const tag of ['latest', 'release-1.2.3', '1.2', 'v01.2.3', '1.2.3-01', '1.2.3-alpha..1', '1.2.3-alpha_1', '1.2.3+', '1.2.3\n']) {
    it(`rejects non-SemVer tag ${JSON.stringify(tag)}`, t => {
      const f = fixture(t)
      failure(f.run('guard', { RELEASE_TAG: tag }), /exact SemVer/)
    })
  }

  it('rejects absent or malformed event SHA', t => {
    const f = fixture(t)
    for (const sha of ['', 'main', 'a'.repeat(39)]) failure(f.run('guard', { RELEASE_SHA: sha }), /immutable release event SHA/)
  })
})

describe('release packing and registry status', () => {
  it('rejects unsupported npm before invoking pack, using the publish job minimum', t => {
    const f = fixture(t)
    const bin = join(f.directory, 'bin')
    mkdirSync(bin)
    const capture = join(f.directory, 'npm-args')
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE"\nif [ "$1" = "--version" ]; then printf "%s\\n" "$NPM_FIXTURE_VERSION"; else exit 91; fi\n', { mode: 0o755 })
    for (const version of ['10.9.4', '11.5.0', 'invalid']) {
      const env = { PATH: `${bin}:${f.env.PATH}`, CAPTURE: capture, NPM_FIXTURE_VERSION: version }
      const message = version === 'invalid' ? /Unexpected npm version/ : /requires npm >=11.5.1/
      failure(f.run('pack', env), message)
      assert.equal(readFileSync(capture, 'utf8'), '--version\n')
      rmSync(capture)
      failure(f.shell('Verify trusted publishing npm support', env), message)
      rmSync(capture)
    }
    assert.throws(() => readFileSync(f.output), /ENOENT/)
  })

  it('packs without lifecycle scripts on supported npm and rejects older npm safely', t => {
    const f = fixture(t)
    const version = execFileSync('npm', ['--version'], { cwd: f.cwd, env: f.env, encoding: 'utf8' }).trim()
    const [major, minor, patch] = version.split('.').map(Number)
    const result = f.run('pack')
    const archivePath = join(f.env.RELEASE_DIRECTORY, 'release.tgz')
    if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
      failure(result, /Release packing requires npm >=11.5.1/)
      assert.throws(() => readFileSync(archivePath), /ENOENT/)
      assert.throws(() => readFileSync(f.output), /ENOENT/)
    } else {
      success(result)
      const archive = readFileSync(archivePath)
      assert.equal(readFileSync(f.output, 'utf8'), `tarball_sha256=${createHash('sha256').update(archive).digest('hex')}\n`)
    }
    assert.throws(() => readFileSync(join(f.cwd, 'lifecycle-ran')), /ENOENT/)
    assert.equal(f.git('status', '--porcelain'), '')
  })

  it('rejects SemVer build metadata before npm can normalize the published version', t => {
    const f = fixture(t, '1.2.3+build.5')
    failure(f.run(), /build metadata is unsupported/)
    failure(f.run('pack'), /build metadata is unsupported/)
    assert.throws(() => readFileSync(f.output), /ENOENT/)
    assert.equal(f.git('status', '--porcelain'), '')
  })

  for (const [status, response, exists] of [
    [200, { name: '@release-fixture/package', 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { name: '@release-fixture/package', version: '1.2.3' } } }, 'true'],
    [404, { error: 'Not found' }, 'false'],
    [401, { error: 'Unauthorized' }, null],
    [403, { error: 'Forbidden' }, null],
    [500, { error: 'Registry unavailable' }, null],
    [200, { name: '@release-fixture/package', 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { version: '1.2.4' } } }, null],
  ] as const) {
    it(`handles registry HTTP ${status} with exists=${exists}`, async t => {
      const f = fixture(t)
      const server = createServer((req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.headers.authorization, undefined)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      })
      t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [helper, 'registry'], { cwd: f.cwd, env: { ...f.env, REGISTRY_URL: `http://127.0.0.1:${address.port}` } })
        let stdout = '', stderr = ''
        child.stdout.on('data', data => { stdout += data })
        child.stderr.on('data', data => { stderr += data })
        child.on('error', reject)
        child.on('close', status => resolve({ status, stdout, stderr }))
      })
      if (exists === null) {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /Registry lookup failed/)
        assert.doesNotMatch(result.stdout, /exists=false/)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, new RegExp(`exists=${exists}`))
      }
    })
  }

  it('fails honestly when the registry connection fails', t => {
    const f = fixture(t)
    failure(f.run('registry', { REGISTRY_URL: 'http://127.0.0.1:0' }), /Registry lookup failed/)
  })
})

describe('privileged release boundary', () => {
  it('verifies archive bytes before forwarding the exact archive to npm', t => {
    const f = fixture(t)
    const archive = join(f.env.RELEASE_DIRECTORY, 'release.tgz')
    mkdirSync(f.env.RELEASE_DIRECTORY)
    // The publish boundary treats the archive as opaque bytes; npm itself is stubbed below.
    writeFileSync(archive, 'immutable archive fixture')
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const bin = join(f.directory, 'bin')
    mkdirSync(bin)
    const capture = join(f.directory, 'publish-args')
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 })
    const env = { PATH: `${bin}:${f.env.PATH}`, EXPECTED_SHA256: digest, PUBLISH_TAG: 'latest', REGISTRY_URL: 'https://registry.npmjs.org', CAPTURE: capture }
    success(f.shell('Verify and publish exact archive', env))
    assert.deepEqual(readFileSync(capture, 'utf8').trimEnd().split('\n'), ['publish', archive, '--access', 'public', '--tag', 'latest', '--ignore-scripts', '--provenance', '--registry', 'https://registry.npmjs.org'])
    rmSync(capture)
    writeFileSync(archive, 'tampered archive')
    assert.notEqual(f.shell('Verify and publish exact archive', env).status, 0)
    assert.throws(() => readFileSync(capture), /ENOENT/)
    failure(f.shell('Verify and publish exact archive', { ...env, EXPECTED_SHA256: '' }), /Invalid release digest/)
    failure(f.shell('Verify and publish exact archive', { ...env, PUBLISH_TAG: '-foo' }), /Invalid publish tag/)
  })

  it('rejects an empty or nonnumeric artifact ID before download', t => {
    const f = fixture(t)
    for (const id of ['', '0', 'latest', '123,456']) failure(f.shell('Require immutable artifact identity', { ARTIFACT_ID: id }), /Invalid release artifact ID/)
    success(f.shell('Require immutable artifact identity', { ARTIFACT_ID: '123456' }))
  })

  it('keeps code execution and mutable state out of the publishing job', () => {
    const [build, publish] = workflow.split('\n  publish:\n')
    assert.ok(publish)
    assert.match(build, /permissions: \{\}/)
    assert.match(build, /permissions:\n      contents: read\n/)
    assert.doesNotMatch(build, /id-token: write|contents: write/)
    assert.match(build, /ref: refs\/tags\/\$\{\{ github.event.release.tag_name \}\}/)
    assert.match(build, /persist-credentials: false/)
    assert.match(build, /npm ci --ignore-scripts/)
    assert.match(build, /npm test --ignore-scripts/)
    assert.match(build, /artifact_id: \$\{\{ steps.upload.outputs.artifact-id \}\}/)
    assert.match(build, /tarball_sha256: \$\{\{ steps.pack.outputs.tarball_sha256 \}\}/)
    assert.match(publish, /if: needs.build.outputs.already_published == 'false'/)
    assert.match(publish, /permissions:\n      contents: read\n      id-token: write\n/)
    assert.match(publish, /artifact-ids: \$\{\{ needs.build.outputs.artifact_id \}\}/)
    assert.match(publish, /EXPECTED_SHA256: \$\{\{ needs.build.outputs.tarball_sha256 \}\}/)
    assert.match(publish, /digest-mismatch: error/)
    assert.doesNotMatch(publish, /actions\/checkout|npm (?:ci|install|test|pack|run)|node scripts\//)
    assert.doesNotMatch(workflow, /target_commitish|\bnpm version\s|git (?:commit|push)|contents: write/)
    for (const action of workflow.matchAll(/uses: (\S+)/g)) assert.match(action[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
    assert.ok(build.indexOf('Verify immutable release commit') < build.indexOf('node scripts/release-integrity.mjs'))
  })
})
