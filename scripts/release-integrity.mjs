import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
    console.log(`${key}=${value}`)
  }
}

function verifyRelease() {
  const tag = process.env.RELEASE_TAG ?? ''
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match || match[0] !== version || match[4]?.split('.').some(part => /^0[0-9]+$/.test(part))) {
    throw new Error('Release tag must be an exact SemVer version, optionally prefixed with v')
  }
  if (match[5]) throw new Error('SemVer build metadata is unsupported: npm can normalize it away during publication')

  const expected = process.env.RELEASE_SHA ?? ''
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Missing or invalid immutable release event SHA')
  const gitCommit = ref => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim()
  if (gitCommit('HEAD') !== expected || gitCommit(`refs/tags/${tag}`) !== expected) {
    throw new Error('Release HEAD and peeled tag must both match the immutable release event SHA')
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('Release tag must match package.json, package-lock.json and its root package version; commit the version before tagging')
  }
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) {
    throw new Error('Invalid release package name')
  }
  const prerelease = match[4]?.split('.')[0]
  // Numeric (including v-prefixed numeric) dist-tags can be interpreted as versions by npm.
  const publishTag = prerelease ? (/^v?[0-9]/.test(prerelease) || !/^[A-Za-z][0-9A-Za-z-]*$/.test(prerelease) ? 'next' : prerelease) : 'latest'
  return { package_name: pkg.name, package_version: version, publish_tag: publishTag }
}

function registryStatus(release) {
  const registry = process.env.REGISTRY_URL
  if (!registry) throw new Error('REGISTRY_URL is required')
  const spec = `${release.package_name}@${release.package_version}`
  const result = spawnSync('npm', ['view', spec, 'version', '--json', '--registry', registry], { encoding: 'utf8' })
  if (result.error) throw result.error
  let response
  try {
    response = JSON.parse(result.stdout)
  } catch {
    throw new Error(`Registry lookup failed for ${spec}: ${result.stderr || 'invalid JSON response'}`)
  }
  if (result.status === 0 && response === release.package_version) {
    console.log(`${spec} already exists on npm; skipping publish.`)
    return { exists: 'true' }
  }
  if (result.status !== 0 && result.status !== null && response?.error?.code === 'E404') {
    console.log(`${spec} is not published yet.`)
    return { exists: 'false' }
  }
  throw new Error(`Registry lookup failed for ${spec}: ${result.stderr || JSON.stringify(response)}`)
}

function packRelease(release) {
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) throw new Error('Unexpected npm version')
  const [major, minor, patch] = npmVersion.split('.').map(Number)
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
    throw new Error('Release packing requires npm >=11.5.1 to match the trusted-publishing toolchain minimum')
  }
  if (!process.env.RELEASE_DIRECTORY) throw new Error('RELEASE_DIRECTORY is required')
  const directory = resolve(process.env.RELEASE_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }))
  if (packed.length !== 1 || packed[0].name !== release.package_name || packed[0].version !== release.package_version ||
      typeof packed[0].filename !== 'string' || basename(packed[0].filename) !== packed[0].filename || !packed[0].filename.endsWith('.tgz')) {
    throw new Error('npm pack did not produce the expected release archive')
  }
  const archive = join(directory, 'release.tgz')
  renameSync(join(directory, packed[0].filename), archive)
  return { tarball_sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') }
}

try {
  const release = verifyRelease()
  switch (process.argv[2]) {
    case 'guard': output(release); break
    case 'registry': output(registryStatus(release)); break
    case 'pack': output(packRelease(release)); break
    default: throw new Error('Usage: node scripts/release-integrity.mjs <guard|registry|pack>')
  }
} catch (error) {
  console.error(`Release integrity check failed: ${error.message}`)
  process.exitCode = 1
}
