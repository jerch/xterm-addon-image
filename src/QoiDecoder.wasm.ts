import { InWasm, OutputMode, OutputType, IWasmInstance } from 'inwasm';

const DST_P = 1024;

const wasmQoiDecode = InWasm({
  name: 'qoi_decode',
  type: OutputType.INSTANCE,
  mode: OutputMode.SYNC,
  srctype: 'Clang-C',
  imports: {
    env: { memory: new WebAssembly.Memory({ initial: 1 }) }
  },
  exports: {
    dec: (bytes: number, length: number, pixels: number) => {}
  },
  compile: {
    switches: ['-mbulk-memory', '-Wl,-z,stack-size=0', '-Wl,--stack-first']
  },
  code: `
  #define QOI_OP_INDEX  0x00 /* 00xxxxxx */
  #define QOI_OP_DIFF   0x40 /* 01xxxxxx */
  #define QOI_OP_LUMA   0x80 /* 10xxxxxx */
  #define QOI_OP_RUN    0xc0 /* 11xxxxxx */
  #define QOI_OP_RGB    0xfe /* 11111110 */
  #define QOI_OP_RGBA   0xff /* 11111111 */

  #define QOI_MASK_2    0xc0 /* 11000000 */

  #define QOI_COLOR_HASH(C) ((C.c.r*3 + C.c.g*5 + C.c.b*7 + C.c.a*11) & 63)

  typedef union {
    struct { unsigned char r, g, b, a; } c;
    unsigned int v;
  } qoi_rgba_t;

  static qoi_rgba_t index[64];

  void dec(const unsigned char* bytes, int length, int pixels) {
    qoi_rgba_t px;
    qoi_rgba_t* dst = (qoi_rgba_t *) ${DST_P};
    qoi_rgba_t* dst_end = dst + pixels;
    const unsigned char* rp = bytes + 14;
    const unsigned char* end = bytes + length - 8;

    __builtin_memset(index, 0, sizeof(index));
    px.v = 0xFF000000;
  
    unsigned int b1, hi, lo;
    while (rp < end) {
      b1 = *rp++;
      hi = b1 & QOI_MASK_2;
      lo = b1 & 0x3f;
      if (!hi) {
        px = index[lo];
        *dst++ = px;
      }
      else if (hi == QOI_OP_RUN && b1 < QOI_OP_RGB) {
        index[QOI_COLOR_HASH(px)] = px;
        do {
          *dst++ = px;
        } while (lo-- && dst < dst_end);
      }
      else {
        if (b1 == QOI_OP_RGB) {
          px.c.r = *rp++;
          px.c.g = *rp++;
          px.c.b = *rp++;
        }
        else if (b1 == QOI_OP_RGBA) {
          px.v = *((unsigned int *) rp);
          rp += 4;
        }
        else if (hi == QOI_OP_DIFF) {
          px.c.r += ((lo >> 4) & 0x03) - 2;
          px.c.g += ((lo >> 2) & 0x03) - 2;
          px.c.b += ( lo       & 0x03) - 2;
        }
        else if (hi == QOI_OP_LUMA) {
          int b2 = *rp++;
          int vg = lo - 32;
          px.c.r += vg - 8 + ((b2 >> 4) & 0x0f);
          px.c.g += vg;
          px.c.b += vg - 8 +  (b2       & 0x0f);
        }
        index[QOI_COLOR_HASH(px)] = px;
        *dst++ = px;
      }
    }
  }
`
});

type ExtractDefinition<Type> = Type extends () => IWasmInstance<infer X> ? X : never;
type QoiDecode = ExtractDefinition<typeof wasmQoiDecode>;

export class QoiDecoder {
  private _inst!: IWasmInstance<QoiDecode>;
  private _mem!: WebAssembly.Memory;
  private _d!: Uint8Array;
  public width = 0;
  public height = 0;

  constructor(public keepSize: number) {}

  public decode(d: Uint8Array): Uint8Array {
    this.width = d[4] << 24 | d[5] << 16 | d[6] << 8 | d[7];
    this.height = d[8] << 24 | d[9] << 16 | d[10] << 8 | d[11];
    const pixels = this.width * this.height;
    const ib = pixels * 4;
    const dl = d.length;
    /**
     * byte/offset calculation:
     * To save some memory we dont reserve full memory for decoded + encoded,
     * but place encoded at the end of decoded plus 50% security distance
     * to avoid reads before writes positions:
     * 
     * encoded < decoded (good compression)
     *    enc                                              ####################
     *    dec                 #######################################
     *                        ^                            ^
     *                        DST_P                        CHUNK_P
     * 
     * encoded > decoded (degenerated compression, should not happen)
     *    enc                           ##############################
     *    dec                 ####################
     *                        ^         ^
     *                        DST_P     CHUNK_P
     * 
     * There is still a chance for overlapping r/w positions in case the compressed
     * data has very different pixel progression, yet the 50% security distance
     * should deal with that, as QOI will bloat data by 25% at max (RGB -> OP byte + RGB).
     * Since we always assume RGBA at decoding stage, the possible bloat reduces to 20% at max.
     */
    const bytes = Math.max(ib, dl) + (Math.min(ib, dl) >> 1) + 4096;
    if (!this._inst) {
      this._mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) });
      this._inst = wasmQoiDecode({ env: { memory: this._mem } });
    } else if (this._mem.buffer.byteLength < bytes) {
      this._mem.grow(Math.ceil((bytes - this._mem.buffer.byteLength) / 65536));
      this._d = null!;
    }
    if (!this._d) {
      this._d = new Uint8Array(this._mem.buffer);
    }
    // put src data at the end of memory, also align to 256
    const chunk_p = (this._mem.buffer.byteLength - dl) & ~0xFF;
    this._d.set(d, chunk_p);
    this._inst.exports.dec(chunk_p, dl, pixels);
    return this._d.subarray(DST_P, DST_P + ib);
  }

  public release(): void {
    if (!this._inst) return;
    if (this._mem.buffer.byteLength > this.keepSize) {
      this._inst = this._d = this._mem = null!;
    }
  }
}
