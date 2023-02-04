/**
 * Copyright (c) 2023 Joerg Breitbart.
 * @license MIT
 */

import { IOscHandler, IResetHandler, ITerminalExt } from './Types';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage, CELL_SIZE_DEFAULT } from './ImageStorage';


const FILE_MARKER = [70, 105, 108, 101];
const MAX_FIELDCHARS = 1024;

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
      throw new Error('illegal char for digit');
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
  const bs = atob(toStr(data));
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
  private _bufferPos = 0;
  private _curKey = '';
  public fields: {[key: string]: any} = {};

  public reset(): void {
    this._buffer.fill(0);
    this.state = HeaderState.START;
    this._bufferPos = 0;
    this.fields = {};
    this._curKey = '';
  }

  public parse(data: Uint32Array, start: number, end: number): number {
    if (this.state === HeaderState.ABORT || this.state === HeaderState.END) return -1;
    if (this.state === HeaderState.START && this._bufferPos > 6) return -1;
    for (let i = start; i < end; ++i) {
      const c = data[i];
      switch (c) {
        case 59: // ;
          if (!this._setValue()) return this._abort();
          this.state = HeaderState.KEY;
          this._bufferPos = 0;
          break;
        case 61: // =
          if (this.state === HeaderState.START) {
            for (let k = 0; k < FILE_MARKER.length; ++k) {
              if (this._buffer[k] !== FILE_MARKER[k]) return this._abort();
            }
            this.state = HeaderState.KEY;
            this._bufferPos = 0;
          } else if (this.state === HeaderState.KEY) {
            if (!this._setKey()) return this._abort();
            this.state = HeaderState.VALUE;
            this._bufferPos = 0;
          } else if (this.state === HeaderState.VALUE) {
            if (this._bufferPos >= MAX_FIELDCHARS) return this._abort();
            this._buffer[this._bufferPos++] = c;
          }
          break;
        case 58: // :
          if (this.state === HeaderState.VALUE) {
            if (!this._setValue()) return this._abort();
          }
          this.state = HeaderState.END;
          return i + 1;
        default:
          if (this._bufferPos >= MAX_FIELDCHARS) return this._abort();
          this._buffer[this._bufferPos++] = c;
      }
    }
    return -2;
  }

  private _abort(): number {
    this.state = HeaderState.ABORT;
    return -1;
  }

  private _setKey(): boolean {
    const key = toStr(this._buffer.subarray(0, this._bufferPos));
    if (key) {
      this._curKey = key;
      this.fields[key] = null;
      return true;
    }
    return false;
  }

  private _setValue(): boolean {
    if (this._curKey) {
      try {
        const v = this._buffer.slice(0, this._bufferPos);
        this.fields[this._curKey] = DECODERS[this._curKey] ? DECODERS[this._curKey](v) : v;
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
  private _data: string[] = [];

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
    this._data.length = 0;
  }

  public put(data: Uint32Array, start: number, end: number): void {
    if (this._aborted) return;

    if (this._hp.state === HeaderState.END) {
      this._data.push(toStr(data.subarray(start, end)));
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
        this._data.length = 0;
        this._data.push(toStr(data.subarray(result, end)));
      }
    }
  }

  public end(success: boolean): boolean | Promise<boolean> {
    if (this._aborted || !success || !this._data.length) return true;

    return new Promise(resolve => {
      try {
        // TODO: faster alternative to atob + Image
        const bytes = Uint8Array.from(atob(this._data.join('')), c => c.charCodeAt(0));
        this._data.length = 0;
        const blob = new Blob([bytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          let [w, h] = this._getSize(img.width, img.height);
          w = Math.floor(w);
          h = Math.floor(h);
          const canvas = ImageRenderer.createCanvas(
            this._coreTerminal._core._coreBrowserService.window, w, h);
          canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
          this._storage.addImage(canvas);
          this._coreTerminal.refresh(0, this._coreTerminal.rows);
          resolve(true);
        };
        img.src = url;
      } catch (e) {
        resolve(true);
      }
    });
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

