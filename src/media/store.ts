/**
 * Local media output. When `VENICE_MEDIA_DIR` is configured, generated
 * media is written to disk and tools return a file:// resource link plus a
 * JSON sidecar, so timeline editors (DaVinci Resolve, Premiere, Final Cut,
 * etc.) can import the result directly. Without it, tools keep returning
 * inline base64 content.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type MediaKind = 'image' | 'video' | 'music' | 'speech'

export interface SavedMedia {
  path: string
  fileUrl: string
  sidecarPath: string
  mimeType: string
  bytes: number
}

export interface SaveMediaInput {
  kind: MediaKind
  buffer: Buffer
  mimeType: string
  /** Prompt or short label used to build a readable filename. */
  label?: string
  /** Free-form generation metadata persisted next to the file. */
  metadata: Record<string, unknown>
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/pcm': 'pcm',
  'audio/L16': 'pcm',
}

export function extensionForMime(mimeType: string, fallback = 'bin'): string {
  const base = mimeType.split(';', 1)[0].trim().toLowerCase()
  return MIME_EXTENSIONS[base] ?? fallback
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function slugify(label: string | undefined, max = 40): string {
  const slug = (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'venice'
}

function timestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

export class MediaStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(expandHome(rootDir))
  }

  async save(input: SaveMediaInput): Promise<SavedMedia> {
    const dir = join(this.rootDir, input.kind)
    await mkdir(dir, { recursive: true })
    const ext = extensionForMime(input.mimeType)
    const base = `${timestamp()}-${slugify(input.label)}`
    let path = join(dir, `${base}.${ext}`)
    // Two generations in the same second with the same label are plausible
    // (image variants); `wx` refuses to clobber and we retry with a suffix.
    for (let attempt = 1; ; attempt++) {
      try {
        await writeFile(path, input.buffer, { flag: 'wx' })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 99) throw err
        path = join(dir, `${base}-${attempt}.${ext}`)
      }
    }
    const sidecarPath = `${path.slice(0, -extname(path).length)}.json`
    const sidecar = {
      file: path,
      mime_type: input.mimeType,
      bytes: input.buffer.length,
      created_at: new Date().toISOString(),
      generator: 'venice',
      ...input.metadata,
    }
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2))
    return {
      path,
      fileUrl: pathToFileURL(path).href,
      sidecarPath,
      mimeType: input.mimeType,
      bytes: input.buffer.length,
    }
  }
}
