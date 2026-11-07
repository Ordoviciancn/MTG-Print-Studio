# 万智牌打印工坊 · MTG Print Studio

[打开公开网页版 · Open MTG Print Studio](https://ordoviciancn.github.io/MTG-Print-Studio/)

公开版在浏览器内查询 Scryfall、选择英文印刷版本和生成 A4 PDF。MPCFill 的社区图可从其网站下载后，在「社区高清 / 异画」中导入 PNG 或 JPEG。带标准 MPC 出血的图可勾选裁边，已裁好的卡面请取消勾选。图片文件留在浏览器中。Windows 本地版也提供直接查询 MPCFill 的功能。

## Windows 本地版

Windows 双击 **启动.cmd**，浏览器会打开本地界面。需要 Python 3.10+。首次启动会在项目目录创建独立环境并联网安装 Pillow，请等启动窗口显示网页地址。

程序只监听本机。浏览器不会自动打开时，访问 http://127.0.0.1:8765。端口被占用时可运行 `.\启动.cmd --port 8766`。关闭启动窗口可退出。

## 导入与打印

1. 粘贴或上传牌表，工具会按内容识别格式。文件支持 UTF-8 和带 BOM 的 UTF-16。
   - 文本支持 Arena、Moxfield、MTGO 的纯文本导出，以及 XMage 风格的 `4 [M11:149] Lightning Bolt`。也可写 `4 Lightning Bolt`、`4x Lightning Bolt`、`Lightning Bolt x4` 或 `1 Crystal Vein (PLST) MIR-325`。纯文本的 `Sideboard`、`[Sideboard]` 或 `SB:` 标记备牌。同一分区、同一版本的重复牌会合并数量。
   - CSV 和 TSV 需要卡名、数量表头，例如 `Name,Quantity,Set Code,Collector Number,Board`。系列代码、收藏编号和分区列可省略。只有系列代码时会在该系列中选图。
2. 查找英文卡图。工具会识别 Scryfall 支持的系列别名，例如 `NMS` 对应 `NEM`，保留指定的收藏编号。确实查不到的版本会标为未匹配。点「选图」浏览英文印刷版，或切到「社区高清 / 异画」。社区候选会优先显示可按系列与收藏编号匹配的图，再按来源标注的分辨率排序。社区图的语言不明时需按预览核对。
3. 下载 A4 PDF。每页最多 9 个卡面，每个裁切框 **63 × 88 mm**。双面牌的两面分别占一个卡位。选择社区卡面时，若系列和编号匹配，可沿用对应 Scryfall 反面。没有匹配的反面时，可换用英文印刷版或关闭反面输出。
4. 在 PDF 查看器中选择 A4 和「实际大小 / 100%」，关闭「适合页面」，并用尺核对 50 mm 校准线。

## 图源与字体

- [Scryfall](https://scryfall.com/docs/api) 提供英文印刷版本和卡图，常见完整 PNG 为 745 × 1040 像素。导出读取原图地址。
- [MPC Autofill](https://github.com/chilli-axe/mpc-autofill) 提供社区高清图和异画，导出读取原图并按标注的 DPI 裁掉出血。来源标注的 DPI 不等于原生细节。社区服务器不可用时，仍可用 Scryfall 选图和导出。
- 界面通过 Google Fonts 加载 [Manrope](https://fonts.google.com/specimen/Manrope)、[Playfair Display](https://fonts.google.com/specimen/Playfair+Display)、[Noto Sans SC](https://fonts.google.com/specimen/Noto+Sans+SC) 和 [Noto Serif SC](https://fonts.google.com/specimen/Noto+Serif+SC)。这四款字体均采用 SIL Open Font License。离线或字体服务不可用时会回退到系统字体。
- 卡图在用户发起查询和导出时从图源获取。项目随附的文件不包含卡图。

如果经本机代理访问图源时出现超时或 MPCFill 523，而网络可以直连对应服务，可以仅在本次 PowerShell 启动会话中将这些域名排除出代理：

```powershell
$env:NO_PROXY = "127.0.0.1,localhost,api.scryfall.com,cards.scryfall.io,mpcfill.com"
.\启动.cmd
```

## 验证

```powershell
python -m unittest -v
node --test test_browser.mjs
```
