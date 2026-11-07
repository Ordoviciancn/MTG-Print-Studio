# 万智牌打印工坊协作说明

- 本目录是独立的本地打印工具。运行 `python server.py`，测试使用 `python -m unittest -v`。Python 依赖见 `requirements.txt`。
- `decklists.py` 按内容识别并解析牌表，`cards.py` 读取外部图源，`print_pdf.py` 管理 PDF 物理排版，`server.py` 提供本机接口，`index.html`、`app.js`、`labels.js` 和 `style.css` 构成界面。
- 英文纸牌印刷版以系列与收藏编号精确匹配；社区图保留来源标注。导出必须使用选定的原图，保持 A4 页面及 63 × 88 mm 卡框。
- 修改用户界面时同步更新简体中文和英文文案。卡名保留原文。不要提交卡图、用户牌表、生成的 PDF 或运行缓存。
- GitHub Pages 使用项目根目录静态文件，页面和模块引用使用相对路径。`browser-deck.mjs`、`browser-api.mjs` 和 `browser-pdf.mjs` 分别负责网页版的导入、查图和 PDF。修改导入规则时同步核对本地版和网页版，运行 `node --test test_browser.mjs`。
