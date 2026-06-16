import { computeInverseMap } from './pyrandom';

/**
 * 高速块反置换：直接在像素数组层面拷贝块，避免上千次 drawImage 调用。
 * src/dst 均为 RGBA Uint8ClampedArray，尺寸 nw×nh。
 */
export function permuteBlocks(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  nw: number,
  bs: number,
  nc: number,
  nb: number,
  inv: Int32Array,
) {
  const rowBytes = nw * 4;
  const blockRowBytes = bs * 4;
  for (let p = 0; p < nb; p++) {
    const op = inv[p];
    // 源块（置换后图中的第 p 块）左上角
    const sCol = (p % nc) * bs;
    const sRow = ((p / nc) | 0) * bs;
    // 目标块（原图中的第 op 块）左上角
    const dCol = (op % nc) * bs;
    const dRow = ((op / nc) | 0) * bs;

    let sOff = sRow * rowBytes + sCol * 4;
    let dOff = dRow * rowBytes + dCol * 4;
    for (let y = 0; y < bs; y++) {
      // 整行块一次性拷贝（比逐像素快得多）
      dst.set(src.subarray(sOff, sOff + blockRowBytes), dOff);
      sOff += rowBytes;
      dOff += rowBytes;
    }
  }
}

export interface ImageDecryptResult {
  canvas: HTMLCanvasElement;
}

export async function decryptImage(
  img: HTMLImageElement | ImageBitmap,
  pw: string,
  bs: number,
  onProgress?: (p: number) => void,
): Promise<ImageDecryptResult> {
  const ow = (img as HTMLImageElement).naturalWidth || img.width;
  const oh = (img as HTMLImageElement).naturalHeight || img.height;
  const nw = Math.floor(ow / bs) * bs;
  const nh = Math.floor(oh / bs) * bs;
  if (!nw || !nh) throw new Error('图像尺寸小于块大小');
  const ox = Math.floor((ow - nw) / 2);
  const oy = Math.floor((oh - nh) / 2);
  const nc = nw / bs;
  const nr = nh / bs;
  const nb = nr * nc;

  const sc = document.createElement('canvas');
  sc.width = nw;
  sc.height = nh;
  const sx = sc.getContext('2d', { willReadFrequently: true })!;
  sx.fillStyle = '#fff';
  sx.fillRect(0, 0, nw, nh);
  sx.drawImage(img as CanvasImageSource, ox, oy, nw, nh, 0, 0, nw, nh);

  const inv = await computeInverseMap(pw, nb);
  onProgress?.(0.3);

  const srcData = sx.getImageData(0, 0, nw, nh);
  const dstData = sx.createImageData(nw, nh);
  permuteBlocks(srcData.data, dstData.data, nw, bs, nc, nb, inv);
  onProgress?.(0.9);

  const dc = document.createElement('canvas');
  dc.width = nw;
  dc.height = nh;
  const dx = dc.getContext('2d')!;
  dx.putImageData(dstData, 0, 0);
  onProgress?.(1);

  return { canvas: dc };
}
