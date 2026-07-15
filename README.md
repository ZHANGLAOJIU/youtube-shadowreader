# YouTube 双语字幕

一个零构建依赖的 Chrome Manifest V3 插件。它读取 YouTube 已有英文字幕，整理成
句级时间轴，并在视频上同步显示英文与 YouTube 自动简体中文翻译。

## 本地安装

1. 在 Chrome 地址栏打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择整个 `reader_on_chrome` 文件夹。
5. 打开一个带英文字幕的普通 YouTube 视频。

点击扩展图标可以切换中英模式、字号、字幕高度和背景深度。建议关闭 YouTube
自带字幕，避免两套字幕重叠。

点击“在固定标签页打开”会在当前 Chrome 窗口左侧创建一个固定伴读页；
再次打开会复用它，不会产生重复标签。需要双屏时，可改用“在独立窗口打开”。
伴读器支持：

- 点击前后句或完整字幕跳转到对应时间。
- 空格播放/暂停，左右方向键切换前后句。
- 底部同步显示 Global Speed 的当前倍率。
- Global Speed 调速后，左上角显示当前倍率，2 秒后自动隐藏。
- 拖动底部进度条控制 YouTube。
- 切换中英模式、明暗主题并打开完整字幕列表。
- 在 YouTube 提供词时间戳时进行真实逐词高亮，不调用 ASR 或模型。
- 人工字幕没有词时间戳时，会自动使用 YouTube 自动英文轨道的真实词时间轴进行对齐。

在 YouTube 普通视频页按 `Option + Shift + R`（Windows/Linux 为
`Alt + Shift + R`）可打开固定伴读页；在伴读页再按一次会切回原视频。
Chrome 也允许在
`chrome://extensions/shortcuts` 中自定义这个快捷键。

### Global Speed 倍速

伴读器不再写入视频倍率，由 Global Speed 单独接管，因此不会出现两个插件
互相改回的问题。要在伴读页聚焦时调速，请在 Global Speed 设置的
“浏览器快捷键”区域创建倍速命令。这类快捷键可控制后台标签页的 YouTube
视频；“页面快捷键”不能在 `chrome-extension://` 伴读页中工作。

## 当前支持

- 普通 YouTube 录播视频。
- 人工或自动英文字幕。
- YouTube 自动简体中文翻译轨道。
- 句级整理、双语覆盖层、播放/拖动同步和词级时间戳。
- YouTube SPA 视频切换、全屏、字幕缓存和 429 退避。
- 网页字幕地址失效时自动切换到 YouTube 备用播放器接口。

暂不支持直播、Shorts、无字幕视频和 MiMo 翻译 fallback。

## 隐私

插件不下载视频、不读取页面账户数据、不上传音频，也不需要 API key。字幕只从
YouTube 获取并缓存在本机 IndexedDB。

## 测试

```bash
npm test
```
