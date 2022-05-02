/**
 * Copyright (c) 2021 Joerg Breitbart.
 * @license MIT
 */

import { AckPayload, IImageWorkerMessage, IPostMessage, MessageType } from '../src/WorkerTypes';

import { Decoder } from 'sixel/lib/Decoder';
import { PALETTE_ANSI_256, PALETTE_VT340_COLOR } from 'sixel/lib/Colors';


// narrow types for postMessage to our protocol
declare const postMessage: IPostMessage;


// always free decoder ressources after decoding if it exceeds this limit
const MEM_PERMA_LIMIT = 4194304; // 1024 pixels * 1024 pixels * 4 channels = 4MB

// custom default palette: VT340 (lower 16 colors) + ANSI256 (up to 256) + zeroed (up to 4096)
const DEFAULT_PALETTE = PALETTE_ANSI_256;
DEFAULT_PALETTE.set(PALETTE_VT340_COLOR);


let imageBuffer: ArrayBuffer | undefined;
let sizeExceeded = false;
let dec: Decoder;

// setup options loaded from ACK
let pixelLimit = 0;


function messageHandler(event: MessageEvent<IImageWorkerMessage>): void {
  const data = event.data;
  switch (data.type) {
    case MessageType.SIXEL_PUT:
      if (!sizeExceeded) {
        dec.decode(new Uint8Array(data.payload.buffer, 0, data.payload.length));
        if (dec.height * dec.width > pixelLimit) {
          sizeExceeded = true;
          dec.release();
          console.warn('image worker: pixelLimit exceeded, aborting');
          postMessage({ type: MessageType.SIZE_EXCEEDED });
        }
      }
      postMessage({ type: MessageType.CHUNK_TRANSFER, payload: data.payload.buffer }, [data.payload.buffer]);
      break;
    case MessageType.SIXEL_END:
      const success = data.payload;
      if (success) {
        if (!dec || !dec.width || !dec.height || sizeExceeded) {
          postMessage({ type: MessageType.SIXEL_IMAGE, payload: null });
        } else {
          const width = dec.width;
          const height = dec.height;
          const bytes = width * height * 4;
          if (!imageBuffer || imageBuffer.byteLength < bytes) {
            imageBuffer = new ArrayBuffer(bytes);
          }
          new Uint32Array(imageBuffer, 0, width * height).set(dec.data32);
          postMessage({
            type: MessageType.SIXEL_IMAGE,
            payload: {
              buffer: imageBuffer,
              width,
              height
            }
          }, [imageBuffer]);
          imageBuffer = undefined;
          if (dec.memoryUsage > MEM_PERMA_LIMIT) {
            dec.release();
          }
        }
      }
      sizeExceeded = false;
      break;
    case MessageType.CHUNK_TRANSFER:
      if (!imageBuffer) {
        imageBuffer = data.payload;
      }
      break;
    case MessageType.SIXEL_INIT:
      sizeExceeded = false;
      const { fillColor, limit } = data.payload;
      // palette null - always shared from previous decoding
      dec.init(fillColor, null, limit);
      break;
    case MessageType.ACK:
      pixelLimit = data.options?.pixelLimit || 0;
      dec = new Decoder({ memoryLimit: pixelLimit * 4, palette: DEFAULT_PALETTE });
      postMessage({ type: MessageType.ACK, payload: AckPayload.ALIVE, options: null });
      break;
  }
}
self.addEventListener('message', messageHandler, false);
