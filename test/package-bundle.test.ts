import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

interface LockPackage {
  dev?: boolean
  optional?: boolean
}

describe('published package', () => {
  it('bundles the locked production dependencies so npx resolves nothing at install time', () => {
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repoRoot, encoding: 'utf8' }),
    ) as Array<{ files: Array<{ path: string }> }>
    const lock = JSON.parse(readFileSync(`${repoRoot}/package-lock.json`, 'utf8')) as {
      packages: Record<string, LockPackage>
    }
    const packed = new Set(pack.files.map((file) => file.path))
    const installed = Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/'))
    const production = installed.filter(([, meta]) => !meta.dev)
    assert.ok(production.length > 0, 'the lockfile lists production dependencies')

    const missing = production
      .filter(([path, meta]) => !meta.optional && !packed.has(`${path}/package.json`))
      .map(([path]) => path)
    assert.deepEqual(missing, [])

    const bundledDev = installed
      .filter(([path, meta]) => meta.dev && packed.has(`${path}/package.json`))
      .map(([path]) => path)
    assert.deepEqual(bundledDev, [])
  })
})
