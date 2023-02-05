/**
 * Copyright (c) 2023 Joerg Breitbart.
 * @license MIT
 */

import { IOscHandler, IResetHandler, ITerminalExt } from './Types';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage, CELL_SIZE_DEFAULT } from './ImageStorage';
import { Base64 } from './base64';


const FILE_MARKER = [70, 105, 108, 101];
const MAX_FIELDCHARS = 1024;
const MAX_DATA = 4194304;

const enum HeaderState {
  START = 0,
  ABORT = 1,
  KEY = 2,
  VALUE = 3,
  END = 4
}

interface IHeaderFields {
  // base-64 encoded filename. Defaults to "Unnamed file".
  name: string;
  // File size in bytes. The file transfer will be canceled if this size is exceeded.
  size: number;
  /**
   * Optional width and height to render:
   * - N: N character cells.
   * - Npx: N pixels.
   * - N%: N percent of the session's width or height.
   * - auto: The image's inherent size will be used to determine an appropriate dimension.
   */
  width?: string;
  height?: string;
  // Optional, defaults to 1 respecting aspect ratio (width takes precedence).
  preserveAspectRatio?: number;
  // Optional, defaults to 0. If set to 1, the file will be displayed inline, else downloaded (download not supported).
  inline?: number;
}

const DEFAULT_HEADER: IHeaderFields = {
  name: 'Unnamed file',
  size: 0,
  width: 'auto',
  height: 'auto',
  preserveAspectRatio: 1,
  inline: 0
};

// field value decoders

// ASCII bytes to string
function toStr(data: Uint32Array): string {
  let s = '';
  for (let i = 0; i < data.length; ++i) {
    s += String.fromCharCode(data[i]);
  }
  return s;
}

// digits to integer
function toInt(data: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < data.length; ++i) {
    if (data[i] < 48 || data[i] > 57) {
      throw new Error('illegal char');
    }
    v = v * 10 + data[i] - 48;
  }
  return v;
}

// check for correct size entry
function toSize(data: Uint32Array): string {
  const v = toStr(data);
  if (!v.match(/^((auto)|(\d+?((px)|(%)){0,1}))$/)) {
    throw new Error('illegal size');
  }
  return v;
}

// name is base64 encoded utf-8
function toName(data: Uint32Array): string {
  const bs = atob(toStr(data));  // TODO: needs nodejs workaround
  const b = new Uint8Array(bs.length);
  for (let i = 0; i < b.length; ++i) {
    b[i] = bs.charCodeAt(i);
  }
  return new TextDecoder().decode(b);
}

const DECODERS: {[key: string]: (v: Uint32Array) => any} = {
  inline: toInt,
  size: toInt,
  name: toName,
  width: toSize,
  height: toSize,
  preserveAspectRatio: toInt
};

class HeaderParser {
  public state: HeaderState = HeaderState.START;
  private _buffer = new Uint32Array(MAX_FIELDCHARS);
  private _position = 0;
  private _key = '';
  public fields: {[key: string]: any} = {};

  public reset(): void {
    this._buffer.fill(0);
    this.state = HeaderState.START;
    this._position = 0;
    this.fields = {};
    this._key = '';
  }

  public parse(data: Uint32Array, start: number, end: number): number {
    let state = this.state;
    let pos = this._position;
    const buffer = this._buffer;
    if (state === HeaderState.ABORT || state === HeaderState.END) return -1;
    if (state === HeaderState.START && pos > 6) return -1;
    for (let i = start; i < end; ++i) {
      const c = data[i];
      switch (c) {
        case 59: // ;
          if (!this._storeValue(pos)) return this._a();
          state = HeaderState.KEY;
          pos = 0;
          break;
        case 61: // =
          if (state === HeaderState.START) {
            for (let k = 0; k < FILE_MARKER.length; ++k) {
              if (buffer[k] !== FILE_MARKER[k]) return this._a();
            }
            state = HeaderState.KEY;
            pos = 0;
          } else if (state === HeaderState.KEY) {
            if (!this._storeKey(pos)) return this._a();
            state = HeaderState.VALUE;
            pos = 0;
          } else if (state === HeaderState.VALUE) {
            if (pos >= MAX_FIELDCHARS) return this._a();
            buffer[pos++] = c;
          }
          break;
        case 58: // :
          if (state === HeaderState.VALUE) {
            if (!this._storeValue(pos)) return this._a();
          }
          this.state = HeaderState.END;
          return i + 1;
        default:
          if (pos >= MAX_FIELDCHARS) return this._a();
          buffer[pos++] = c;
      }
    }
    this.state = state;
    this._position = pos;
    return -2;
  }

  private _a(): number {
    this.state = HeaderState.ABORT;
    return -1;
  }

  private _storeKey(pos: number): boolean {
    const k = toStr(this._buffer.subarray(0, pos));
    if (k) {
      this._key = k;
      this.fields[k] = null;
      return true;
    }
    return false;
  }

  private _storeValue(pos: number): boolean {
    if (this._key) {
      try {
        const v = this._buffer.slice(0, pos);
        this.fields[this._key] = DECODERS[this._key] ? DECODERS[this._key](v) : v;
      } catch (e) {
        return false;
      }
      return true;
    }
    return false;
  }
}


export class InlineImagesProtocolHandler implements IOscHandler, IResetHandler {
  private _aborted = false;
  private _hp = new HeaderParser();
  private _header: IHeaderFields = DEFAULT_HEADER;
  private _imgData = new Uint8Array(0);
  private _pos = 0;

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
    this._pos = 0;
  }

  public put(data: Uint32Array, start: number, end: number): void {
    if (this._aborted) return;

    // TODO: abort on oversize in px & MB
    if (this._hp.state === HeaderState.END) {
      this._imgData.set(data.subarray(start, end), this._pos);
      this._pos += end - start;
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
        const b64Size = Base64.encodeSize(this._header.size);
        if (this._imgData.length < b64Size) {
          this._imgData = new Uint8Array(b64Size);
        }
        this._imgData.set(data.subarray(result, end));
        this._pos = end - result;
      }
    }
  }

  public end(success: boolean): boolean | Promise<boolean> {
    if (this._aborted || !success || !this._pos) return true;

    // inline b64 decoding
    const bytes = this._imgData.subarray(0, this._header.size);
    // FIXME: base64 decode + blob creation causes a big stall on mainthread: ~70ms for 24MB PNG
    const size = Base64.decode(this._imgData, bytes);
    if (size < this._header.size) return true;
    const blob = new Blob([bytes.subarray(0, size)], { type: 'image/jpeg' }); // FIXME: pull mime type from bytes

    if (this._imgData.length > MAX_DATA) {
      this._imgData = new Uint8Array(0);
    }

    return createImageBitmapShim(this._coreTerminal._core._coreBrowserService.window, blob)
      .then((obj: ImageBitmap | HTMLImageElement) => {
        if (!obj || !obj.width || !obj.height) return true;
        const [w, h] = this._getSize(obj.width, obj.height).map(Math.floor);
        const canvas = ImageRenderer.createCanvas(
          this._coreTerminal._core._coreBrowserService.window, w, h);
        canvas.getContext('2d')?.drawImage(obj, 0, 0, w, h);
        this._storage.addImage(canvas);
        return true;
      })
      .catch(e => true);
  }

  private _getSize(w: number, h: number): [number, number] {
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
function createImageBitmapShim(window: Window, blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
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
  return window.createImageBitmap(blob);
}
