/**
 * Local file inputs. Venice media endpoints accept `data:` URLs for every
 * `*_url` parameter, so an absolute local path (or file:// URL) can be inlined
 * without hosting it anywhere. Remote http(s) and data: values pass through
 * untouched.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './store.js'

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
}

export interface LocalInputOptions {
  maxBytes: number
  label: string
}

/** Returns the filesystem path if `value` refers to a local file, else undefined. */
export function localPathFromInput(value: string): string | undefined {
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value)
    } catch {
      return undefined
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : undefined
}

export interface LocalUploadSource {
  buffer: Buffer
  contentType: string
  filename: string
}

/** Read a local file for multipart upload. Returns undefined when `value` is not a local path. */
export async function readLocalUploadSource(
  value: string,
  opts: LocalInputOptions,
): Promise<LocalUploadSource | undefined> {
  const path = localPathFromInput(value)
  if (!path) return undefined
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) {
    throw new Error(`${opts.label}: local file not found: ${path}`)
  }
  if (info.size > opts.maxBytes) {
    throw new Error(
      `${opts.label}: ${path} is ${info.size} bytes, above the ${opts.maxBytes}-byte local input limit (VENICE_MAX_LOCAL_INPUT_BYTES).`,
    )
  }
  const ext = extname(path).slice(1).toLowerCase()
  const contentType = EXTENSION_MIME[ext]
  if (!contentType) {
    throw new Error(`${opts.label}: unsupported local file type ".${ext}". Supported: ${Object.keys(EXTENSION_MIME).join(', ')}`)
  }
  return { buffer: await readFile(path), contentType, filename: basename(path) }
}

export async function resolveMediaInput(value: string, opts: LocalInputOptions): Promise<string> {
  const source = await readLocalUploadSource(value, opts)
  if (!source) return value
  return `data:${source.contentType};base64,${source.buffer.toString('base64')}`
}

export async function resolveMediaInputs(
  values: string[] | undefined,
  opts: LocalInputOptions,
): Promise<string[] | undefined> {
  if (!values) return undefined
  return Promise.all(values.map((v, i) => resolveMediaInput(v, { ...opts, label: `${opts.label}[${i}]` })))
}
