import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decryptImage } from './lib/imageDecrypt';
import {
  decryptVideoWebCodecs,
  hasWebCodecs,
  type ProgressInfo,
  type VideoDecryptResult,
} from './lib/videoDecrypt';
import { decryptVideoMediaRecorder } from './lib/videoDecryptFallback';

type ImgResult = { type: 'image'; canvas: HTMLCanvasElement; filename: string };
type VidResult = {
  type: 'video';
  url: string;
  blob: Blob;
  filename: string;
  hasAudio: boolean;
  engine: string;
};
type ErrResult = { type: 'error'; filename: string; error: string };
type Result = ImgResult | VidResult | ErrResult;

const isVideo = (f: File) => f.type.startsWith('video/');

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [drag, setDrag] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  const [pw, setPw] = useState('在梦里w');
  const [bs, setBs] = useState(16);
  const [fps, setFps] = useState(30);
  const [format, setFormat] = useState<'mp4' | 'webm'>('mp4');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultUrlsRef = useRef<string[]>([]);
  const wc = useMemo(() => hasWebCodecs(), []);

  // 浏览器能力检查
  const compatIssues = useMemo(() => {
    const iss: string[] = [];
    if (!window.crypto || !window.crypto.subtle) iss.push('Web Crypto');
    if (!wc && !window.MediaRecorder) iss.push('MediaRecorder / WebCodecs');
    return iss;
  }, [wc]);

  useEffect(() => {
    return () => {
      resultUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const addFiles = useCallback((flist: FileList | File[]) => {
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(flist)) {
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue;
        if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
        next.push(f);
      }
      return next;
    });
  }, []);

  const removeFile = (idx: number) => setFiles((p) => p.filter((_, i) => i !== idx));
  const clearFiles = () => setFiles([]);

  const run = useCallback(async () => {
    if (!files.length || busy) return;
    setBusy(true);
    setResults([]);
    setProgress({ phase: '准备中', cur: 0, total: 1 });
    resultUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    resultUrlsRef.current = [];

    const acc: Result[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx];
      const prefix = `处理 ${idx + 1}/${files.length} — ${f.name}`;
      try {
        if (isVideo(f)) {
          const onProg = (info: ProgressInfo) =>
            setProgress({ ...info, phase: `${prefix} · ${info.phase}` });

          let res: VideoDecryptResult;
          if (wc) {
            try {
              res = await decryptVideoWebCodecs(f, pw, bs, format === 'mp4', onProg);
            } catch (e) {
              // WebCodecs 失败则回退到 MediaRecorder
              console.warn('WebCodecs failed, fallback:', e);
              res = await decryptVideoMediaRecorder(f, pw, bs, fps, onProg);
            }
          } else {
            res = await decryptVideoMediaRecorder(f, pw, bs, fps, onProg);
          }

          const url = URL.createObjectURL(res.blob);
          resultUrlsRef.current.push(url);
          acc.push({
            type: 'video',
            url,
            blob: res.blob,
            filename: res.filename,
            hasAudio: res.hasAudio,
            engine: res.engine,
          });
        } else {
          const img = await loadImage(f);
          const { canvas } = await decryptImage(img, pw, bs, (p) =>
            setProgress({ phase: prefix, cur: Math.round(p * 100), total: 100 }),
          );
          acc.push({
            type: 'image',
            canvas,
            filename: f.name.replace(/\.[^.]+$/, '') + `_解密_${bs}.png`,
          });
        }
      } catch (err: any) {
        acc.push({ type: 'error', filename: f.name, error: err?.message || String(err) });
      }
      setResults([...acc]);
    }

    setBusy(false);
    setProgress(null);
  }, [files, busy, wc, pw, bs, fps, format]);

  const reset = () => {
    resultUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    resultUrlsRef.current = [];
    setFiles([]);
    setResults([]);
    setProgress(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const downloadAll = async () => {
    for (const r of results) {
      if (r.type === 'error') continue;
      if (r.type === 'image') dlCanvas(r.canvas, r.filename);
      else dlBlob(r.blob, r.filename);
      await new Promise((res) => setTimeout(res, 400));
    }
  };

  const pct = progress ? Math.min(100, (progress.cur / Math.max(progress.total, 1)) * 100) : 0;

  return (
    <div className="wrap">
      <header className="header">
        <h1 className="app-title">解密工具</h1>
        <p className="app-desc">块置换算法 · 图片 &amp; 视频 · 兼容 Python 端加密</p>
        <span className="badge">
          {wc ? '⚡ WebCodecs 全速引擎' : '⚙ MediaRecorder 引擎'}
        </span>
      </header>

      {compatIssues.length > 0 && (
        <div className="card warn-card">
          <p>
            您的浏览器缺少：{compatIssues.join('、')}。
            <br />
            请使用最新版 <b>Chrome</b> 或 <b>Edge</b>。
          </p>
        </div>
      )}

      <div
        className={'card upload-card' + (drag ? ' drag' : '')}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="upload-icon">
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p className="upload-title">选择加密文件</p>
        <p className="upload-hint">支持图片和视频 · 点击或拖拽 · 可批量处理</p>
      </div>

      {files.length > 0 && (
        <div className="card">
          <div className="files-hd">
            <span className="files-count">已选 {files.length} 个文件</span>
            <button className="files-clear" onClick={clearFiles}>
              清除全部
            </button>
          </div>
          <div className="files-list">
            {files.map((f, i) => (
              <FileRow key={f.name + f.size + i} file={f} onRemove={() => removeFile(i)} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <button className="settings-hd" onClick={() => setSettingsOpen((v) => !v)}>
          <span>高级设置</span>
          <svg className={'arrow' + (settingsOpen ? ' open' : '')} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {settingsOpen && (
          <div className="settings-bd">
            <div className="srow">
              <label>解密密码</label>
              <input type="text" value={pw} spellCheck={false} onChange={(e) => setPw(e.target.value)} />
            </div>
            <div className="srow">
              <label>块大小 (px)</label>
              <input
                type="number"
                value={bs}
                min={2}
                max={256}
                onChange={(e) => setBs(parseInt(e.target.value) || 16)}
              />
            </div>
            <div className="srow">
              <label>输出格式（视频）</label>
              <div className="seg">
                <button className={format === 'mp4' ? 'on' : ''} onClick={() => setFormat('mp4')}>
                  MP4 (H.264)
                </button>
                <button className={format === 'webm' ? 'on' : ''} onClick={() => setFormat('webm')}>
                  WebM (VP9)
                </button>
              </div>
              <span className="hint">MP4 兼容性更好；如编码失败会自动回退</span>
            </div>
            <div className="srow">
              <label>视频帧率 fps（仅回退模式 / 旧浏览器需要）</label>
              <input
                type="number"
                value={fps}
                min={1}
                max={120}
                onChange={(e) => setFps(parseInt(e.target.value) || 30)}
              />
              <span className="hint">
                {wc
                  ? 'WebCodecs 模式自动保留原始帧时间戳，无需设置'
                  : '应与加密时一致，默认 30'}
              </span>
            </div>
          </div>
        )}
      </div>

      <button className="act-btn" disabled={!files.length || busy} onClick={run}>
        {busy && <span className="spinner" />}
        <span>{busy ? '解密中…' : '开始解密'}</span>
      </button>

      {progress && (
        <div className="card">
          <div className="prg-track">
            <div className="prg-bar" style={{ width: pct.toFixed(1) + '%' }} />
          </div>
          <p className="prg-label">
            {progress.phase} {progress.total > 1 ? `${progress.cur}/${progress.total}` : ''}
            {progress.extra || ''}
          </p>
        </div>
      )}

      {results.length > 0 && !busy && (
        <div className="card">
          <div className="res-hd">
            <h2>解密完成</h2>
          </div>
          <div className="res-list">
            {results.map((r, i) => (
              <ResultItem key={i} r={r} onZoom={setModalSrc} />
            ))}
          </div>
          <div className="res-acts">
            <button className="dl-all" onClick={downloadAll}>
              全部下载
            </button>
            <button className="reset-btn" onClick={reset}>
              继续处理
            </button>
          </div>
        </div>
      )}

      {modalSrc && (
        <div className="modal" onClick={() => setModalSrc(null)}>
          <img src={modalSrc} alt="preview" />
        </div>
      )}
    </div>
  );
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!isVideo(file)) {
      const url = URL.createObjectURL(file);
      setThumb(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file]);
  const vid = isVideo(file);
  return (
    <div className="file-item">
      {vid ? (
        <div className="file-thumb file-thumb-vid">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      ) : (
        thumb && <img className="file-thumb" src={thumb} alt="" />
      )}
      <span className="file-name">{file.name}</span>
      <span className={'file-tag ' + (vid ? 'tag-vid' : 'tag-img')}>{vid ? '视频' : '图片'}</span>
      <button
        className="file-rm"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    </div>
  );
}

function ResultItem({ r, onZoom }: { r: Result; onZoom: (src: string) => void }) {
  if (r.type === 'error') {
    return (
      <div className="res-item">
        <div className="res-err">⚠ {r.filename}: {r.error}</div>
      </div>
    );
  }
  if (r.type === 'image') {
    return (
      <div className="res-item">
        <img
          src={thumbDataUrl(r.canvas)}
          alt={r.filename}
          onClick={() => onZoom(r.canvas.toDataURL('image/png'))}
        />
        <div className="res-bar">
          <span className="res-fn">{r.filename}</span>
          <div className="res-info">
            <span className="file-tag tag-img">图片</span>
            <button className="res-dl" onClick={() => dlCanvas(r.canvas, r.filename)}>
              下载
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="res-item">
      <video src={r.url} controls playsInline preload="metadata" />
      <div className="res-bar">
        <span className="res-fn">{r.filename}</span>
        <div className="res-info">
          <span className="file-tag tag-vid">{r.engine}{r.hasAudio ? ' · 含音频' : ''}</span>
          <button className="res-dl" onClick={() => dlBlob(r.blob, r.filename)}>
            下载
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- helpers ----------
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片解码失败'));
      im.src = e.target!.result as string;
    };
    r.onerror = () => rej(new Error('文件读取失败'));
    r.readAsDataURL(file);
  });
}

function thumbDataUrl(canvas: HTMLCanvasElement): string {
  const max = 440;
  const ratio = Math.min(max / canvas.width, max / canvas.height, 1);
  const tc = document.createElement('canvas');
  tc.width = Math.round(canvas.width * ratio);
  tc.height = Math.round(canvas.height * ratio);
  tc.getContext('2d')!.drawImage(canvas, 0, 0, tc.width, tc.height);
  return tc.toDataURL('image/jpeg', 0.85);
}

function dlCanvas(canvas: HTMLCanvasElement, name: string) {
  const a = document.createElement('a');
  a.download = name;
  try {
    a.href = canvas.toDataURL('image/png');
    a.click();
  } catch {
    canvas.toBlob((b) => {
      if (b) {
        a.href = URL.createObjectURL(b);
        a.click();
      }
    }, 'image/png');
  }
}

function dlBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.download = name;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
