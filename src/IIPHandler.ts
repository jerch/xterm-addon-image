/**
 * Copyright (c) 2023 Joerg Breitbart.
 * @license MIT
 */

import { IOscHandler, IResetHandler, ITerminalExt } from './Types';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage, CELL_SIZE_DEFAULT } from './ImageStorage';
import { Base64Decoder } from './base64.wasm';
import { HeaderParser, IHeaderFields, HeaderState } from './IIPHeaderParser';


// eslint-disable-next-line
declare const Buffer: any;

// limit hold memory in base64 decoder
const KEEP_DATA = 4194304;

// default IIP header values
const DEFAULT_HEADER: IHeaderFields = {
  name: 'Unnamed file',
  size: 0,
  width: 'auto',
  height: 'auto',
  preserveAspectRatio: 1,
  inline: 0
};

type ImageType = 'image/png' | 'image/jpeg' | 'unsupported' | '';


export class IIPHandler implements IOscHandler, IResetHandler {
  private _aborted = false;
  private _hp = new HeaderParser();
  private _header: IHeaderFields = DEFAULT_HEADER;
  private _dec = new Base64Decoder(KEEP_DATA);
  private _mime: ImageType = '';
  private _width = 0;
  private _height = 0;

  constructor(
    private readonly _renderer: ImageRenderer,
    private readonly _storage: ImageStorage,
    private readonly _coreTerminal: ITerminalExt
  ) {}

  public reset(): void {}

  public start(): void {
    this._aborted = false;
    this._hp.reset();
    this._header = DEFAULT_HEADER;
    this._dec.release();
    this._mime  = '';
    this._width = 0;
    this._height = 0;
  }

  public put(data: Uint32Array, start: number, end: number): void {
    if (this._aborted) return;

    // TODO: abort on oversize in px & MB
    if (this._hp.state === HeaderState.END) {
      if (this._dec.put(data, start, end)) {
        console.warn('IIP: base64 decode error');
        this._aborted = true;
      }
    } else {
      const result = this._hp.parse(data, start, end);
      if (result === -1) {
        console.warn('IIP: header error');
        this._aborted = true;
        return;
      }
      if (result !== -2) {
        this._header = Object.assign({}, DEFAULT_HEADER, this._hp.fields);
        if (!this._header.inline || !this._header.size) {
          this._aborted = true;
          return;
        }
        this._dec.init(this._header.size);
        if (this._dec.put(data, result, end)) {
          console.warn('IIP: base64 decode error');
          this._aborted = true;
        }
      }
    }
    if (!this._mime && this._dec.data8.length > 24) {
      this._mime = guessType(this._dec.data8);
      if (this._mime === 'unsupported') {
        console.warn('IIP: unsupported image type');
        this._aborted = true;
      }
      if (this._mime === 'image/png') {
        [this._width, this._height] = DIM[this._mime](this._dec.data8);
        if (this._width * this._height > 25000000) {  // FIXME: map to ctor opts
          console.warn('IIP: image is too big');
          this._aborted = true;
        }
      }
    }
  }

  // FIXME: fix the mime & b64 decoder call and abort mess; call dec.release before abort
  public end(success: boolean): boolean | Promise<boolean> {
    if (this._aborted || !success) return true;

    // finalize base64 decoding, exit if base64 decoder yields less bytes than expected
    if (this._dec.end()) return true;
    if (!this._mime && this._dec.data8.length > 24) {  // FIXME: >24 is wrong this late...
      this._mime = guessType(this._dec.data8);
      if (this._mime === 'unsupported') {
        console.warn('IIP: unsupported image type');
        this._aborted = true;
        return true;
      }
      [this._width, this._height] = DIM[this._mime](this._dec.data8);
      if (!this._width || !this._height || this._width * this._height > 25000000) {  // FIXME: map to ctor opts
        console.warn('IIP: issue with image dimensions');
        this._aborted = true;
        return true;
      }
    }

    // TODO: merge into above...
    if (this._mime === 'image/jpeg') {
      [this._width, this._height] = DIM[this._mime](this._dec.data8);
      if (this._width * this._height > 25000000) {  // FIXME: map to ctor opts
        console.warn('IIP: image is too big');
        this._aborted = true;
      }
    }

    const blob = new Blob([this._dec.data8], { type: this._mime });
    this._dec.release();
    // return true;
    if (!this._width || !this._height) return true;
    const [w, h] = this._resize(this._width, this._height).map(Math.floor);

    return createImageBitmapShim(this._coreTerminal._core._coreBrowserService.window, blob, w, h)
      .then((obj: ImageBitmap | HTMLImageElement) => {
        if (!obj || !obj.width || !obj.height) return true;
        if (!(obj instanceof Image)) {
          this._storage.addImage(obj as unknown as HTMLCanvasElement);
          // FIXME: needs patches in ImageStorage (call ImageBitmap.close on evict, fix canvas getter)
          return true;
        }
        const canvas = ImageRenderer.createCanvas(
          this._coreTerminal._core._coreBrowserService.window, w, h);
        canvas.getContext('2d')?.drawImage(obj, 0, 0, w, h);
        this._storage.addImage(canvas);
        return true;
      })
      .catch(e => true);
  }

