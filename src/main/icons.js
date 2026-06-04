const { nativeImage } = require('electron')
const zlib = require('zlib')

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function createCirclePNG(size, r, g, b) {
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const radius = size / 2 - 1
  const rows = []

  for (let y = 0; y < size; y++) {
    rows.push(0) // filter: None
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      if (dist <= radius) {
        rows.push(r, g, b, 255)
      } else {
        rows.push(0, 0, 0, 0)
      }
    }
  }

  const rawBuf = Buffer.from(rows)
  const idat = zlib.deflateSync(rawBuf, { level: 6 })

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA color type

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ])
}

const STATE_COLORS = {
  idle:      [113, 113, 122], // zinc-500
  active:    [245, 158,  11], // amber-500
  recording: [ 34, 197,  94], // green-500
  error:     [239,  68,  68]  // red-500
}

function createTrayIcon(state) {
  const [r, g, b] = STATE_COLORS[state] ?? STATE_COLORS.idle
  const png = createCirclePNG(16, r, g, b)
  return nativeImage.createFromBuffer(png)
}

module.exports = { createTrayIcon }
