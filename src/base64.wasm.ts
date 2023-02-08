/**
 * Copyright (c) 2023 Joerg Breitbart.
 * @license MIT
 */

import { InWasm, IWasmInstance, OutputMode, OutputType } from 'inwasm';


// memory addresses in uint32
const enum P32 {
  D0 = 256,
  D1 = 512,
  D2 = 768,
  D3 = 1024,
  STATE = 1280,
  STATE_WP = 1280,
  STATE_SP = 1281,
  STATE_DP = 1282,
  STATE_ESIZE = 1283,
  STATE_BSIZE = 1284,
  STATE_DATA = 1285
}

/**
 * base64 decoder in uint32.
 */
const wasmDecode = InWasm({
  name: 'decode',
  type: OutputType.INSTANCE,
  mode: OutputMode.SYNC,
  srctype: 'Clang-C',
  imports: {
    env: { memory: new WebAssembly.Memory({ initial: 1 }) }
  },
  exports: {
    dec: () => 0
  },
  compile: {
    switches: ['-Wl,-z,stack-size=0', '-Wl,--stack-first']
  },
  code: `
    typedef struct {
      unsigned int wp;
      unsigned int sp;
      unsigned int dp;
      unsigned int e_size;
      unsigned int b_size;
      unsigned char data[0];
    } State;

    unsigned int *D0 = (unsigned int *) ${P32.D0*4};
    unsigned int *D1 = (unsigned int *) ${P32.D1*4};
    unsigned int *D2 = (unsigned int *) ${P32.D2*4};
    unsigned int *D3 = (unsigned int *) ${P32.D3*4};
    State *state = (State *) ${P32.STATE*4};

    int dec() {
      unsigned int nsp = (state->wp - 1) & ~3;
      unsigned char *src = state->data + state->sp;
      unsigned char *src_end = state->data + nsp;
      unsigned char *dst = state->data + state->dp;
      unsigned int accu;

      while (src < src_end) {
        if ((accu = D0[*src] | D1[*(src+1)] | D2[*(src+2)] | D3[*(src+3)]) >> 24) return 1;
        *((unsigned int *) dst) = accu;
        dst += 3;
        src += 4;
      }
      state->sp = nsp;
      state->dp = dst - state->data;
      return 0;
    }
    `
});
// FIXME: currently broken in inwasm
type ExtractDefinition<Type> = Type extends () => IWasmInstance<infer X> ? X : never;
type DecodeDefinition = ExtractDefinition<typeof wasmDecode>;


// base64 map
const MAP = new Uint8Array(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .split('')
    .map(el => el.charCodeAt(0))
);
const PAD = 61; // 0x3D =

// init decoder maps in LE order
const D = new Uint32Array(1024);
const D0 = D.subarray(0, 256);
const D1 = D.subarray(256, 512);
const D2 = D.subarray(512, 768);
const D3 = D.subarray(768, 1024);
for (let i = 0; i < MAP.length; ++i) D0[MAP[i]] = i << 2;
for (let i = 0; i < MAP.length; ++i) D1[MAP[i]] = i >> 4 | ((i << 4) & 0xFF) << 8;
for (let i = 0; i < MAP.length; ++i) D2[MAP[i]] = (i >> 2) << 8 | ((i << 6) & 0xFF) << 16;
for (let i = 0; i < MAP.length; ++i) D3[MAP[i]] = i << 16;

const EMPTY = new Uint8Array(0);


/**
 * base64 streamline inplace decoder.
 *
 * Features / assumptions:
 * - optimized uint32 read (only LE support!)
 * - errors out on any non base64 chars (no support for NL formatted base64)
 * - decodes in wasm
 * - inplace overwrite to save memory
 * - supports a keepSize for lazy memory release
 */
export class ChunkInplaceDecoder {
  private _d!: Uint8Array;
  private _m32!: Uint32Array;
  private _inst!: IWasmInstance<DecodeDefinition>;
  private _mem!: WebAssembly.Memory;

  constructor(public keepSize: number) {}

  public get data8(): Uint8Array {
    return this._inst ? this._d.subarray(0, this._m32[P32.STATE_DP]) : EMPTY;
  }

  public release(): void {
    if (!this._inst) return;
    if (this._d.length > this.keepSize) {
      this.init(1);
    }
    this._m32[P32.STATE_WP] = 0;
    this._m32[P32.STATE_SP] = 0;
    this._m32[P32.STATE_DP] = 0;
  }

  public init(size: number): void {
    const bytes = (Math.ceil(size / 3) + P32.STATE_DATA) * 4;
    if (!this._inst) {
      this._mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) });
      this._inst = wasmDecode({ env: { memory: this._mem } });
      this._m32 = new Uint32Array(this._mem.buffer, 0);
      this._m32.set(D, P32.D0);
      this._d = new Uint8Array(this._mem.buffer, P32.STATE_DATA * 4);
    } else if (this._mem.buffer.byteLength < bytes) {
      this._mem.grow(Math.ceil((bytes - this._mem.buffer.byteLength) / 65536));
      this._m32 = new Uint32Array(this._mem.buffer, 0);
      this._d = new Uint8Array(this._mem.buffer, P32.STATE_DATA * 4);
    }
    this._m32[P32.STATE_BSIZE] = size;
    size = Math.ceil(size / 3) * 4;
    this._m32[P32.STATE_ESIZE] = size;
    this._m32[P32.STATE_WP] = 0;
    this._m32[P32.STATE_SP] = 0;
    this._m32[P32.STATE_DP] = 0;
  }

  public put(data: Uint8Array | Uint16Array | Uint32Array, start: number, end: number): number {
    const m = this._m32;
    if (end - start + m[P32.STATE_WP] > m[P32.STATE_ESIZE]) return 1;
    // NOTE: the uint32 to uint8 reduction is quite costly (~30% of decoder runtime)
    this._d.set(data.subarray(start, end), m[P32.STATE_WP]);
    m[P32.STATE_WP] += end - start;
    return this._inst.exports.dec();
  }

  // TODO: move to wasm
  private _fin(v0: number, v1: number, v2: number, v3: number): boolean {
    const d = this._d;
    const m = this._m32;
    if (v2 === PAD) {
      const accu = D0[v0] | D1[v1];
      if (accu >> 24) return true;
      d[m[P32.STATE_DP]++] = accu;
      return m[P32.STATE_DP] !== m[P32.STATE_BSIZE];
    }
    if (v3 === PAD) {
      const accu = D0[v0] | D1[v1] | D2[v2];
      if (accu >> 24) return true;
      d[m[P32.STATE_DP]++] = accu;
      d[m[P32.STATE_DP]++] = accu >> 8;
      return m[P32.STATE_DP] !== m[P32.STATE_BSIZE];
    }
    const accu = D0[v0] | D1[v1] | D2[v2] | D3[v3];
    if (accu >> 24) return true;
    d[m[P32.STATE_DP]++] = accu;
    d[m[P32.STATE_DP]++] = accu >> 8;
    d[m[P32.STATE_DP]++] = accu >> 16;
    return m[P32.STATE_DP] !== m[P32.STATE_BSIZE];
  }

  // TODO: move to wasm
  public end(): boolean {
    const d = this._d;
    const m = this._m32;
    const p = m[P32.STATE_SP];
    let rem = m[P32.STATE_WP] - m[P32.STATE_SP];
    if (rem > 4) {
      if (this._inst.exports.dec()) return true;
      rem = m[P32.STATE_WP] - m[P32.STATE_SP];
    }
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