  private _resize(w: number, h: number): [number, number] {
    const cw = this._renderer.dimensions?.css.cell.width || CELL_SIZE_DEFAULT.width;
    const ch = this._renderer.dimensions?.css.cell.height || CELL_SIZE_DEFAULT.height;
    const width = this._renderer.dimensions?.css.canvas.width || cw * this._coreTerminal.cols;
    const height = this._renderer.dimensions?.css.canvas.height || ch * this._coreTerminal.rows;

    const rw = this._dim(this._header.width!, width, cw);
    const rh = this._dim(this._header.height!, height, ch);
    if (!rw && !rh) {
      const wf = width / w;         // TODO: should this respect initial cursor offset?
      const hf = (height - ch) / h; // TODO: fix offset issues from float cell height
      const f = Math.min(wf, hf);
      return f < 1 ? [w * f, h * f] : [w, h];
    }
    return !rw
      ? [w * rh / h, rh]
      : this._header.preserveAspectRatio || !rw || !rh
        ? [rw, h * rw / w] : [rw, rh];
  }

  private _dim(s: string, total: number, cdim: number): number {
    if (s === 'auto') return 0;
    if (s.endsWith('%')) return parseInt(s.slice(0, -1)) * total / 100;
    if (s.endsWith('px')) return parseInt(s.slice(0, -2));
    return parseInt(s) * cdim;
  }
}

/** safari helper to mimick createImageBitmap */
function createImageBitmapShim(window: Window, blob: Blob, w: number, h: number): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof window.createImageBitmap === 'undefined') {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    return new Promise<HTMLImageElement>(resolve => {
      img.addEventListener('load', () => {
        URL.revokeObjectURL(url);
        resolve(img);
      });
      // sanity measure to avoid terminal blocking from dangling promise
      // happens from corrupt data (onload never gets fired)
      setTimeout(() => resolve(img), 1000);
      img.src = url;
    });
  }
  return window.createImageBitmap(blob, { resizeWidth: w, resizeHeight: h });
}


function guessType(d: Uint8Array): ImageType {
  const d32 = new Uint32Array(d.buffer, d.byteOffset, 6);
  if (d32[0] === 0x474E5089 && d32[1] === 0x0A1A0A0D && d32[3] === 0x52444849) return 'image/png';
  if ((d32[0] === 0xE0FFD8FF || d32[0] === 0xE1FFD8FF)
    &&  (
      (d[6] === 0x4a && d[7] === 0x46 && d[8] === 0x49 && d[9] === 0x46)
        ||  (d[6] === 0x45 && d[7] === 0x78 && d[8] === 0x69 && d[9] === 0x66)
    )
  ) return 'image/jpeg';
  return 'unsupported';
}

const DIM: {[key in ImageType]: (d: Uint8Array) => [number, number]} = {
  '': d => [0, 0],
  'unsupported': d => [0, 0],
  'image/png': d => [
    d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19],
    d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]
  ],
  'image/jpeg': d => {
    const len = d.length;
    let i = 4;
    let blockLength = d[i] << 8 | d[i + 1];
    while (true) {
      i += blockLength;
      if (i >= len) {
        // exhausted without size info
        return [0, 0];
      }
      if (d[i] !== 0xFF) {
        return [0, 0];
      }
      if (d[i + 1] === 0xC0 || d[i + 1] === 0xC2) {
        if (i + 8 < len) {
          return [
            d[i + 7] << 8 | d[i + 8],
            d[i + 5] << 8 | d[i + 6]
          ];
        }
        return [0, 0];
      }
      i += 2;
      blockLength = d[i] << 8 | d[i + 1];
    }
  }
};
