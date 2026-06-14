// ======================================================
// 音频提取与重编码（WebCodecs AudioEncoder + muxer）
// 关键点：muxer 必须在创建时就声明 audio 轨道，
// 所以要先解码原始音频拿到 声道数 / 采样率，再建 muxer。
// ======================================================

export interface DecodedAudio {
  audioBuffer: AudioBuffer;
  numCh: number;
  sampleRate: number;
  length: number;
  /** muxer 与 encoder 用的 codec 字符串 */
  encoderCodec: string;
  /** muxer.audio.codec 用的标识 */
  muxerCodec: 'aac' | 'opus' | 'A_OPUS';
  /** 若为 true，表示音频只能用 Opus 编码，必须使用 WebM 容器 */
  forceWebm: boolean;
}

/**
 * 解码原文件中的音频，并确定可用的音频编码器。
 * 返回 null 表示没有音频或不支持。
 */
export async function probeAndDecodeAudio(
  file: File,
  useMp4: boolean,
): Promise<DecodedAudio | null> {
  if (!('AudioEncoder' in window) || !('AudioData' in window)) return null;

  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;

  const arrayBuf = await file.arrayBuffer();
  const ac = new AC();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ac.decodeAudioData(arrayBuf.slice(0));
  } catch {
    try {
      await ac.close();
    } catch {
      /* ignore */
    }
    return null; // 没有可解码音频
  }
  try {
    await ac.close();
  } catch {
    /* ignore */
  }

  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  if (!numCh || !length) return null;

  // 选择编码器：
  //  - MP4 模式优先 AAC；若 AAC 不被支持（部分 Chromium 未内置 AAC 编码器），
  //    则回退到 Opus 并强制改用 WebM 容器，确保音频不丢失。
  //  - WebM 模式直接用 Opus。
  type Cand = {
    encoderCodec: string;
    muxerCodec: 'aac' | 'opus' | 'A_OPUS';
    forceWebm: boolean;
  };
  const candidates: Cand[] = useMp4
    ? [
        { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac', forceWebm: false },
        { encoderCodec: 'opus', muxerCodec: 'A_OPUS', forceWebm: true },
      ]
    : [{ encoderCodec: 'opus', muxerCodec: 'A_OPUS', forceWebm: false }];

  for (const c of candidates) {
    try {
      const sup = await (window as any).AudioEncoder.isConfigSupported({
        codec: c.encoderCodec,
        sampleRate,
        numberOfChannels: numCh,
        bitrate: 192_000,
      });
      if (sup && sup.supported) {
        return {
          audioBuffer,
          numCh,
          sampleRate,
          length,
          encoderCodec: c.encoderCodec,
          muxerCodec: c.muxerCodec,
          forceWebm: c.forceWebm,
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * 把已解码音频用 AudioEncoder 编码并送入 muxer。
 * muxer 必须已在创建时声明了 audio 轨道。
 */
export async function encodeAudioToMuxer(
  dec: DecodedAudio,
  muxer: any,
): Promise<boolean> {
  const { audioBuffer, numCh, sampleRate, length, encoderCodec } = dec;

  return await new Promise<boolean>((resolve) => {
    let produced = false;
    let errored = false;
    const AE = (window as any).AudioEncoder;
    const enc = new AE({
      output: (chunk: any, meta: any) => {
        try {
          muxer.addAudioChunk(chunk, meta);
          produced = true;
        } catch {
          errored = true;
        }
      },
      error: () => {
        errored = true;
      },
    });

    try {
      enc.configure({
        codec: encoderCodec,
        sampleRate,
        numberOfChannels: numCh,
        bitrate: 192_000,
      });
    } catch {
      resolve(false);
      return;
    }

    const AD = (window as any).AudioData;
    const channelData: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channelData.push(audioBuffer.getChannelData(c));

    const chunkFrames = 8192;

    (async () => {
      try {
        for (let pos = 0; pos < length; pos += chunkFrames) {
          if (errored) break;
          const frames = Math.min(chunkFrames, length - pos);
          // f32-planar 布局：[ch0 全部, ch1 全部, ...]
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
        resolve(produced && !errored);
      } catch {
        resolve(false);
      }
    })();
  });
}
