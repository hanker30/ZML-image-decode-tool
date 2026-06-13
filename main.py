"""
图像/视频解密工具 - Android版
"""
import os, sys, json, math, random, shutil, tempfile, threading, subprocess

from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.label import Label
from kivy.uix.button import Button
from kivy.uix.textinput import TextInput
from kivy.uix.progressbar import ProgressBar
from kivy.uix.popup import Popup
from kivy.uix.filechooser import FileChooserListView
from kivy.clock import Clock
from kivy.utils import platform

from PIL import Image
import numpy as np

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    HAS_FFMPEG = True
except ImportError:
    FFMPEG = None
    HAS_FFMPEG = False

# ========== 平台适配 ==========
if platform == 'android':
    try:
        from android.permissions import request_permissions, Permission
        request_permissions([
            Permission.READ_EXTERNAL_STORAGE,
            Permission.WRITE_EXTERNAL_STORAGE,
        ])
    except Exception:
        pass
    try:
        from android.storage import app_storage_path
        APP_DIR = app_storage_path()
    except Exception:
        APP_DIR = '/data/local/tmp'
    START_DIR = '/storage/emulated/0'
else:
    from kivy.core.window import Window
    Window.size = (600, 720)
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
    START_DIR = os.path.expanduser('~')

CONFIG_FILE = os.path.join(APP_DIR, 'config.json')

# ========== 配置 ==========
def load_cfg():
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def save_cfg(data):
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# ========== 文件类型 ==========
VID_EXT = {'.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'}
IMG_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'}
ALL_EXT = VID_EXT | IMG_EXT

def ftype(p):
    e = os.path.splitext(p)[1].lower()
    if e in VID_EXT:
        return 'video'
    if e in IMG_EXT:
        return 'image'
    return None

# ========== 解密核心 ==========
def split_blk(img, bs):
    w, h = img.size
    nc = math.ceil(w / bs)
    nr = math.ceil(h / bs)
    blks = []
    for r in range(nr):
        for c in range(nc):
            blks.append(img.crop((c * bs, r * bs,
                                  min((c + 1) * bs, w), min((r + 1) * bs, h))))
    return blks, w, h, nr, nc

