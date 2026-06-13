[app]

# 应用信息
title = 图像视频解密工具
package.name = decrypttool
package.domain = org.myapp
source.dir = .
source.include_exts = py,png,jpg,json
version = 1.0.0

# 依赖（基础版，只支持图片）
#requirements = python3,kivy,pillow,numpy

# 如果想支持视频，改成下面这行（APK会大很多，约150MB）：
requirements = python3,kivy,pillow,numpy,opencv-python-headless,imageio-ffmpeg

# 界面
orientation = portrait
fullscreen = 0

# 权限
android.permissions = READ_EXTERNAL_STORAGE,WRITE_EXTERNAL_STORAGE,MANAGE_EXTERNAL_STORAGE

# Android 版本
android.api = 29
android.minapi = 24
android.archs = arm64-v8a

# 允许备份
android.allow_backup = True

# 日志
android.logcat_filters = *:S python:D

[buildozer]
log_level = 2
warn_on_root = 0
