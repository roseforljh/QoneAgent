# OpenAI Yarn Film

用 Python、OpenCV、NumPy 和项目内 FFmpeg 生成的 40 秒宣传动画。

- 画面：1280×720，60 fps，2400 帧
- 声音：48 kHz 双声道，合成配乐、推球击打、毛线噪声、灯光音和快门声
- 时间线：接力推球 0–17s；毛线织 logo 16–26s；毛绒 logo 立起 24–31s；六色光线合成白光 31–36s；闪光灯合影 35–40s

重新生成：

```powershell
python artifacts/openai-yarn-film/generate.py
```

关键帧和音频自检：

```powershell
python artifacts/openai-yarn-film/generate.py --smoke
```
