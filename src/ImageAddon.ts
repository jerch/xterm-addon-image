/**
 * Copyright (c) 2020 Joerg Breitbart.
 * @license MIT
 */

import { IIPHandler } from './IIPHandler';
import { ITerminalAddon, IDisposable } from 'xterm';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage, CELL_SIZE_DEFAULT } from './ImageStorage';
import { SixelHandler } from './SixelHandler';
import { ITerminalExt, IImageAddonOptions, IResetHandler } from './Types';


// default values of addon ctor options
const DEFAULT_OPTIONS: IImageAddonOptions = {
  enableSizeReports: true,
  pixelLimit: 16777216, // limit to 4096 * 4096 pixels
  sixelSupport: true,
  sixelScrolling: true,
  sixelPaletteLimit: 256,
  sixelSizeLimit: 25000000,
  storageLimit: 128,
  showPlaceholder: true,
  iipSupport: true,
  iipSizeLimit: 20000000
};

// max palette size supported by the sixel lib (compile time setting)
const MAX_SIXEL_PALETTE_SIZE = 4096;

// definitions for _xtermGraphicsAttributes sequence
const enum GaItem {
  COLORS = 1,
  SIXEL_GEO = 2,
  REGIS_GEO = 3
}
const enum GaAction {
  READ = 1,
  SET_DEFAULT = 2,
  SET = 3,
  READ_MAX = 4
}
const enum GaStatus {
  SUCCESS = 0,
  ITEM_ERROR = 1,
  ACTION_ERROR = 2,
  FAILURE = 3
}


export class ImageAddon implements ITerminalAddon {
  private _opts: IImageAddonOptions;
  private _defaultOpts: IImageAddonOptions;
  private _storage: ImageStorage | undefined;
  private _renderer: ImageRenderer | undefined;
  private _disposables: IDisposable[] = [];
  private _terminal: ITerminalExt | undefined;
  private _handlers: Map<String, IResetHandler> = new Map();

  constructor(opts?: Partial<IImageAddonOptions>) {
    this._opts = Object.assign({}, DEFAULT_OPTIONS, opts);
    this._defaultOpts = Object.assign({}, DEFAULT_OPTIONS, opts);
  }

  public dispose(): void {
    for (const obj of this._disposables) {
      obj.dispose();
    }
    this._disposables.length = 0;
    this._handlers.clear();
  }

  private _disposeLater(...args: IDisposable[]): void {
    for (const obj of args) {
      this._disposables.push(obj);
    }
  }

