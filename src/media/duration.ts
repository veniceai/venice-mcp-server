/**
 * Read clip durations from MP4/MOV (ISO BMFF) bytes so cost quotes can
 * include reference-video length without probing the file with ffmpeg.
 */

interface Box {
  start: number
  end: number
}

function findBox(buf: Buffer, start: number, end: number, type: string): Box | undefined {
  let offset = start
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) return undefined
      size = Number(buf.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) return undefined
    if (buf.toString('ascii', offset + 4, offset + 8) === type) return { start: offset + header, end: offset + size }
    offset += size
  }
  return undefined
}

/** Duration in seconds from the movie header (moov/mvhd), or undefined when it can't be read. */
export function isoBmffDurationSeconds(buf: Buffer): number | undefined {
  const moov = findBox(buf, 0, buf.length, 'moov')
  const mvhd = moov && findBox(buf, moov.start, moov.end, 'mvhd')
  if (!mvhd) return undefined
  const version = buf[mvhd.start]
  const [timescaleAt, durationAt, durationBytes] = version === 1 ? [20, 24, 8] : [12, 16, 4]
  if (mvhd.start + durationAt + durationBytes > mvhd.end) return undefined
  const timescale = buf.readUInt32BE(mvhd.start + timescaleAt)
  const duration = durationBytes === 8 ? Number(buf.readBigUInt64BE(mvhd.start + durationAt)) : buf.readUInt32BE(mvhd.start + durationAt)
  if (timescale === 0) return undefined
  return duration / timescale
}

/** Duration in seconds of a base64 MP4/MOV data: URL, or undefined for anything else. */
export function dataUrlVideoDurationSeconds(value: string): number | undefined {
  const match = /^data:[^,]*;base64,/i.exec(value)
  if (!match) return undefined
  return isoBmffDurationSeconds(Buffer.from(value.slice(match[0].length), 'base64'))
}
