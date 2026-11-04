import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'))

describe('MCP Registry metadata', () => {
  it('names the npm package the registry verifies', () => {
    assert.equal(server.name, pkg.mcpName)
    assert.equal(server.packages.length, 1)
    assert.equal(server.packages[0].registryType, 'npm')
    assert.equal(server.packages[0].identifier, pkg.name)
  })

  it('lists the version being released', () => {
    assert.equal(server.version, pkg.version)
    assert.equal(server.packages[0].version, pkg.version)
  })

  it('fits the registry description limit', () => {
    assert.ok(server.description.length <= 100, `${server.description.length} characters`)
  })
})
