import { InWasm, OutputMode, OutputType, IWasmInstance } from 'inwasm';

const DST_P = 1024;

const wasmQoiEncode = InWasm({
  name: 'qoi_encode',
  type: OutputType.INSTANCE,
  mode: OutputMode.SYNC,
  srctype: 'Clang-C',
  imports: {
    env: { memory: new WebAssembly.Memory({ initial: 1 }) }
  },
  exports: {
    enc: (bytes: number, width: number, height: number) => 0
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

  void* enc(const void *data, int width, int height) {
    qoi_rgba_t px, px_prev;
    unsigned int run = 0;
    unsigned int px_amount = width * height;
    qoi_rgba_t *pixels = (qoi_rgba_t *) data;
    qoi_rgba_t *pixels_end = pixels + px_amount;
  
    unsigned char *bytes = (unsigned char *) ${DST_P};

    // wasm is always LE, simply call clang's bswap32
    *((unsigned int *) bytes) = 0x66696F71; // QOI_MAGIC
    *((unsigned int *) bytes+1) = __builtin_bswap32(width);
    *((unsigned int *) bytes+2) = __builtin_bswap32(height);
    bytes += 12;

    *bytes++ = 4;
    *bytes++ = 0;
  
    __builtin_memset(index, 0, sizeof(index));
    px.v = 0xFF000000;
    px_prev = px;

    while (pixels < pixels_end) {
      px = *pixels++;
  
      if (px.v == px_prev.v) {
        run++;
        if (run == 62 || pixels == pixels_end) {
          *bytes++ = QOI_OP_RUN | (run - 1);
          run = 0;
        }
      }
      else {
        if (run) {
          *bytes++ = QOI_OP_RUN | (run - 1);
          run = 0;
        }
        int index_pos = QOI_COLOR_HASH(px);

        if (index[index_pos].v == px.v) {
          *bytes++ = QOI_OP_INDEX | index_pos;
        }
        else {
          index[index_pos] = px;

          if (px.c.a == px_prev.c.a) {
            unsigned int vr = px.c.r - px_prev.c.r;
            unsigned int vg = px.c.g - px_prev.c.g;
            unsigned int vb = px.c.b - px_prev.c.b;
            unsigned int vg_r = vr - vg;
            unsigned int vg_b = vb - vg;

            if ((vr + 2) < 4 && (vg + 2) < 4 && (vb + 2) < 4) {
              *bytes++ = QOI_OP_DIFF | (vr + 2) << 4 | (vg + 2) << 2 | (vb + 2);
            }
            else if ((vg_r + 8) < 16 && (vg + 32) < 64 && (vg_b + 8) < 16) {
              *bytes++ = QOI_OP_LUMA     | (vg   + 32);
              *bytes++ = (vg_r + 8) << 4 | (vg_b +  8);
            }
            else {
              *((unsigned int *) bytes) = px.v << 8 | QOI_OP_RGB;
              bytes += 4;
            }
          }

          else {
            *bytes++ = QOI_OP_RGBA;
            *((unsigned int *) bytes) = px.v;
            bytes += 4;
          }
        }
      }
      px_prev = px;
    }
    *((unsigned int *) bytes) = 0;
    *((unsigned int *) bytes+1) = 0x1000000;
    bytes += 8;
  
    return bytes;
  }
`
});

type ExtractDefinition<Type> = Type extends () => IWasmInstance<infer X> ? X : never;
type QoiEncode = ExtractDefinition<typeof wasmQoiEncode>;

export class QoiEncoder {
  private _inst!: IWasmInstance<QoiEncode>;
  private _mem!: WebAssembly.Memory;
  private _d!: Uint8Array;

  constructor(public keepSize: number) {}

  public encode(d: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
    // max_size = desc->width * desc->height * (desc->channels + 1) + QOI_HEADER_SIZE + sizeof(qoi_padding);
    const encLen = width * height * 5 + 22;
    const bytes = (d.length >> 1) + encLen + 4096;
    if (!this._inst) {
      this._mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) });
      this._inst = wasmQoiEncode({ env: { memory: this._mem } });
    } else if (this._mem.buffer.byteLength < bytes) {
      this._mem.grow(Math.ceil((bytes - this._mem.buffer.byteLength) / 65536));
      this._d = null!;
    }
    if (!this._d) {
      this._d = new Uint8Array(this._mem.buffer);
    }
    // put src data at the end of memory, also align to 256
    const chunkP = (this._mem.buffer.byteLength - d.length) & ~0xFF;
    this._d.set(d, chunkP);
    const end = this._inst.exports.enc(chunkP, width, height);
    return this._d.subarray(DST_P, end);
  }

  public release(): void {
    if (!this._inst) return;
    if (this._mem.buffer.byteLength > this.keepSize) {
      this._inst = this._d = this._mem = null!;
    }
  }
}
