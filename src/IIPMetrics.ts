/**
 * Copyright (c) 2023 Joerg Breitbart.
 * @license MIT
 */


export type ImageType = 'image/png' | 'image/jpeg' | 'unsupported' | '';

export interface IMetrics {
  mime: ImageType;
  width: number;
  height: number;
}

export const UNSUPPORTED_TYPE: IMetrics = {
  mime: 'unsupported',
  width: 0,
  height: 0
};

export function imageType(d: Uint8Array): IMetrics {
  if (d.length < 24) {
    return UNSUPPORTED_TYPE;
  }
  const d32 = new Uint32Array(d.buffer, d.byteOffset, 6);
  if (d32[0] === 0x474E5089 && d32[1] === 0x0A1A0A0D && d32[3] === 0x52444849) {
    // PNG
    return {
      mime: 'image/png',
      width: d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19],
      height: d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]
    };
  }
  if ((d32[0] === 0xE0FFD8FF || d32[0] === 0xE1FFD8FF)
    &&  (
      (d[6] === 0x4a && d[7] === 0x46 && d[8] === 0x49 && d[9] === 0x46)
        ||  (d[6] === 0x45 && d[7] === 0x78 && d[8] === 0x69 && d[9] === 0x66)
    )
  ) {
    // JPEG
    const [width, height] = jpgSize(d);
    return { mime: 'image/jpeg', width, height };
  }
  return UNSUPPORTED_TYPE;
}

function jpgSize(d: Uint8Array): [number, number] {
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
