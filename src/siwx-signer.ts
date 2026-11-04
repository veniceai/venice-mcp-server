/**
 * Per-request SIGN-IN-WITH-X signing through an external command.
 *
 * Venice accepts each signed SIWX message once, within 5 minutes of its
 * `Issued At` time, so a static `VENICE_SIWX_TOKEN` only covers one request.
 * `VENICE_SIWX_SIGNER_COMMAND` lets the server ask an external signer for a
 * new header before every wallet-authenticated request. The wallet key stays
 * with the signer; this process only ever sees the signed header value.
 *
 * Contract for the command:
 *   - It is run through the platform shell, once per request.
 *   - It receives VENICE_SIWX_BASE_URL (the Venice API root this server calls,
 *     e.g. https://api.venice.ai/api), VENICE_SIWX_REQUEST_METHOD and
 *     VENICE_SIWX_REQUEST_PATH. It does not inherit VENICE_API_KEY or
 *     VENICE_SIWX_TOKEN.
 *   - It prints the base64 `SIGN-IN-WITH-X` value on stdout and exits 0.
 *     Surrounding whitespace is ignored; anything else must be one line of
 *     printable ASCII.
 */

import { spawn } from 'node:child_process'

export interface SiwxSignerRequest {
  method: string
  path: string
  baseUrl: string
}

export interface SiwxSignerOptions {
  timeoutMs: number
  /** Environment the command inherits (defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

/** Raised when the signer command cannot produce a usable header. No request is sent upstream. */
export class SiwxSignerError extends Error {
  constructor(message: string) {
    super(`SIWX signer command ${message} No request was sent to Venice.`)
    this.name = 'SiwxSignerError'
  }
}

export const MAX_SIGNER_OUTPUT_BYTES = 64 * 1024
const MAX_STDERR_CHARS = 300
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/
const WITHHELD_ENV = ['VENICE_API_KEY', 'VENICE_SIWX_TOKEN', 'VENICE_SIWX_SIGNER_COMMAND']

export function runSiwxSigner(
  command: string,
  request: SiwxSignerRequest,
  opts: SiwxSignerOptions,
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) }
  for (const name of WITHHELD_ENV) delete env[name]
  env.VENICE_SIWX_BASE_URL = request.baseUrl
  env.VENICE_SIWX_REQUEST_METHOD = request.method
  env.VENICE_SIWX_REQUEST_PATH = request.path

  return new Promise((resolve, reject) => {
    let settled = false
    let stdoutBytes = 0
    const stdout: Buffer[] = []
    let stderr = ''

    const child = spawn(command, {
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const finish = (err: Error | undefined, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        reject(err)
      } else {
        resolve(value as string)
      }
    }

    const timer = setTimeout(() => {
      finish(new SiwxSignerError(`timed out after ${opts.timeoutMs}ms.`))
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_SIGNER_OUTPUT_BYTES) {
        finish(new SiwxSignerError(`printed more than ${MAX_SIGNER_OUTPUT_BYTES} bytes.`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS * 4)
    })
    child.on('error', (err) => {
      finish(new SiwxSignerError(`could not be started: ${err.message}.`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        const how = signal ? `was killed by ${signal}` : `exited with code ${code}`
        const detail = stderrTail(stderr)
        finish(new SiwxSignerError(`${how}${detail ? `: ${detail}` : ''}.`))
        return
      }
      const value = Buffer.concat(stdout).toString('utf8').trim()
      if (!value) {
        finish(new SiwxSignerError('printed nothing; expected a SIGN-IN-WITH-X value on stdout.'))
        return
      }
      if (!HEADER_VALUE.test(value)) {
        finish(
          new SiwxSignerError(
            'printed a value that is not a single line of printable ASCII; expected only the base64 SIGN-IN-WITH-X value on stdout.',
          ),
        )
        return
      }
      finish(undefined, value)
    })
  })
}

function stderrTail(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter((line) => line.trim())
  const last = lines.at(-1)?.trim() ?? ''
  return last.length > MAX_STDERR_CHARS ? `${last.slice(0, MAX_STDERR_CHARS)}…` : last
}