def merge_blk(blks, w, h, nr, nc, bs):
    out = Image.new('RGB', (w, h))
    for i, b in enumerate(blks):
        out.paste(b, ((i % nc) * bs, (i // nc) * bs))
    return out

def decrypt_img(pil, pw, bs):
    w, h = pil.size
    nw = (w // bs) * bs
    nh = (h // bs) * bs
    if nw != w or nh != h:
        pil = pil.crop(((w - nw) // 2, (h - nh) // 2,
                        (w + nw) // 2, (h + nh) // 2))
        w, h = nw, nh
    blks, w, h, nr, nc = split_blk(pil, bs)
    nb = len(blks)
    random.seed(pw)
    idx = list(range(nb))
    random.shuffle(idx)
    inv = [0] * nb
    for o, n in enumerate(idx):
        inv[n] = o
    res = [None] * nb
    for p in range(nb):
        res[inv[p]] = blks[p]
    return merge_blk(res, w, h, nr, nc, bs)

def save_unique(d, name, ext):
    p = os.path.join(d, name + ext)
    c = 1
    while os.path.exists(p):
        p = os.path.join(d, f'{name}_{c}{ext}')
        c += 1
    return p

# ========== 图片解密 ==========
def proc_image(path, pw, bs, sdir):
    try:
        img = Image.open(path).convert('RGB')
    except Exception as e:
        return False, f'打开失败: {e}'
    res = decrypt_img(img, pw, bs)
    base = os.path.splitext(os.path.basename(path))[0]
    ext = os.path.splitext(path)[1].lower()
    out_ext = '.png' if ext in ('.jpg', '.jpeg') else ext
    out = save_unique(sdir, f'{base}_解密_{bs}', out_ext)
    try:
        res.save(out)
        return True, out
    except Exception as e:
        return False, f'保存失败: {e}'

# ========== 视频解密 ==========
def proc_video(path, pw, bs, sdir, pcb=None):
    if not HAS_CV2:
        return False, '需要opencv库才能处理视频'
    td = tempfile.mkdtemp()
    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return False, '无法打开视频'
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # 提取音频
        ap = os.path.join(td, 'audio.aac')
        ha = False
        if HAS_FFMPEG:
            try:
                subprocess.run([FFMPEG, '-i', path, '-vn',
                               '-acodec', 'copy', '-y', ap],
                              capture_output=True, timeout=120)
                ha = os.path.exists(ap) and os.path.getsize(ap) > 0
            except Exception:
                pass

        # 逐帧解密
        tv = os.path.join(td, 'temp.mp4')
        wr = cv2.VideoWriter(tv, cv2.VideoWriter_fourcc(*'mp4v'), fps, (vw, vh))
        i = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            dec = decrypt_img(Image.fromarray(rgb), pw, bs)
            wr.write(cv2.cvtColor(np.array(dec), cv2.COLOR_RGB2BGR))
            i += 1
            if pcb and total > 0:
                pcb(i, total)
        cap.release()
        wr.release()

        # 输出路径
        base = os.path.splitext(os.path.basename(path))[0]
        ext = os.path.splitext(path)[1].lower()
        if ext not in VID_EXT:
            ext = '.mp4'
        out = save_unique(sdir, f'{base}_解密_{bs}', ext)

        # 合并音频
        if ha and HAS_FFMPEG:
            try:
                subprocess.run([
                    FFMPEG, '-i', tv, '-i', ap,
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                    '-c:a', 'aac', '-b:a', '192k', '-y', out
                ], capture_output=True, timeout=900)
                if os.path.exists(out) and os.path.getsize(out) > 0:
                    return True, out
            except Exception:
                pass

        shutil.copy2(tv, out)
        return True, out
    except Exception as e:
        return False, f'出错: {e}'
    finally:
        shutil.rmtree(td, ignore_errors=True)

# ========== 主界面 ==========
class DecryptApp(App):
    title = '图像/视频解密工具'

    def build(self):
        cfg = load_cfg()
        self.save_dir = cfg.get('save_path', '')

        root = BoxLayout(orientation='vertical', padding=15, spacing=10)

        # 标题
        root.add_widget(Label(
            text='[b]图像 / 视频解密工具[/b]', markup=True,
            font_size='24sp', size_hint_y=None, height=50))

        # 依赖状态
        st = '图片: 就绪'
        st += '  |  视频: ' + ('就绪' if HAS_CV2 else '需安装opencv')
        st += '  |  音频: ' + ('就绪' if HAS_FFMPEG else '无')
        root.add_widget(Label(text=st, font_size='11sp',
                              size_hint_y=None, height=20))

        # ---- 设置区 ----
        cfg_box = BoxLayout(orientation='vertical',
                            size_hint_y=None, height=130, spacing=4)

        r1 = BoxLayout(size_hint_y=None, height=40)
        r1.add_widget(Label(text='密码:', font_size='16sp', size_hint_x=0.22))
        self.pw = TextInput(text=cfg.get('password', '在梦里w'),
                            multiline=False, font_size='16sp',
                            size_hint_x=0.78)
        r1.add_widget(self.pw)
        cfg_box.add_widget(r1)

        r2 = BoxLayout(size_hint_y=None, height=40)
        r2.add_widget(Label(text='块大小:', font_size='16sp', size_hint_x=0.22))
        self.bs = TextInput(text=str(cfg.get('block_size', 16)),
                            multiline=False, input_filter='int',
                            font_size='16sp', size_hint_x=0.78)
        r2.add_widget(self.bs)
        cfg_box.add_widget(r2)

        r3 = BoxLayout(size_hint_y=None, height=44)
        self.save_lbl = Label(
            text='保存: ' + (self.save_dir or '默认(原文件旁边)'),
            font_size='13sp', shorten_from='left')
        r3.add_widget(self.save_lbl)
        r3.add_widget(Button(text='选位置', size_hint_x=None, width=80,
                             font_size='14sp', on_press=self._pick_save))
        r3.add_widget(Button(text='默认', size_hint_x=None, width=60,
                             font_size='14sp', on_press=self._reset_save))
        cfg_box.add_widget(r3)

        root.add_widget(cfg_box)

        # ---- 操作按钮 ----
        btn = BoxLayout(size_hint_y=None, height=55, spacing=10)
        btn.add_widget(Button(text='选择文件', font_size='16sp',
                              on_press=self._pick_files))
        btn.add_widget(Button(text='选择文件夹', font_size='16sp',
                              on_press=self._pick_dir))
        root.add_widget(btn)

        # ---- 进度 ----
        self.prog = ProgressBar(max=100, value=0,
                                size_hint_y=None, height=25)
        root.add_widget(self.prog)

        self.status = Label(text='等待选择文件...',
                            font_size='14sp', size_hint_y=None, height=30)
        root.add_widget(self.status)

        # ---- 日志 ----
        self.logw = TextInput(readonly=True, multiline=True,
                              font_size='12sp', size_hint_y=1)
        root.add_widget(self.logw)

        # 底部提示
        root.add_widget(Label(
            text='支持: jpg/png/bmp  |  mp4/avi/mov/mkv 等',
            font_size='11sp', size_hint_y=None, height=20))

        return root

    # ---- 线程安全的 UI 更新 ----
    def _log(self, msg):
        Clock.schedule_once(
            lambda dt: setattr(self.logw, 'text',
                               self.logw.text + msg + '\n'), 0)

    def _status(self, msg):
        Clock.schedule_once(
            lambda dt: setattr(self.status, 'text', msg), 0)

    def _prog(self, v):
        Clock.schedule_once(
            lambda dt: setattr(self.prog, 'value', v), 0)

    def _save_cfg(self):
        save_cfg({
            'save_path': self.save_dir,
            'password': self.pw.text,
            'block_size': self.bs.text
        })

    # ---- 文件选择器 ----
    def _chooser(self, title, mode, callback):
        content = BoxLayout(orientation='vertical', spacing=5, padding=5)
        fc = FileChooserListView(path=START_DIR,
                                 dirselect=(mode == 'dir'))
        content.add_widget(fc)

        btns = BoxLayout(size_hint_y=None, height=50, spacing=10)

        def ok(_):
            popup.dismiss()
            sel = fc.selection
            if mode == 'file':
                callback(sel if sel else [])
            else:
                callback(sel[0] if sel else fc.path)

        def cancel(_):
            popup.dismiss()

        btns.add_widget(Button(text='确定', on_press=ok))
        btns.add_widget(Button(text='取消', on_press=cancel))
        content.add_widget(btns)

        popup = Popup(title=title, content=content,
                      size_hint=(0.95, 0.9))
        popup.open()

    # ---- 保存位置 ----
    def _pick_save(self, _):
        self._chooser('选择保存位置', 'dir', self._on_save)

    def _on_save(self, p):
        if p and os.path.isdir(p):
            self.save_dir = p
            self.save_lbl.text = f'保存: {p}'
            self._save_cfg()

    def _reset_save(self, _):
        self.save_dir = ''
        self.save_lbl.text = '保存: 默认(原文件旁边)'
        self._save_cfg()

    # ---- 选择文件 / 文件夹 ----
    def _pick_files(self, _):
        self._chooser('选择文件', 'file', self._on_files)

    def _on_files(self, sel):
        files = [f for f in sel
                 if os.path.isfile(f) and ftype(f)]
        if files:
            self._save_cfg()
            self.logw.text = ''
            threading.Thread(target=self._run,
                             args=(files,), daemon=True).start()

    def _pick_dir(self, _):
        self._chooser('选择文件夹', 'dir', self._on_dir)

    def _on_dir(self, path):
        if not (path and os.path.isdir(path)):
            return
        files = [os.path.join(path, f) for f in os.listdir(path)
                 if os.path.isfile(os.path.join(path, f))
                 and os.path.splitext(f)[1].lower() in ALL_EXT]
        if files:
            self._save_cfg()
            self.logw.text = ''
            threading.Thread(target=self._run,
                             args=(files,), daemon=True).start()
        else:
            self._log('该文件夹中没有找到支持的文件')

    # ---- 处理 ----
    def _run(self, files):
        pw = self.pw.text
        try:
            bs = int(self.bs.text)
            if bs < 1:
                raise ValueError
        except ValueError:
            self._status('错误: 块大小必须为正整数')
            return

        sdir = self.save_dir if self.save_dir else ''
        total = len(files)
        ok_count = 0

        for i, fp in enumerate(files):
            fn = os.path.basename(fp)
            ft = ftype(fp)
            tag = {'video': '[视频]', 'image': '[图片]'}.get(ft, '[?]')
            self._status(f'处理 ({i + 1}/{total}) {tag} {fn}')
            self._prog(0)

            d = sdir if sdir else os.path.dirname(fp)

            if ft == 'video':
                def cb(done, tot, ci=i, ct=total):
                    pct = ((ci / ct) + (done / tot) / ct) * 100
                    self._prog(pct)
                s, m = proc_video(fp, pw, bs, d, cb)
            elif ft == 'image':
                s, m = proc_image(fp, pw, bs, d)
            else:
                s, m = False, '不支持的格式'

            if s:
                ok_count += 1
                self._log(f'{tag} 已保存: {os.path.basename(m)}')
            else:
                self._log(f'{tag} 失败: {fn} → {m}')

        self._prog(100)
        self._status(f'完成! 成功 {ok_count}/{total}')
        self._save_cfg()


if __name__ == '__main__':
    DecryptApp().run()
