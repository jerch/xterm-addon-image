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
 * wasm base64 decoder.
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
    dec: () => 0,
    end: () => 0
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

    __attribute__((noinline)) int dec() {
      unsigned int nsp = (state->wp - 1) & ~3;
      unsigned char *src = state->data + state->sp;
      unsigned char *end = state->data + nsp;
      unsigned char *dst = state->data + state->dp;
      unsigned int accu;

      while (src < end) {
        if ((accu = D0[src[0]] | D1[src[1]] | D2[src[2]] | D3[src[3]]) >> 24) return 1;
        *((unsigned int *) dst) = accu;
        dst += 3;
        src += 4;
      }
      state->sp = nsp;
      state->dp = dst - state->data;
      return 0;
    }

    int end() {
      int rem = state->wp - state->sp;
      if (rem > 4 && dec()) return 1;
      rem = state->wp - state->sp;
      if (rem < 2) return 1;

      unsigned char *src = state->data + state->sp;
      unsigned int accu = D0[src[0]] | D1[src[1]];
      int dp = 1;
      if (rem > 2 && src[2] != 61) {
        accu |= D2[src[2]];
        dp++;
      }
      if (rem == 4 && src[3] != 61) {
        accu |= D3[src[3]];
        dp++;
      }
      if (accu >> 24) return 1;
      *((unsigned int *) (state->data + state->dp)) = accu;
      state->dp += dp;
      return state->dp != state->b_size;
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

// init decoder maps in LE order
const D = new Uint32Array(1024);
for (let i = 0; i < MAP.length; ++i) D[MAP[i]] = i << 2;
for (let i = 0; i < MAP.length; ++i) D[256 + MAP[i]] = i >> 4 | ((i << 4) & 0xFF) << 8;
for (let i = 0; i < MAP.length; ++i) D[512 + MAP[i]] = (i >> 2) << 8 | ((i << 6) & 0xFF) << 16;
for (let i = 0; i < MAP.length; ++i) D[768 + MAP[i]] = i << 16;

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
      this._inst = this._m32 = this._d = this._mem = null!;
    } else {
      this._m32[P32.STATE_WP] = 0;
      this._m32[P32.STATE_SP] = 0;
      this._m32[P32.STATE_DP] = 0;
    }
  }

  public init(size: number): void {
    let m = this._m32;
    const bytes = (Math.ceil(size / 3) + P32.STATE_DATA) * 4;
    if (!this._inst) {
      this._mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) });
      this._inst = wasmDecode({ env: { memory: this._mem } });
      m = new Uint32Array(this._mem.buffer, 0);
      m.set(D, P32.D0);
      this._d = new Uint8Array(this._mem.buffer, P32.STATE_DATA * 4);
    } else if (this._mem.buffer.byteLength < bytes) {
      this._mem.grow(Math.ceil((bytes - this._mem.buffer.byteLength) / 65536));
      m = new Uint32Array(this._mem.buffer, 0);
      this._d = new Uint8Array(this._mem.buffer, P32.STATE_DATA * 4);
    }
    m![P32.STATE_BSIZE] = size;
    size = Math.ceil(size / 3) * 4;
    m![P32.STATE_ESIZE] = size;
    m![P32.STATE_WP] = 0;
    m![P32.STATE_SP] = 0;
    m![P32.STATE_DP] = 0;
    this._m32 = m!;
  }

  public put(data: Uint32Array, start: number, end: number): number {
    if (!this._inst) return 1;
    const m = this._m32;
    if (end - start + m[P32.STATE_WP] > m[P32.STATE_ESIZE]) return 1;
    this._d.set(data.subarray(start, end), m[P32.STATE_WP]);
    m[P32.STATE_WP] += end - start;
    // max chunk in input handler is 2^17, try to run in "tandem mode"
    // also assures that we dont run into illegal offsets in the wasm part
    return m[P32.STATE_WP] - m[P32.STATE_SP] >= 131072 ? this._inst.exports.dec() : 0;
  }

  public end(): number {
    return this._inst ? this._inst.exports.end() : 1;
  }
}
