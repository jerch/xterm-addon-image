import { assert } from 'chai';
import { QoiDecoder } from './QoiDecoder.wasm';
import { QoiEncoder } from './QoiEncoder.wasm';

// fix missing nodejs decl
declare const require: (s: string) => any;
const fs = require('fs');


const TESTFILES: [string, [number, number]][] = [
  ['dice.qoi', [800, 600]],
  ['edgecase.qoi', [256, 64]],
  ['kodim10.qoi', [512, 768]],
  ['kodim23.qoi', [768, 512]],
  ['qoi_logo.qoi', [448, 220]],
  ['testcard.qoi', [256, 256]],
  ['testcard_rgba.qoi', [256, 256]],
  ['wikipedia_008.qoi', [1152, 858]]
];


const qoiDecoder = new QoiDecoder(0);

describe('QoiEncoder', () => {
  let qoiEncoder: QoiEncoder;
  beforeEach(() => {
    qoiEncoder = new QoiEncoder(0);
  });
  it('palette.blob', () => {
    const pixelData = new Uint8Array(fs.readFileSync('./addons/xterm-addon-image/fixture/palette.blob'));
    const rgbData = qoiEncoder.encode(pixelData, 640, 80);
    const rgbDecoded = qoiDecoder.decode(rgbData);
    assert.strictEqual(qoiDecoder.width, 640);
    assert.strictEqual(qoiDecoder.height, 80);
    assert.strictEqual(rgbDecoded.length, pixelData.length);
    assert.deepStrictEqual(rgbDecoded, pixelData);
    assert.strictEqual(rgbData[12], 4);
  });
  it('testfiles', () => {
    for (const [filename, [width, height]] of TESTFILES) {
      const orig = new Uint8Array(fs.readFileSync('./addons/xterm-addon-image/fixture/qoi/' + filename));
      const decoded = qoiDecoder.decode(orig).slice();
      assert.strictEqual(qoiDecoder.width, width);
      assert.strictEqual(qoiDecoder.height, height);
      const encoded = qoiEncoder.encode(decoded, width, height);
      const decoded2 = qoiDecoder.decode(encoded).slice();
      assert.strictEqual(qoiDecoder.width, width);
      assert.strictEqual(qoiDecoder.height, height);
      assert.deepStrictEqual(decoded2, decoded);
    }
  });
  it('quick bench', () => {
    const pixelData = new Uint8Array(fs.readFileSync('./addons/xterm-addon-image/fixture/palette.blob'));
    // const orig = new Uint8Array(fs.readFileSync('./addons/xterm-addon-image/fixture/qoi/wikipedia_008.qoi'));
    // const decoded = qoiDecoder.decode(orig);
    let c = 0;
    const qoiEncoder = new QoiEncoder(1000000);
    const st = Date.now();
    for (let i = 0; i < 1000; ++i) {
      c += qoiEncoder.encode(pixelData, 640, 80).length;
      // c += qoiEncode(decoded, 1152, 858).length;
    }
    console.log(Date.now() - st, c);
  });
});
