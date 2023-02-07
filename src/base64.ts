// base64 map
const MAP = new Uint8Array(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .split('')
    .map(el => el.charCodeAt(0))
);
const PAD = 61; // 0x3D =

function initDecodeMap(map: Uint32Array, shift: number): void {
  map.fill(3 << 24);
  for (let i = 0; i < MAP.length; ++i) {
    map[MAP[i]] = i << shift;
  }
}

// decoder maps
const D0 = new Uint32Array(256);
const D1 = new Uint32Array(256);
const D2 = new Uint32Array(256);
const D3 = new Uint32Array(256);
initDecodeMap(D0, 18);
initDecodeMap(D1, 12);
initDecodeMap(D2, 6);
initDecodeMap(D3, 0);

/**
 * base64 streamline inplace decoder.
 *
 * Features / assumptions:
 * - optimized uint32 read (only LE support!)
 * - errors out on any non base64 chars (no support for NL formatted base64)
 * - decodes in 2^18 byte chunks for better perf
 * - inplace overwrite to save memory
 * - supports a keepSize for lazy memory release
 */
export class ChunkInplaceDecoder {
  public wp = 0;          // write position of input data
  public sp = 0;          // read position of input data
  public dp = 0;          // write position of decode
  public eSize = 0;       // encoded size == max data container size
  public bSize = 0;       // byte size

  private _d!: Uint8Array;
  private _d32!: Uint32Array;

  constructor(public keepSize: number) {}

  public get data8(): Uint8Array {
    return this._d.subarray(0, this.dp);
  }

  public release(): void {
    if (this._d && this._d.length > this.keepSize) {
      this.init(0);
    }
    this.wp = 0;
    this.sp = 0;
    this.dp = 0;
  }

  public init(size: number): void {
    this.bSize = size;
    size = Math.ceil(size / 3) * 4;
    this.eSize = size;
    if (!this._d || size > this._d.length) {
      this._d = new Uint8Array(size);
      this._d32 = new Uint32Array(this._d.buffer, 0, Math.floor(size / 4));
    }
    this.wp = 0;
    this.sp = 0;
    this.dp = 0;
  }

  public put(data: Uint8Array | Uint16Array | Uint32Array, start: number, end: number): boolean {
    if (end - start + this.wp > this.eSize) return true;
    // NOTE: the uint32 to uint8 reduction is quite costly (~30% of decoder runtime)
    this._d.set(data.subarray(start, end), this.wp);
    this.wp += end - start;
    // aggregate _dec calls into 2^18 bytes
    return this.wp - this.sp > 262144 ? this._dec() : false;
  }

  // hot path to run as tight as possible
  // TODO: replace by wasm logic
  private _dec(): boolean {
    const nsp = (this.wp - 1) & ~3;
    const s = this._d32.subarray(this.sp >> 2, nsp >> 2);
    const d = this._d.subarray(this.dp);
    let sp = 0;
    let dp = 0;
    while (sp < s.length) {
      const v = s[sp++];
      const accu = D0[v & 255] | D1[(v >> 8) & 255] | D2[(v >> 16) & 255] | D3[v >> 24];
      if (accu >> 24) return true;
      d[dp] = accu >> 16;
      d[dp+1] = accu >> 8;
      d[dp+2] = accu;
      dp += 3;
    }
    this.sp = nsp;
    this.dp += dp;
    return false;
  }

  private _fin(v0: number, v1: number, v2: number, v3: number): boolean {
    const d = this._d;
    if (v2 === PAD) {
      const accu = D0[v0] | D1[v1];
      if (accu >> 24) return true;
      d[this.dp++] = accu >> 16;
      return this.dp !== this.bSize;
    }
    if (v3 === PAD) {
      const accu = D0[v0] | D1[v1] | D2[v2];
      if (accu >> 24) return true;
      d[this.dp++] = accu >> 16;
      d[this.dp++] = (accu >> 8) & 0xFF;
      return this.dp !== this.bSize;
    }
    const accu = D0[v0] | D1[v1] | D2[v2] | D3[v3];
    if (accu >> 24) return true;
    d[this.dp++] = accu >> 16;
    d[this.dp++] = (accu >> 8) & 0xFF;
    d[this.dp++] = accu & 0xFF;
    return this.dp !== this.bSize;
  }

  public end(): boolean {
    let rem = this.wp - this.sp;
    if (rem > 4) {
      if (this._dec()) return true;
      rem = this.wp - this.sp;
    }
    const d = this._d;
    const p = this.sp;
    return !rem
      ? true
      : rem === 1
        ? true
        : this._fin(
          d[p],
          d[p + 1],
          rem > 2 ? d[p + 2] : PAD,
          rem === 4 ? d[p + 3] : PAD);
  }
}
