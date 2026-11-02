/** Sparse, paged, little-endian byte-addressable memory. */
const PAGE_BITS = 12
const PAGE_SIZE = 1 << PAGE_BITS

export class Memory {
  private pages = new Map<number, Uint8Array>()

  private page(addr: number, create: boolean): Uint8Array | undefined {
    const n = Math.floor(addr / PAGE_SIZE)
    let p = this.pages.get(n)
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE)
      this.pages.set(n, p)
    }
    return p
  }

  readByte(addr: number): number {
    const p = this.page(addr, false)
    return p ? p[addr & (PAGE_SIZE - 1)] : 0
  }

  writeByte(addr: number, v: number) {
    this.page(addr, true)![addr & (PAGE_SIZE - 1)] = v & 0xff
  }

  readBytes(addr: number, n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = this.readByte(addr + i)
    return out
  }

  writeBytes(addr: number, bytes: ArrayLike<number>) {
    for (let i = 0; i < bytes.length; i++) this.writeByte(addr + i, bytes[i])
  }

  /** Little-endian read: the byte at the lowest address is the least significant. */
  read(addr: number, size: number): bigint {
    let v = 0n
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.readByte(addr + i))
    return v
  }

  write(addr: number, size: number, value: bigint) {
    let v = value
    for (let i = 0; i < size; i++) {
      this.writeByte(addr + i, Number(v & 0xffn))
      v >>= 8n
    }
  }
}
