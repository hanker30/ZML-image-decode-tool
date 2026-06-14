import { computeInverseMap } from './pyrandom';
import { permuteBlocks } from './imageDecrypt';
import type { ProgressInfo, VideoDecryptResult } from './videoDecrypt';

function getSupportedMime(): string {
  const t = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of t) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/**
 * 回退方案（无 WebCodecs）：单遍流水线 —— 解码、块置换、直接录制。
 * 相比原始两阶段方案：去掉了 JPEG 中转（无画质损失、无内存堆积），
 * 用 rVFC 实时抽帧 + MediaRecorder 录制。仍受实时录制限制，但更快更省内存。
 */
export async function decryptVideoMediaRecorder(
  file: File,
  pw: string,
  blockSize: number,
  fps: number,
  onProgress: (info: ProgressInfo) => void,
): Promise<VideoDecryptResult> {
  const video = document.createElement('video');
  video.muted = true;
  (video as any).playsInline = true;
  video.src = URL.createObjectURL(file);
  await new Promise<void>((res, rej) => {
    video.onloadeddata = () => res();
    video.onerror = () => rej(new Error('视频加载失败'));
    setTimeout(() => rej(new Error('视频加载超时')), 15000);
  });

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const nw = Math.floor(vw / blockSize) * blockSize;
  const nh = Math.floor(vh / blockSize) * blockSize;
  if (!nw || !nh) throw new Error('视频尺寸小于块大小');
  const cropX = Math.floor((vw - nw) / 2);
  const cropY = Math.floor((vh - nh) / 2);
  const nc = nw / blockSize;
  const nr = nh / blockSize;
  const nb = nr * nc;
  const inv = await computeInverseMap(pw, nb);
  const duration = video.duration;
  const total = isFinite(duration) && duration > 0 ? Math.ceil(duration * fps) : 0;

  const work = document.createElement('canvas');
  work.width = nw;
  work.height = nh;
  const wctx = work.getContext('2d', { willReadFrequently: true, alpha: false })!;
  const out = document.createElement('canvas');
  out.width = nw;
  out.height = nh;
  const octx = out.getContext('2d', { alpha: false })!;
  const dstBuf = wctx.createImageData(nw, nh);

  // 音频
  let hasAudio = false;
  const canvasStream = (out as any).captureStream(fps) as MediaStream;
  let combined = canvasStream;
  let audioEl: HTMLVideoElement | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    audioEl = document.createElement('video');
    audioEl.src = URL.createObjectURL(file);
    audioEl.muted = false;
    await Promise.race([
      new Promise<void>((res, rej) => {
        audioEl!.onloadeddata = () => res();
        audioEl!.onerror = () => rej();
      }),
      new Promise<void>((res) => setTimeout(res, 5000)),
    ]);
    if (audioEl.readyState >= 2 && audioEl.duration > 0) {
      const ctx: AudioContext = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
      audioCtx = ctx;
      await ctx.resume();
      const src = ctx.createMediaElementSource(audioEl);
      const dst = ctx.createMediaStreamDestination();
      src.connect(dst);
      const at = dst.stream.getAudioTracks();
      const vt = canvasStream.getVideoTracks();
      if (at.length && vt.length) {
        combined = new MediaStream([vt[0], at[0]]);
        hasAudio = true;
      }
    }
  } catch {
    hasAudio = false;
  }

  const mime = getSupportedMime();
  if (!mime) throw new Error('浏览器不支持 WebM 录制');
  const bitrate = Math.max(nw * nh * fps * 0.12, 4_000_000);
  const recorder = new MediaRecorder(combined, {
    mimeType: mime,
    videoBitsPerSecond: bitrate,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const t0 = performance.now();
  let count = 0;
  const supportsRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function renderFrame() {
    wctx.drawImage(video, cropX, cropY, nw, nh, 0, 0, nw, nh);
    const srcData = wctx.getImageData(0, 0, nw, nh);
    permuteBlocks(srcData.data, dstBuf.data, nw, blockSize, nc, nb, inv);
    octx.putImageData(dstBuf, 0, 0);
    count++;
    const elapsed = (performance.now() - t0) / 1000;
    const speed = count / Math.max(elapsed, 0.001);
    let extra = '';
    if (total && count > 4) {
      const eta = Math.max(0, Math.ceil((total - count) / Math.max(speed, 0.1)));
      extra = ` · 剩余约 ${eta}s`;
    }
    onProgress({ phase: '解密+录制', cur: count, total: total || count, extra });
  }

  return await new Promise<VideoDecryptResult>((resolve, reject) => {
    let settled = false;
    recorder.onstop = () => {
      if (audioEl) {
        audioEl.pause();
        try {
          URL.revokeObjectURL(audioEl.src);
        } catch {
          /* ignore */
        }
      }
      if (audioCtx)
        try {
          audioCtx.close();
        } catch {
          /* ignore */
        }
      try {
        URL.revokeObjectURL(video.src);
      } catch {
        /* ignore */
      }
      resolve({
        blob: new Blob(chunks, { type: mime }),
        filename: file.name.replace(/\.[^.]+$/, '') + '_解密.webm',
        hasAudio,
        engine: 'MediaRecorder',
        ext: 'webm',
      });
    };
    recorder.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error('录制出错'));
      }
    };

    try {
      recorder.start(200);
    } catch (e: any) {
      reject(new Error('录制启动失败: ' + e.message));
      return;
    }
    if (hasAudio && audioEl) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    }

    if (supportsRVFC) {
      const step = () => {
        if (settled) return;
        renderFrame();
        if (video.ended || (duration && video.currentTime >= duration - 0.001)) {
          settled = true;
          setTimeout(() => recorder.stop(), 300);
          return;
        }
        (video as any).requestVideoFrameCallback(step);
      };
      (video as any).requestVideoFrameCallback(step);
      video.onended = () => {
        if (!settled) {
          settled = true;
          setTimeout(() => recorder.stop(), 300);
        }
      };
      video.play().catch((e) => reject(new Error('播放失败: ' + e.message)));
    } else {
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
        const frameInterval = 1000 / fps;
        const startTime = performance.now();
        for (let fi = 0; fi < (total || 0); fi++) {
          if (settled) return;
          await seekTo(fi / fps);
          renderFrame();
          const target = fi * frameInterval;
          const el = performance.now() - startTime;
          if (target > el) await new Promise((r) => setTimeout(r, target - el));
        }
        settled = true;
        setTimeout(() => recorder.stop(), 300);
      })();
    }
  });
}
