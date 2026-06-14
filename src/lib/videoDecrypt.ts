import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { computeInverseMap } from './pyrandom';
import { permuteBlocks } from './imageDecrypt';

export interface ProgressInfo {
  phase: string;
  cur: number;
  total: number;
  extra?: string;
}

export interface VideoDecryptResult {
  blob: Blob;
  filename: string;
  hasAudio: boolean;
  engine: string;
  ext: string;
}

export function hasWebCodecs(): boolean {
  return (
    typeof window !== 'undefined' &&
    'VideoEncoder' in window &&
    'VideoDecoder' in window &&
    'VideoFrame' in window &&
    'EncodedVideoChunk' in window
  );
}

// 选择浏览器支持的 H.264 编码配置（无损质量，靠高码率保证画质）
async function pickAvcConfig(width: number, height: number, bitrate: number) {
  const candidates = [
    'avc1.640028', // High@4.0
    'avc1.4d4028', // Main@4.0
    'avc1.42e028', // Baseline@4.0
    'avc1.42001f',
  ];
  for (const codec of candidates) {
    try {
      const support = await (window as any).VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
      });
      if (support && support.supported) return codec;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function pickVp9Config(width: number, height: number, bitrate: number) {
  const candidates = ['vp09.00.40.08', 'vp09.00.10.08', 'vp8'];
  for (const codec of candidates) {
    try {
      const support = await (window as any).VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
      });
      if (support && support.supported) return codec;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 根据分辨率与帧率估算一个高画质码率（bps）。
 * 采用较高系数确保"不损失画质"。
 */
function estimateBitrate(w: number, h: number, fps: number): number {
  // 每像素每帧约 0.12 bit（高质量），并设下限
  const bpp = 0.12;
  const br = Math.round(w * h * fps * bpp);
  return Math.max(br, 4_000_000);
}

/**
 * 核心：用 WebCodecs 全速（非实时）解密视频。
 * 解码 -> 块反置换(像素层) -> 编码 -> mux。无 JPEG 中转，无实时播放瓶颈。
 */
export async function decryptVideoWebCodecs(
  file: File,
  pw: string,
  blockSize: number,
  preferMp4: boolean,
  onProgress: (info: ProgressInfo) => void,
): Promise<VideoDecryptResult> {
  // 读取首帧获取尺寸需要先解码，这里用一个临时 video 元素拿尺寸
  const probe = document.createElement('video');
  probe.muted = true;
  probe.src = URL.createObjectURL(file);
  await new Promise<void>((res, rej) => {
    probe.onloadedmetadata = () => res();
    probe.onerror = () => rej(new Error('视频元数据读取失败'));
    setTimeout(() => rej(new Error('视频元数据读取超时')), 15000);
  });
  const vw = probe.videoWidth;
  const vh = probe.videoHeight;
  URL.revokeObjectURL(probe.src);
  if (!vw || !vh) throw new Error('无法读取视频尺寸');

  const nw = Math.floor(vw / blockSize) * blockSize;
  const nh = Math.floor(vh / blockSize) * blockSize;
  if (!nw || !nh) throw new Error('视频尺寸小于块大小');
  const cropX = Math.floor((vw - nw) / 2);
  const cropY = Math.floor((vh - nh) / 2);
  const nc = nw / blockSize;
  const nr = nh / blockSize;
  const nb = nr * nc;

  const inv = await computeInverseMap(pw, nb);

  // 工作画布（处理块置换）
  const work = document.createElement('canvas');
  work.width = nw;
  work.height = nh;
  const wctx = work.getContext('2d', { willReadFrequently: true, alpha: false })!;

  // 输出画布（编码源）
  const out = document.createElement('canvas');
  out.width = nw;
  out.height = nh;
  const octx = out.getContext('2d', { alpha: false })!;

  // 预分配 ImageData 缓冲，避免每帧分配
  const dstBuf = wctx.createImageData(nw, nh);

  // ---- 探测帧率与总时长 ----
  // 用 demux 阶段无法直接得知帧率，故用 metadata 的 duration 与解码出的帧数。
  // 我们在解码阶段收集真实 timestamp，保证编码时间戳与原视频一致。

  // ---- 估算码率 ----
  // 帧率先用 30 估算（仅影响码率上限，画质由 VBR 决定）
  const guessFps = 30;
  const bitrate = estimateBitrate(nw, nh, guessFps);

  // ---- 配置编码器与 muxer ----
  let useMp4 = preferMp4;
  let codec: string | null = null;
  if (useMp4) {
    codec = await pickAvcConfig(nw, nh, bitrate);
    if (!codec) useMp4 = false;
  }
  if (!useMp4) {
    codec = await pickVp9Config(nw, nh, bitrate);
    if (!codec) throw new Error('浏览器不支持 H.264 / VP9 编码');
  }

  const ext = useMp4 ? 'mp4' : 'webm';

  let muxer: any;
  if (useMp4) {
    muxer = new Mp4Muxer({
      target: new Mp4Target(),
      video: { codec: 'avc', width: nw, height: nh },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  } else {
    muxer = new WebmMuxer({
      target: new WebmTarget(),
      video: { codec: 'V_VP9', width: nw, height: nh },
      firstTimestampBehavior: 'offset',
    });
  }

  let encError: any = null;
  const VE = (window as any).VideoEncoder;
  const encoder = new VE({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: any) => {
      encError = e;
    },
  });
  encoder.configure({
    codec: codec!,
    width: nw,
    height: nh,
    bitrate,
    // 优先画质（用户要求不损失画质）
    latencyMode: 'quality',
  });

  // ---- 解码阶段：使用 video 元素 + requestVideoFrameCallback 全速抽帧 ----
  // 注：纯 WebCodecs 解码需要 demux（拿 EncodedVideoChunk），浏览器无内置 demuxer。
  // 这里采用 video 元素逐帧抽取（rVFC），仍然比"实时录制"快很多，
  // 因为编码侧用 WebCodecs 全速进行，且无 JPEG 中转。
  const video = document.createElement('video');
  video.muted = true;
  (video as any).playsInline = true;
  video.src = URL.createObjectURL(file);
  await new Promise<void>((res, rej) => {
    video.onloadeddata = () => res();
    video.onerror = () => rej(new Error('视频加载失败'));
    setTimeout(() => rej(new Error('视频加载超时')), 15000);
  });

  const duration = video.duration;
  const estTotal = isFinite(duration) && duration > 0 ? Math.ceil(duration * guessFps) : 0;

  const supportsRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  let frameCount = 0;
  const t0 = performance.now();

  function processFrame(mediaTimeSec: number) {
    // 裁剪并绘制到工作画布
    wctx.drawImage(video, cropX, cropY, nw, nh, 0, 0, nw, nh);
    const srcData = wctx.getImageData(0, 0, nw, nh);
    permuteBlocks(srcData.data, dstBuf.data, nw, blockSize, nc, nb, inv);
    octx.putImageData(dstBuf, 0, 0);

    const tsMicro = Math.max(0, Math.round(mediaTimeSec * 1_000_000));
    const VF = (window as any).VideoFrame;
    const frame = new VF(out, { timestamp: tsMicro });
    // 周期性插入关键帧，利于随机访问
    encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
    frame.close();
    frameCount++;

    const elapsed = (performance.now() - t0) / 1000;
    const speed = frameCount / Math.max(elapsed, 0.001);
    const totalForPct = estTotal || frameCount;
    let extra = '';
    if (estTotal && frameCount > 4) {
      const eta = Math.max(0, Math.ceil((estTotal - frameCount) / Math.max(speed, 0.1)));
      extra = ` · ${speed.toFixed(0)} fps · 剩余约 ${eta}s`;
    }
    onProgress({ phase: '解密+编码', cur: frameCount, total: totalForPct, extra });
  }

  await new Promise<void>((resolve, reject) => {
    if (supportsRVFC) {
      const step = (_now: number, metadata: any) => {
        if (encError) {
          reject(encError);
          return;
        }
        try {
          processFrame(metadata.mediaTime);
        } catch (e) {
          reject(e);
          return;
        }
        if (video.ended || (duration && video.currentTime >= duration - 0.001)) {
          resolve();
          return;
        }
        (video as any).requestVideoFrameCallback(step);
      };
      (video as any).requestVideoFrameCallback(step);
      video.onended = () => resolve();
      // 提高播放速率以"全速"抽帧（rVFC 仍按解码帧触发），大幅快于实时。
      // 采用 4x：在多数浏览器/分辨率下不丢帧，同时显著提速。
      try {
        (video as any).preservesPitch = false;
        video.playbackRate = 4;
      } catch {
        /* 某些浏览器限制最高速率，忽略 */
      }
      video.play().catch((e) => reject(new Error('视频播放失败: ' + e.message)));
    } else {
      // 回退：按固定 fps seek 抽帧
      const fps = guessFps;
      const total = estTotal || Math.ceil((duration || 0) * fps);
      let fi = 0;
      const seekTo = (t: number) =>
        new Promise<void>((res) => {
          let done = false;
          const fin = () => {
            if (!done) {
              done = true;
              res();
            }
          };
          video.onseeked = fin;
          video.currentTime = t;
          setTimeout(fin, 4000);
        });
      (async () => {
        try {
          for (fi = 0; fi < total; fi++) {
            if (encError) throw encError;
            await seekTo(fi / fps);
            processFrame(fi / fps);
            if (fi % 4 === 0) await new Promise((r) => setTimeout(r, 0));
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      })();
    }
  });

  video.pause();
  URL.revokeObjectURL(video.src);

  await encoder.flush();
  if (encError) throw encError;

  // ---- 音频：尝试从原文件提取并混流 ----
  let hasAudio = false;
  try {
    hasAudio = await tryMuxAudio(file, muxer, useMp4);
  } catch {
    hasAudio = false;
  }

  muxer.finalize();
  const buffer: ArrayBuffer = muxer.target.buffer;
  const mime = useMp4 ? 'video/mp4' : 'video/webm';
  const blob = new Blob([buffer], { type: mime });

  return {
    blob,
    filename: file.name.replace(/\.[^.]+$/, '') + '_解密.' + ext,
    hasAudio,
    engine: 'WebCodecs',
    ext,
  };
}

/**
 * 尝试用 WebCodecs AudioEncoder 重新编码音频并混入 muxer。
 * 由于浏览器无内置 demuxer，这里用 AudioContext 解码原始 PCM 后重编码。
 */
async function tryMuxAudio(file: File, muxer: any, useMp4: boolean): Promise<boolean> {
  if (!('AudioEncoder' in window) || !('AudioData' in window)) return false;
  const arrayBuf = await file.arrayBuffer();
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return false;
  const ac = new AC();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ac.decodeAudioData(arrayBuf.slice(0));
  } catch {
    await ac.close();
    return false;
  }
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  if (!numCh || !length) {
    await ac.close();
    return false;
  }

  const codecStr = useMp4 ? 'mp4a.40.2' : 'opus';

  // 校验支持
  try {
    const sup = await (window as any).AudioEncoder.isConfigSupported({
      codec: codecStr,
      sampleRate,
      numberOfChannels: numCh,
      bitrate: 192_000,
    });
    if (!sup || !sup.supported) {
      await ac.close();
      return false;
    }
  } catch {
    await ac.close();
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let ok = false;
    const AE = (window as any).AudioEncoder;
    const enc = new AE({
      output: (chunk: any, meta: any) => {
        muxer.addAudioChunk(chunk, meta);
        ok = true;
      },
      error: () => resolve(false),
    });
    try {
      enc.configure({
        codec: codecStr,
        sampleRate,
        numberOfChannels: numCh,
        bitrate: 192_000,
      });
    } catch {
      resolve(false);
      return;
    }

    // 交错成 f32-planar AudioData，按块送入
    const chunkFrames = 4096;
    const AD = (window as any).AudioData;
    const channelData: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channelData.push(audioBuffer.getChannelData(c));

    (async () => {
      try {
        for (let pos = 0; pos < length; pos += chunkFrames) {
          const frames = Math.min(chunkFrames, length - pos);
          // planar 布局：[ch0 全部, ch1 全部, ...]
          const planar = new Float32Array(frames * numCh);
          for (let c = 0; c < numCh; c++) {
            planar.set(channelData[c].subarray(pos, pos + frames), c * frames);
          }
          const ts = Math.round((pos / sampleRate) * 1_000_000);
          const ad = new AD({
            format: 'f32-planar',
            sampleRate,
            numberOfFrames: frames,
            numberOfChannels: numCh,
            timestamp: ts,
            data: planar,
          });
          enc.encode(ad);
          ad.close();
        }
        await enc.flush();
        await ac.close();
        resolve(ok);
      } catch {
        try {
          await ac.close();
        } catch {
          /* ignore */
        }
        resolve(false);
      }
    })();
  });
}