  public activate(terminal: ITerminalExt): void {
    this._terminal = terminal;

    // internal data structures
    this._renderer = new ImageRenderer(terminal, this._opts.showPlaceholder);
    this._storage = new ImageStorage(terminal, this._renderer, this._opts);

    // enable size reports
    if (this._opts.enableSizeReports) {
      // const windowOptions = terminal.getOption('windowOptions');
      // windowOptions.getWinSizePixels = true;
      // windowOptions.getCellSizePixels = true;
      // windowOptions.getWinSizeChars = true;
      // terminal.setOption('windowOptions', windowOptions);
      const windowOps = terminal.options.windowOptions || {};
      windowOps.getWinSizePixels = true;
      windowOps.getCellSizePixels = true;
      windowOps.getWinSizeChars = true;
      terminal.options.windowOptions = windowOps;
    }

    this._disposeLater(
      this._renderer,
      this._storage,

      // DECSET/DECRST/DA1/XTSMGRAPHICS handlers
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => this._decset(params)),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => this._decrst(params)),
      terminal.parser.registerCsiHandler({ final: 'c' }, params => this._da1(params)),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'S' }, params => this._xtermGraphicsAttributes(params)),

      // render hook
      terminal.onRender(range => this._storage?.render(range)),

      /**
       * reset handlers covered:
       * - DECSTR
       * - RIS
       * - Terminal.reset()
       */
      terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => this.reset()),
      terminal.parser.registerEscHandler({ final: 'c' }, () => this.reset()),
      terminal._core._inputHandler.onRequestReset(() => this.reset()),

      // wipe canvas and delete alternate images on buffer switch
      terminal.buffer.onBufferChange(() => this._storage?.wipeAlternate()),

      // extend images to the right on resize
      terminal.onResize(metrics => this._storage?.viewportResize(metrics))
    );

    // SIXEL handler
    if (this._opts.sixelSupport) {
      const sixelHandler = new SixelHandler(this._opts, this._storage!, terminal);
      this._handlers.set('sixel', sixelHandler);
      this._disposeLater(
        terminal._core._inputHandler._parser.registerDcsHandler({ final: 'q' }, sixelHandler)
      );
    }

    // iTerm IIP handler
    if (this._opts.iipSupport) {
      const iipHandler = new IIPHandler(this._opts, this._renderer!, this._storage!, terminal);
      this._handlers.set('iip', iipHandler);
      this._disposeLater(
        terminal._core._inputHandler._parser.registerOscHandler(1337, iipHandler)
      );
    }
  }

  // Note: storageLimit is skipped here to not intoduce a surprising side effect.
  public reset(): boolean {
    // reset options customizable by sequences to defaults
    this._opts.sixelScrolling = this._defaultOpts.sixelScrolling;
    this._opts.sixelPaletteLimit = this._defaultOpts.sixelPaletteLimit;
    // also clear image storage
    this._storage?.reset();
    // reset protocol handlers
    for (const handler of this._handlers.values()) {
      handler.reset();
    }
    return false;
  }

  public get storageLimit(): number {
    return this._storage?.getLimit() || -1;
  }

  public set storageLimit(limit: number) {
    this._storage?.setLimit(limit);
    this._opts.storageLimit = limit;
  }

  public get storageUsage(): number {
    if (this._storage) {
      return this._storage.getUsage();
    }
    return -1;
  }

  public get showPlaceholder(): boolean {
    return this._opts.showPlaceholder;
  }

  public set showPlaceholder(value: boolean) {
    this._opts.showPlaceholder = value;
    this._renderer?.showPlaceholder(value);
  }

  public getImageAtBufferCell(x: number, y: number): HTMLCanvasElement | undefined {
    return this._storage?.getImageAtBufferCell(x, y);
  }

  public extractTileAtBufferCell(x: number, y: number): HTMLCanvasElement | undefined {
    return this._storage?.extractTileAtBufferCell(x, y);
  }

  private _report(s: string): void {
    this._terminal?._core.coreService.triggerDataEvent(s);
  }

  private _decset(params: (number | number[])[]): boolean {
    for (let i = 0; i < params.length; ++i) {
      switch (params[i]) {
        case 80:
          this._opts.sixelScrolling = false;
          break;
      }
    }
    return false;
  }

  private _decrst(params: (number | number[])[]): boolean {
    for (let i = 0; i < params.length; ++i) {
      switch (params[i]) {
        case 80:
          this._opts.sixelScrolling = true;
          break;
      }
    }
    return false;
  }

  // overload DA to return something more appropriate
  private _da1(params: (number | number[])[]): boolean {
    if (params[0] > 0) {
      return true;
    }
    // reported features:
    // 62 - VT220
    // 4 - SIXEL support
    // 9 - charsets
    // 22 - ANSI colors
    if (this._opts.sixelSupport) {
      this._report(`\x1b[?62;4;9;22c`);
      return true;
    }
    return false;
  }

  /**
   * Implementation of xterm's graphics attribute sequence.
   *
   * Supported features:
   * - read/change palette limits (max 4096 by sixel lib)
   * - read SIXEL canvas geometry (reports current window canvas or
   *   squared pixelLimit if canvas > pixel limit)
   *
   * Everything else is deactivated.
   */
  private _xtermGraphicsAttributes(params: (number | number[])[]): boolean {
    if (params.length < 2) {
      return true;
    }
    if (params[0] === GaItem.COLORS) {
      switch (params[1]) {
        case GaAction.READ:
          this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${this._opts.sixelPaletteLimit}S`);
          return true;
        case GaAction.SET_DEFAULT:
          this._opts.sixelPaletteLimit = this._defaultOpts.sixelPaletteLimit;
          this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${this._opts.sixelPaletteLimit}S`);
          // also reset protocol handlers for now
          for (const handler of this._handlers.values()) {
            handler.reset();
          }
          return true;
        case GaAction.SET:
          if (params.length > 2 && !(params[2] instanceof Array) && params[2] <= MAX_SIXEL_PALETTE_SIZE) {
            this._opts.sixelPaletteLimit = params[2];
            this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${this._opts.sixelPaletteLimit}S`);
          } else {
            this._report(`\x1b[?${params[0]};${GaStatus.ACTION_ERROR}S`);
          }
          return true;
        case GaAction.READ_MAX:
          this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${MAX_SIXEL_PALETTE_SIZE}S`);
          return true;
        default:
          this._report(`\x1b[?${params[0]};${GaStatus.ACTION_ERROR}S`);
          return true;
      }
    }
    if (params[0] === GaItem.SIXEL_GEO) {
      switch (params[1]) {
        // we only implement read and read_max here
        case GaAction.READ:
          let width = this._renderer?.dimensions?.css.canvas.width;
          let height = this._renderer?.dimensions?.css.canvas.height;
          if (!width || !height) {
            // for some reason we have no working image renderer
            // --> fallback to default cell size
            const cellSize = CELL_SIZE_DEFAULT;
            width = (this._terminal?.cols || 80) * cellSize.width;
            height = (this._terminal?.rows || 24) * cellSize.height;
          }
          if (width * height < this._opts.pixelLimit) {
            this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${width.toFixed(0)};${height.toFixed(0)}S`);
          } else {
            // if we overflow pixelLimit report that squared instead
            const x = Math.floor(Math.sqrt(this._opts.pixelLimit));
            this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${x};${x}S`);
          }
          return true;
        case GaAction.READ_MAX:
          // read_max returns pixelLimit as square area
          const x = Math.floor(Math.sqrt(this._opts.pixelLimit));
          this._report(`\x1b[?${params[0]};${GaStatus.SUCCESS};${x};${x}S`);
          return true;
        default:
          this._report(`\x1b[?${params[0]};${GaStatus.ACTION_ERROR}S`);
          return true;
      }
    }
    // exit with error on ReGIS or any other requests
    this._report(`\x1b[?${params[0]};${GaStatus.ITEM_ERROR}S`);
    return true;
  }

  /**
   * demo hack for complex terminal buffer serialization
   */
  private _parts: string[] = [''];

  // example for text/FG/BG serializer
  private _serText(num: number): number[] {
    // FIXME: no FG/BG attributes atm
    const buffer = this._terminal!._core.buffer;
    const line = buffer.lines.get(num);
    if (!line) return [];
    const cell = this._terminal?.buffer.active.getNullCell()!;
    const cols = this._terminal!.cols;
    const res: number[] = [];
    let partPos = 0;
    let content = '';
    for (let col = 0; col < cols; ++col) {
      line?.loadCell(col, cell as any);
      if (!cell.getChars()) {
        partPos = 0;
        if (content) this._parts.push(content);
        content = '';
      } else {
        partPos = this._parts.length;
        content += cell.getChars();
      }
      res.push(partPos);
    }
    if (content) this._parts.push(content);
    return res;
  }

  private _encodeTile(canvas: HTMLCanvasElement): string {
    // repack cell tile into a proper cell covering canvas if it is too small
    const cw = this._renderer!.dimensions?.css.cell.width || CELL_SIZE_DEFAULT.width;
    const ch = this._renderer!.dimensions?.css.cell.height || CELL_SIZE_DEFAULT.height;
    if (canvas.width < cw || canvas.height < ch) {
      const newCanvas = ImageRenderer.createCanvas(window, Math.ceil(cw), Math.ceil(ch));
      newCanvas.getContext('2d')?.drawImage(canvas, 0, 0);
      canvas = newCanvas;
    }
    const data = canvas.toDataURL('image/png').slice(22);
    const iipSeq = `\x1b]1337;File=inline=1;width=1;height=1;preserveAspectRatio=0;size=${atob(data).length}:${data}`;
    return iipSeq + '\x1b[C'; // + cursor advance by one
  }

  // example for image serializer
  private _serImages(num: number): number[] {
    const res: number[] = [];
    const cols = this._terminal!.cols;
    const buffer = this._terminal!._core.buffer;
    const line = buffer.lines.get(num);
    if (!line) return [];

    for (let col = 0; col < cols; ++col) {
      // for simplicity only single cell tile encoding atm
      const canvas = this.extractTileAtBufferCell(col, num);
      if (!canvas || !canvas.width || !canvas.height) {
        res.push(0);
        continue;
      }
      res.push(this._parts.length);
      this._parts.push(this._encodeTile(canvas));
    }
    return res;
  }

  public serialize(start: number, end: number): string[] {
    const lines: string[] = [];
    const cols = this._terminal!.cols;
    for (let row = start; row < end; ++row) {
      const indices: number[][] = [];
      // FIXME: turn next 2 invocations into registered event handlers
      indices.push(this._serText(row));
      indices.push(this._serImages(row));

      // fuse logic
      const entries: string[] = [];
      let cursorAdjust = 0;
      for (let i = 0; i < cols; ++i) {
        let entry = '';
        let handled = 0;
        for (let k = 0; k < indices.length; ++k) {
          handled |= indices[k][i];
          if (this._parts[indices[k][i]]) {
            entry += this._parts[indices[k][i]];
            this._parts[indices[k][i]] = '';
          }
        }
        if (handled && cursorAdjust) {
          entries.push(`\x1b[${cursorAdjust}C`);
          cursorAdjust = 0;
        } else if (!handled) {
          cursorAdjust++;
        }
        entries.push(entry);
      }
      lines.push(entries.join(''));
      this._parts.length = 1;
    }
    return lines;
  }
}
