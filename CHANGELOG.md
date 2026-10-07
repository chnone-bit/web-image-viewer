# 网页图片浏览器 · 版本改动记录

> 油猴脚本 `web-image-viewer.user.js`
> 从「论坛帖子看图」逐步收敛为「通用网页图片组浏览」。
> 本文档记录每个版本的改动、设计决策、已知取舍与后续待办。

---

## 目录

- [当前状态](#当前状态)
- [版本历史](#版本历史)
- [核心设计决策](#核心设计决策)
- [图片分组算法（以图定域）](#图片分组算法以图定域)
- [分组修复补丁清单](#分组修复补丁清单)
- [批量打包下载（评审记录 · 已于 v1.6.0 落地）](#计划中功能批量打包下载)
- [架构演进：插件化准备](#架构演进插件化准备)
- [工程约定](#工程约定)
- [测试套件](#测试套件)
- [已知取舍与待办](#已知取舍与待办)

---

## 当前状态

| 项 | 值 |
|---|---|
| 当前版本 | **1.8.0** |
| 脚本文件 | `web-image-viewer.user.js` |
| 文件行数 | ~4840 |
| 匹配范围 | `*://*/*`（全站可用，含白名单模式） |
| 测试套件 | 13 个，合计 **446 项断言全绿** |
| 定位 | 通用网页图片组浏览 + 批量打包下载；论坛场景为最优适配对象 |
| 计划中 | 跨域降级（`GM_xmlhttpRequest`）、超阈值分卷 ZIP |

### 模块布局

| 序号 | 模块 | 职责 |
|---|---|---|
| 0 | utils/consts | 常量、URL 安全边界、DOM 顺序排序、`debounce` |
| 1 | ConfigStore | 全局配置 + 站点级配置覆盖与落盘 |
| 2 | ImagePool | 图片采集 / 过滤 / 动态增量 / **以图定域** / `groups()` 分组枚举 |
| 2.5 | ImageDownloader | 批量打包下载：取 Blob / 文件名生成 / STORE 模式 ZIP / 失败清单 / 取消（v1.6.0 新增） |
| 3 | ThemeProbe | 站点主题探测（主色、圆角、字体、明暗） |
| 4 | CSS | 样式注入与主题变量单点写入 |
| 5 | Viewer + ThumbBar | 浏览层、缩略图进度条、悬停预览、缩放平移、快捷键、组间续览、打包下载入口 |
| 5.5 | HoverBadge | 图片悬停角标（分组浏览的默认入口） |
| 6 | Dimmer | 浏览时压暗页面 |
| 7 | Settings | 配置面板 |
| 8 | FloatingButton | 悬浮入口按钮 |
| — | `boot()` | 启动装配 |

---

## 版本历史

### v1.8.0 — 懒加载图片地址采集（解法 1：全量启发式扫描）（当前版本）

> **触发**：用户反馈「有一类网站自带看图功能，用了本脚本后只能拿到站点预设的占位图」。
> 定位为**采集层缺口**，与 v1.7.0 的跨域权限无关 —— 采集面对的不是权限问题，
> 而是"枚举属性名"这个做法本身不可扩展。

#### 根因：白名单枚举必然漏

原`pickSrc()` 只查 9 个固定属性名：

```js
const attrs = ['data-original', 'data-src', 'data-lazy-src', 'data-actualsrc',
  'data-echo', 'data-url', 'data-image', 'data-large', 'data-origin'];
```

但社区懒加载**没有规范**。实测存在的命名至少还包括：
`data-tfsrc`（ThinkPHP）、`data-original-src`（layui/lazyload）、`data-raw`、
`data-ks-lazyload`（KSLazy）、`data-originalUrl`、`data-img`、`data-imageurl`、
`data-srcset`、`data-lazy`… **补完名单还会出新名字**，属于打地鼠。

#### 变更一：白名单 → 全量 `data-*` 启发式扫描

新增 `looksLikeImageUrl(v)`，判定"这个属性的值长得像不像图片地址"：

| 判据 | 例子 |
|---|---|
| 有图片扩展名 | `a.jpg` / `a.webp?v=2` / `a.PNG#x` |
| 等号式CDN 参数 | `?imageView&type=webp`、`?w=1200&h=800` |
| **斜杠式** CDN 参数 | `?imageView2/1/w/800`（阿里云 OSS）、`?imageMogr2/thumbnail/800x` |
| 尺寸词路径 | `/thumb/` `/large/` `/resize/` `/original/` |
| 前置排除 | `data:` URI、脏协议、超长串（base64） |

三层优先级**必须严格保持**（有测试锁定）：

```
1. 已知高可信属性名（LAZY_ATTR_PRIORITY）
2. 全量扫描其余 data-*（启发式）← 本次新增
3. srcset（取最大档） → currentSrc / src
```

⚠️ 第 2 层会跳过已在第 1 层查过的属性，否则低可信属性会抢在 `srcset` 之前被选中。

#### 变更二：占位图**不定案**（pending）

原 `judge()` 只在 `naturalWidth === 0` 时返回 `pending`。但占位图场景是
**naturalWidth 有值（1×1 已加载完）却远小于阈值**，直接被 `reject` 掉，
真图来了也没机会补上。

现在：尺寸过小**且**当前 src 命中占位图特征 → 返回 `pending` 而非 `reject`。

#### 变更三：属性变化**立即**重判（而非等 15s）

原 MutationObserver 对 `rec.type === 'attributes'` 只有一句 `needFull = true`，
真正重判要等 15s 兜底扫描 —— 用户滚到那儿得等十几秒才看到图。

现在改为把**该元素最近的内容容器**送进增量扫描：

```js
added.push(el.closest(CONTENT_SEL) || el);
```

⚠️ 为什么不是直接推元素本身：`scanNodes` 的准入判定 `isWithinCollectScope()`
是按「顶层节点」粒度判的，单个 `<img>` 通常不匹配任何内容选择器 → 整批被拒。
`.message` / `.post` 容器才是正确粒度。

同时把 `attributeFilter` 从 4 个名字扩到 20 个，与 `pickSrc` 的采集面保持一致
——**扫描能看到但变化收不到通知**是最隐蔽的不对称 bug。

#### 两个被否决的设计（记录下来免得重犯）

| 曾经的方案 | 为什么否决 |
|---|---|
| 给每个 pending 元素单独挂 MutationObserver | 几百张图 = 几百个 observer；滚动时批量换 src 同时触发几百个回调，实测掉帧 |
| 去掉 `attributeFilter` 监听全部属性 | 站点挂的 `data-state` / `aria-*` / 悬停态标记都会触发回调，图片多的页面吃 CPU |

最终方案复用**已有的**全局 observer，只改它的 attributes 分支，零新增实例。

#### 测试

新增 `verify-lazyload.js` **47 项**，全套 **13 套件 / 446 项全绿**。

分组：奇葩属性名识别（9 种）/ CDN 参数兜底 / 占位图跳过（4 种）/
非图片值不误判（7 种）/ **安全过滤不被绕过**（`javascript:` `file:` `vbscript:` `data:`）/
优先级不被破坏 / 属性顺序无关 / 占位图→真图替换 / 定案后不重复入池 / 监听面覆盖。

⚠️ 测试踩的坑：等待时间必须**大于** `scanAddedDebounced` 的 300ms 防抖，
等于 300 会卡在边界上产生假失败（我第一次就栽在这）。

### v1.7.0 — 跨域取图（GM_xmlhttpRequest 降级通道）

> **触发事件**：v1.6.2 真机实测，批量下载全部失败。控制台报错
> `Access to fetch at 'https://23img.com/...' from origin 'https://t66y.com'
> has been blocked by CORS policy` —— 证实 v1.6.0 评审时预留的"跨域降级二期"
> 不是可选项，而是**功能可用性的必要条件**。

#### 为什么纯 fetch 行不通

| 环节 | 是否受同源策略约束 |
|---|---|
| `<img src="跨域地址">` 显示 | ❌ **不受限**（图片加载历来不走 CORS） |
| `fetch(url).arrayBuffer()` | ✅ **受限**，需服务端返回 `Access-Control-Allow-Origin` |

论坛图床（23img / 66img / thumbsnap / sohu 图床等）默认**不发**该响应头，
所以浏览器允许你"看见"图，却不允许脚本"读走"它的二进制。
本次实测还发现 thumbsnap 返回了 `Access-Control-Allow-Origin: *, *`
这种**非法多重值**，同样会被判为失败——即便它本意是开放。

#### 变更

| 项 | 旧 | 新 |
|---|---|---|
| `@grant` | 5 个 | **6 个**（+`GM_xmlhttpRequest`） |
| `@connect` | 无 | **`*`** |
| 取数策略 | 仅 `fetch` | `fetch` 优先 → 失败降级 GM 通道 |
| 配置项 | — | `crossOriginFallback`（默认 `true`，可在设置面板关闭） |

**新增 `gmFetchOne()`**：
- `responseType: 'arraybuffer'`（不用 blob —— 部分 GM 实现里 blob 类型不稳定）
- `anonymous: false` —— 携带 Cookie，登录态图床必需
- 独立超时保险（`TIMEOUT + 2000`），因部分实现不触发 `ontimeout`
- 单一 `settled` 闸门杜绝重复 settle（abort/timeout/error 竞态）
- 失败**如实分类上报**：HTTP 码 / 非图片响应 / 网络错误 / 超时 / 响应为空

**降级判定**：只有 `fetch` 抛出**网络层**异常才降级；用户取消不重试；
`fetch` 成功时**绝不走** GM（避免无谓使用扩展层权限）。

#### 权限说明（重要）

新增 `GM_xmlhttpRequest` + `@connect *` 属于**扩展层向任意站点发请求**，
油猴会在安装/更新时提示权限变更。这是所有跨域下载类脚本的通行做法，
但**给了用户一个安全阀**：

> 设置 → 批量打包下载 → **「打包下载跨域降级」** 关闭后，
> 脚本不会向图床发起任何扩展层请求，代价是跨域图无法下载。

#### 诊断工具同步修正

`__fiv.diagPack()` 原先直接调裸 `fetch`，**只能重现 CORS 报错，无法验证降级通道**——
这正是它误导排查方向的原因。现已改为走真实取数链路，并输出通道名：

```
[打包诊断] GM_xmlhttpRequest 跨域通道：可用
✅ 1 [gm] image/jpeg 48213B  https://23img.com/i/2026/10/05/10f5sf0.jpg
✅ 2 [fetch] image/png 12045B https://x.com/same-origin.png
[打包诊断] 完成：成功 12 / 失败 0（其中 10 张走了跨域降级通道）
```

主文案也标明通道分布：`✅ 已打包 12 张 · 8.4 MB（2 直连 + 10 跨域通道）`

#### 测试

`verify-download.js` 86 → **121 项**（新增 35 项），全套 **12 套件 / 366 项全绿**。

新增覆盖：CORS 拦截下成功打包 / 无 GM 权限时零请求 / 开关关闭时零请求 /
同源成功时零 GM 请求 / GM 侧 5 类失败如实上报 / 取消能中断 GM 请求。

⚠️ 测试方法记录：`GM_xmlhttpRequest` 的桩必须挂在 **jsdom window 上**而非
`globalThis`（脚本在 window 作用域求值），且要能按用例开关，才能同时测
"有权限"与"无权限"两条路径。

### v1.6.2 — 打包下载「点了没反应」排查

用户反馈：点了打包下载，**没有任何反应**。排查出一个真 bug + 一个体验缺陷。

#### 🐛 真 bug：油猴菜单命令完全失效（ReferenceError）

```js
// boot() 作用域
window.__fivPack = (mode) => packDownload(...);   // ❌ packDownload 是 Viewer 闭包内的函数
```

`packDownload` 定义在 `Viewer` 的 IIFE 内部，而 `boot()` 在其外层。
箭头函数按词法作用域向上查找，**找不到这个名字** → 抛
`ReferenceError: packDownload is not defined`。

工具条按钮走的是 Viewer 内部闭包，所以**按钮能用、菜单全废** ——
这正是测试盲区：只断言了 `typeof __fivPack === 'function'`，
**没实际调用它**，自测全绿而真机报错。

**修复**：改走已导出的 `Viewer.packDownload`。

```js
window.__fivPack = (mode) => Viewer.packDownload(mode === 'group' ? 'group' : 'all');
```

#### 🐠 体验缺陷：失败时信息藏在下面，主文案像"只成功了 N 张"

- **全部失败**时只写「没有可打包的图片」→ 现在会**直接说清楚原因**：
  区分 CORS 拦截 / 需登录态 / 超时三类，给出对应提示。
- **部分失败**时主文案只写「已打包 2 张」→ 用户会以为另外 2 张不存在，
  误以为功能有问题 → 现在主文案同时报失败数：`✅ 已打包 2 张 · 1.2 MB（2 张失败，见下方）`。

#### 🔧 排障入口：`__fiv.diagPack()`

批量下载最难的判断是「**哪一张失败了、为什么**」——而 jsdom 无法验证真实网络行为
（尤其 CORS）。新增控制台诊断：

```js
__fiv.diagPack()   // 逐张真实 fetch，把状态码/MIME/字节数或错误打到 console
```

输出形如：

```
✅ 1 200 image/jpeg 48213B https://x.com/a1.jpg
❌ 2 Failed to fetch https://cdn.other.com/b.jpg
[打包诊断] 完成：成功 4 / 失败 2
[打包诊断] 失败多半是跨域被 CORS 拦住。浏览器允许 <img> 跨域显示，但不允许 fetch 读取内容。
```

#### 🧪 测试：+16 项（`verify-download.js` 69 → 86）

新增 4 组回归，其中「菜单命令实际调用」是**补上这次的测试盲区**：

| 组 | 断言要点 |
|---|---|
| 菜单命令 | **实际调用** `fn()` 不抛异常 + 真的产出下载 |
| `__fivPack` 作用域 | `'all'` / `'group'` 两种模式均可用 |
| 全部失败 | 面板仍出现 + 说明「全部获取失败」+ 给出跨域提示 + 列出清单 |
| 部分失败 | 主文案同时含成功数与失败数 |
| 诊断入口 | `diagPack` 可执行、逐张返回、含 status/ok 字段 |

全套 **12 套件 / 330 项断言全绿**。

> **教训**：`typeof fn === 'function'` 这类断言只能证明「函数存在」，
> **证明不了「函数可用」**。凡是注册到全局/菜单的回调，测试必须**真正调用一次**
> 并检查其副作用 —— 作用域错误正是这样漏过去的。

---

### v1.6.1 — 缩略图条跟随修复

用户报告两个现象：**焦点缩略图跑到显示范围之外**、**缩略图数量与实际可浏览数不符**。
排查后发现是**同一个根因的两面**。

#### 🐛 根因：`show()` 只改高亮，从不滚动缩略图条

切图时 `show()` 调了 `updateStripCurrent()`（改高亮）和 `updateMinimap()`（改迷你进度条），
但**唯独没调 `scrollStripTo()`**。而 `scrollStripTo` 全代码只有两处调用：

| 位置 | 触发时机 |
|---|---|
| `renderStrip()` 末尾 | 打开浏览器 / 配置变更时重建缩略条 |
| `window.resize` 降级处理 | 拖动窗口大小 |

→ **正常翻图时根本不滚动**。高亮跑到了当前图，缩略条却留在原处，焦点直接跑出视野。

#### 🐛 第二个现象的成因：虚拟化窗口不跟随 index

图片数 > 120 时走虚拟化，只渲染 `computeVirtualWindow()` 算出的窗口。
这个函数依赖 `index`，但**只在 `renderStrip()` 时算一次** —— 翻图时不重算。

所以大批量场景下：滑到第 190 张，但条里渲染的还是旧窗口那一段，
**看起来就像「数量和实际对不上」**。

#### ✅ 修复

新增 `ensureThumbVisible()`，在 `show()` 里**先补渲染、再高亮、再滚动**：

```js
function ensureThumbVisible() {
  if (!track || !Config.get('thumbnailBar')) return;
  const i = index;
  let el = track.querySelector('.${NS}-thumb[data-i="' + i + '"]');
  if (!el) {
    // 情况 1：虚拟窗口没覆盖当前图 → 重算窗口并重渲染
    renderStrip();
    el = track.querySelector('.${NS}-thumb[data-i="' + i + '"]');
    if (!el) return;                       // 兜底：不阻断切图
    scrollStripTo(i, false);
    return;
  }
  // 情况 2：已渲染但不可见 → 滚过去
  const viewL = track.scrollLeft;
  const viewR = viewL + track.clientWidth;
  const left = el.offsetLeft, right = left + el.offsetWidth;
  if (left < viewL || right > viewR) scrollStripTo(i, false);
}
```

两个设计要点：

1. **只在真的不可见时才滚**。若当前图已在视野内则不动 —— 否则每翻一张都甩一下镜头。
2. **同时移除了 `renderStrip()` 末尾那次无条件 `scrollStripTo(index, true)`**。
   虚拟化下翻图会频繁重建缩略条，无条件滚动会导致镜头乱甩。现在滚动职责统一收敛到 `ensureThumbVisible()`。

#### 🧪 测试：新增 `verify-strip.js`（25 项）

全套 **12 套件 / 314 项断言全绿**。

> **测试踩坑记录（jsdom 布局模拟）**：这个 bug 测不出来，是因为 jsdom 的
> `offsetLeft` / `clientWidth` 恒为 0。补桩时连踩三层坑：
> 1. `offsetLeft` 是**实例级**可覆盖的，挂在 `Element.prototype` 上**无效**；
> 2. 但实例级桩会随 `renderStrip()` 的 `track.innerHTML=''` **一起被丢弃**
>    —— 虚拟化下每次翻图都重建全部 thumb；
> 3. 最终方案是**劫持 `document.createElement`**，让新建的 thumb 一出生就带上桩。
>
> 顺带修了一条**自己写错的断言**：`k*10` 在 k=20 时是 200，被 `clamp` 到 199，
> 期望值却写成 190。用探针打印每步的 `index/cur/rendered/scrollLeft` 才定位到。

---

### v1.6.0 — 批量打包下载

把 v1.5.0 时期那份「已评审未实现」的规划落地。**评审结论全部采纳**，包括那 3 处技术修正与 5 项遗漏补充。

#### 决策速览（本次拍板）

| 决策项 | 结论 | 理由 |
|---|---|---|
| 跨域方案 | **只用 `fetch`**，不加新权限 | 零元数据变更是硬约束；`GM_xmlhttpRequest` 降级留二期 |
| 下载范围 | 当前组 + 全部 | 「本组」是分组算法的天然验证器 |
| ZIP 方案 | **内置 STORE 写入器**（level:0） | 图片已压缩，再 deflate 只白耗 CPU 且可能变大；也避免引入第三方库 |
| 文件命名 | `001_原名.ext`，扩展名按 MIME 推断 | 序号保证唯一；URL 后缀不可信（`image.php?id=1` 会误判） |

#### 新增模块 `2.5 ImageDownloader`

严格遵守评审定下的契约：

- **单向依赖**：只接受 `items` **快照**（调用方 `slice()`），不持有 `ImagePool`，**不回写** `seenKeys` / `current` / `scope`。
- **并发取 + 顺序写**：4 路并发取 Blob，写入 ZIP 时严格按 `items` 原序。
- **失败清单**：拿不到的图如实列出原因（HTTP 状态 / 网络异常 / 非图片响应），**绝不静默跳过**。
- **取消语义**：`AbortController` 立即中断在途请求并丢弃，不产出半成品 ZIP。

ZIP 手写实现，两个关键细节：

1. **UTF-8 文件名标志位 bit 11（`0x0800`）必须置位** —— 否则中文名在部分 Windows 解压工具下乱码。
2. **固定 DOS 时间戳**（1980-01-01）—— 避免时区差异导致产物不可复现。

#### 评审遗漏项的落实

| 遗漏项 | 落实方式 |
|---|---|
| **1 · `<img>` 尺寸 vs 原图** | 用 `it.src`（池内记录、`pickSrc()` 已优先懒加载属性），**不用** `img.currentSrc` |
| **2 · 文件名冲突** | 三位序号 `001_` 前缀天然去重；同 URL 多节点各存一份（`dedupeByUrl` 默认关的既定设计） |
| **3 · 超时与失败清单** | 单张 20s 超时 + 失败清单（含精简地址与原因），面板内展示 |
| **4 · 取消语义** | 立即 Abort + 丢弃；**明确不写 `seenKeys`**，否则打包会被误判为「已浏览」污染缩略条 |
| **5 · 位图无法直取** | 走 `fetch`，用 `cache: 'force-cache'` 间接复用 `<img>` 已建立的 HTTP 缓存（**不当作设计前提**） |

补充的工程项：**Windows 保留名**（`CON`/`LPT1`…）、非法字符、**尾随空格与点**、前导点、**路径穿越**（`../`）、**单段长度上限**（120 字符，为中文 UTF-8 预留余量）。

#### UI 落点

| 入口 | 位置 | 说明 |
|---|---|---|
| 📦 打包按钮 | Viewer 工具条（下载按钮旁） | 全局浏览时降级为「全部」并 toast 说明 |
| `Shift+D` | 快捷键 | ⚠️ 必须在 `switch` 前拦截 —— 单独按 `D` 已被「下一张」占用 |
| 油猴菜单 ×2 | 「📦 打包下载全部」/「📦 打包下载当前组」 | 浏览层未打开也能用 |
| 进度面板 | 顶部居中 | 进度条 + 百分比 + 取消按钮 + 失败明细 |

#### 🧪 测试

新增 `verify-download.js`（**69 项断言**），全套 **11 套件 / 289 项断言全绿**。

其中一项设计值得记：**CRC-32 用 Node 内置 `zlib.crc32` 做独立基准校验**，而不是拿被测代码自己的实现验证自己（自己验自己必然通过）。同时解析产出的字节流，逐个校验本地头偏移、中央目录位置、UTF-8 文件名解码，确保 STORE 模式的 ZIP 真的能被解压工具打开。

另含一条**安全边界断言**：`@grant` 仍为 5 个、**未出现 `@connect`** —— 防止后续不小心加了权限。

---

### 重命名 — forum-image-viewer → web-image-viewer

脚本已从「论坛看图」收敛为「通用网页图片组浏览」，文件名与元信息同步对齐。

| 项 | 旧值 | 新值 |
|---|---|---|
| 文件名 | `forum-image-viewer.user.js` | `web-image-viewer.user.js` |
| `@name` | 论坛图片浏览器 | 网页图片浏览器 |
| `@name:en` | Forum Image Viewer | Web Image Viewer |
| `@namespace` | `local.forum.imageviewer` | `local.web.imageviewer` |
| `@version` | 1.5.1 | **1.5.1（不变）** |
| CHANGELOG 标题 | 论坛图片浏览器 | 网页图片浏览器 |

**同时更新的引用点**（重命名必须成对处理，否则测试会找不到脚本）：

- `.workbuddy/test/` 下 **12 个测试脚本**硬编码的脚本路径：`forum-image-viewer.user.js` → `web-image-viewer.user.js`
- `.workbuddy/GIT-SETUP.md`：4 处路径示例与描述

**验证**：重命名后重跑全套 10 个测试套件，**218 项断言全绿**，与重命名前一致（26+8+28+21+21+15+29+32+19+19）。

> 备注：`@version` 未 bump —— 此改动不涉及功能，仅是标识对齐；且脚本尚未通过 `@updateURL` 发布，无升级链需要考虑。
> 后续如要实现自动更新，应补 `@downloadURL` / `@updateURL` 指向 GitHub raw 地址。

---

### v1.5.2 — 缩略图点选修复（第二轮 · CSS 命中测试根因）（当前版本）

v1.5.1 声称修好了「点不动」，但**真机仍然点不动**。这轮找到了更隐蔽的第二根因。

#### 🐛 根因：`.fiv-dragging` 在 pointerdown 时就改变了命中测试

v1.5.1 只修了 `setPointerCapture`，漏了**同一现象的另一条独立成因**：

```js
// pointerdown 里 —— 无条件加类
strip.classList.add(NS + '-dragging');
```

```css
/* CSS 立即生效：缩略图不再接收指针 */
.fiv-strip.fiv-dragging .fiv-thumb { pointer-events: none; }
```

**真实浏览器的 click 时序**：

| 阶段 | `pointer-events` 状态 | 命中元素 |
|---|---|---|
| `pointerdown` 命中测试 | thumb 已是 `none` | **strip**（跳过 thumb） |
| `pointerup`（`finish()` 已移除 dragging） | 恢复 `auto` | **thumb** |
| `click` 派发 | — | target = 两次命中的**最近公共祖先** = **strip** |

→ click 落在 `strip`，缩略图自身的监听器**永远收不到** → 「还是点不动」。

**为什么 v1.5.1 的测试没抓到**：jsdom 不实现 CSS `pointer-events` 的命中测试，
也不计算「按下/松手命中的公共祖先」。测试里手工派发 `click` 到 thumb 就必然通过。

#### ✅ 修复

和第 2 根因一样，**推迟到越过拖动阈值再改状态**：

```js
// pointerdown：只记录起点，不加类、不捕获
down = true; moved = false; sx = e.clientX; sl = track.scrollLeft; pid = e.pointerId;

// pointermove：越过阈值那一刻，才同时做两件事
if (!moved && Math.abs(dx) > THRESHOLD) {
  moved = true;
  strip.classList.add(NS + '-dragging');          // 关掉缩略图指针响应（防 hover 抖动）
  try { strip.setPointerCapture(pid); } catch (err) {}  // 拖出条外仍持续滚动
}
```

**教训固化**：凡是会改变**命中测试**的状态（`pointer-events`、指针捕获），
都不能在 `pointerdown` 里设置 —— 必须等拖动意图确认。已在函数头注释里写明三次踩坑史。

#### 🧪 测试增强

`verify-batch5.js` 新增**模拟真实浏览器 click 目标解析**：

- `hitAt(target, dragging)` —— 按 `pointer-events` 决定命中元素
- `commonAncestor(a, b)` —— 计算按下命中 ∩ 松手命中的公共祖先
- 关键：**在 `pointerdown` 派发之后**才读取 dragging 状态（模拟处理器的副作用已生效）

新增 2 条断言，「纯点击缩略图能切图」在修复前实测**复现为红**（`click target = fiv-strip`）。
同时修正 1 条**固化 bug 的旧断言**：`'按下即进入拖拽态'` → `'按下时尚未进入拖拽态'`。

**全套 10 套件 → 220 项断言全绿**（batch5：32 → 34）。

---

### v1.5.1 — 缩略图点选修复 · 移除分组目录

第五批的**修正版**：修掉 v1.5.0 引入的回归，并按反馈撤掉体验不佳的分组目录。

#### 🐛 回归 Bug：缩略图能滚动但**点不动**

**根因（JS，且只能在真实浏览器复现）**：v1.5.0 重写 `bindStripDrag()` 时，
在 `pointerdown` 里**无条件**调用了 `strip.setPointerCapture(pid)`。
而指针捕获一旦生效，该指针后续的 `pointerup` **与 `click` 都会被重定向到捕获元素
`strip`**，不再落在缩略图 `<button>` 上 —— 于是缩略图绑的 `click` 监听器
**永远不会触发**，表现为「能拖能滚，但点哪张都不切图」。

jsdom 不实现指针捕获重定向，所以 v1.5.0 的测试**全绿却漏掉了这个 bug**。
必须先写一版「模拟真实浏览器捕获语义」的测试才能复现。

**修复**：把捕获推迟到**真正越过拖动阈值**时再做：

```js
// pointerdown：只记录起点，不捕获
down = true; moved = false; sx = e.clientX; sl = track.scrollLeft; pid = e.pointerId;

// pointermove：越过阈值后才捕获，保证拖出 strip 外仍能持续滚动
if (!moved && Math.abs(dx) > THRESHOLD) {
  moved = true;
  try { strip.setPointerCapture(pid); } catch (err) {}
}
```

同时删掉缩略图 `click` 上多余的 `if (dragMoved) return;` ——
拖动后产生的 click 已由 `finish()` 里的 swallow 监听器拦掉，
两套机制叠加反而互相干扰（`dragMoved` 本是给舞台平移用的）。

> 教训沉淀：**`setPointerCapture` 会给捕获元素「劫持」click**。
> 凡是「既要支持点击、又要支持拖动」的容器，
> 捕获**必须延迟到达成拖动意图之后**，绝不能在 pointerdown 就抢。

#### 🗑️ 移除：左侧分组树形目录

v1.5.0 引入的左侧树形目录经实际使用**体验不佳**，按要求整体移除：

| 移除项 | 说明 |
|---|---|
| CSS | `.fiv-tree*` / `.fiv-tgroup` / `.fiv-trow` / `.fiv-tnum` / `.fiv-tname` / `.fiv-tcount` / `.fiv-tcaret` / `.fiv-tkids` / `.fiv-tgrow` 等 118 行 |
| DOM | `-tree-tab` 拉手、`-tree` 侧栏、`-tree-head` / `-tree-body` |
| 逻辑 | `invalidateTree` / `buildTreeData` / `renderTree` / `syncTree` / `setTreeOpen` / `toggleTree` / `bindTree` / `currentGroupId` / `groupIdAt` / `jumpToGroupItem` / `enterGroup` 等 311 行 |
| 配置 | `treeDefaultOpen` |
| 快捷键 | `L`（`T` 保留，仍为「显示/隐藏缩略图条」） |
| 变量 | `--fiv-treew` |
| 图标 | `caret` / `layers` |
| 导出 | `Viewer.toggleTree / setTreeOpen / syncTree / rebuildTree / treeOpen` |
| 钩子 | `ImagePool.onChange → Viewer.rebuildTree()`；`Config.onChange → setTreeOpen()` |

**保留**的部分：`ImagePool.groups(minSize)` 枚举 API（`__fiv.groups()` 仍可用）、
**组间续览**（`navNext`/`navPrev` 跨组）、悬停角标「看这组」入口、`G` 键切组。
设置面板「分组浏览」区块只留 `groupChaining` 一项，说明文案改为引导使用悬停角标 + `G` 键。

> ⚠️ 拆除过程中的一次事故与恢复：首次按「注释块边界」整段删除时，
> 误把夹在其中的 **ThumbBar 实现**（`makeThumb` / `updateStripCurrent` /
> `scrollStripTo` / `updateMinimap` / `showPeek` / `hidePeek` / `markSeen`）
> 一并删掉了。由 `verify-batch4.js` 的迷你进度条与虚拟化断言**当场暴露**，
> 随后按 CSS 类名与调用点契约完整重建，并补回 `show()` 里遗漏的
> `updateMinimap()` 调用。全量回归后恢复全绿。
>
> 教训：**无版本控制时，按「注释块」整段删除是高风险操作** ——
> 删除前应先 grep 出该区间内**全部**函数定义，确认不含无关实现。

#### 测试

`verify-batch5.js` 调整：

- **删除** 树形目录面板交互 / 组数不足两段（功能已移除）；
- **保留** `groups()` 枚举断言（API 仍在）；
- **新增**「模拟真实浏览器指针捕获」的回归段（4 项）：
  纯点击按下时不捕获 / 纯点击能切图 / 拖动越阈值后才捕获 / 拖动后不误切图。

| 套件 | v1.5.0 | v1.5.1 | v1.5.2 |
|---|---|---|---|
| `verify-batch5.js` | 45 | 32 | **34** |
| 合计 | 231 | 218 | **220** |

---

### v1.5.0 — 悬停角标稳定性 · 缩略图条可拖动 · 分组树形目录

第五批：两个可靠性 bug 修复 + 一个体验增强（左侧树形目录 + 组间续览）。

#### 🐛 Bug 1：悬停角标「时有时无」——**两个独立根因**

定位过程用 jsdom 逐步复现，发现问题并非单点，而是**两个独立缺陷叠加**：

**根因 A —— 命中判定方向搞反（主要原因）**

旧 `hitImage()` 是**向上**遍历祖先找 `IMG`。但 `<img>` 不会嵌套 `<img>`，
所以永远找不到祖先图片；论坛常见结构 `<a class="zoom"><img></a>`，
鼠标稍移到 `<a>` 的 padding/首尾空隙上就判定失败 → 角标闪没。

修复：改为**向下**查找的 `imageIn()`：

```js
function imageIn(target) {
  if (target.tagName === 'IMG') return ImagePool.itemOf(target) ? target : null;
  let inner = null;
  for (const c of target.children) if (c.tagName === 'IMG') { inner = c; break; }
  if (!inner && target.querySelector) {
    const list = target.querySelectorAll('img');
    if (list.length === 1) inner = list[0];   // 包裹层内唯一图才认
  }
  return (inner && ImagePool.itemOf(inner)) ? inner : null;
}
const hitImage = imageIn;   // 保留旧名，避免改动调用点
```

**根因 B —— 内联 `display:none` 永久粘死（隐蔽、更致命）**

`hide(true)` 会写内联样式 `el.style.display = 'none'`，而内联优先级**高于类**。
`show()` 只加 `.fiv-on` 类、从不清理内联值 → 只要发生过**任何一次**即时隐藏
（鼠标移出文档、窗口失焦、滚动出视口、点击角标），角标此后**永久无法再显示**。

修复：`show()` 里先清内联值：

```js
if (el.style.display === 'none') el.style.display = '';
```

**根因 C —— pending 定时器未取消（第三个，测试暴露）**

鼠标移到图外会 `scheduleHide()` 挂一个 140ms 定时器；若在 140ms 内移回**同一张图**，
`onMove()` 会命中「同图且已显示」的提前 `return` 分支，**绕过 `show()`**，
于是那个隐藏定时器没被清掉，到点仍执行 → 表现为「移回后又自己消失」。

修复：在该分支内同样取消定时器：

```js
if (img === curImg && el && el.classList.contains(NS + '-on')) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  positionFor(img);
  return;
}
```

#### 🐛 Bug 2：底部缩略图条完全无法滑动

**根因（CSS，非 JS）**：`.fiv-track` 上写了 `scroll-behavior: smooth`。
拖动实现是每帧 `track.scrollLeft = sl - dx`，而 `smooth` 会把**每一次赋值**
都变成一段动画，动画之间互相打断 / 被浏览器合并，最终视觉上「纹丝不动」。
jsdom 里 JS 逻辑本身是正确的（scrollLeft 0→150），所以必须先怀疑 CSS。

同时旧 `bindStripDrag()` 在 target 是 `.fiv-thumb` 时直接 `return`
—— 而缩略图几乎铺满整条 strip，等于**大多数按下位置都不响应**。

修复：

| 项 | 修复 |
|---|---|
| CSS | `scroll-behavior: smooth` → **`auto`** |
| CSS | `.fiv-strip.fiv-dragging .fiv-thumb { pointer-events: none }` |
| CSS | `.fiv-strip.fiv-dragging { cursor: grabbing; user-select: none }` |
| JS | 重写为 **Pointer Events + `setPointerCapture`**，从任意位置（含缩略图上）起拖 |
| JS | 3px 拖动阈值，微动不算拖动 |
| JS | 拖动结束后吞掉随之而来的 `click`，避免误触缩略图 |

#### ✨ 新功能：左侧分组树形目录

- `ImagePool.groups(minSize)` —— 复用与分组判定**同源**的标准枚举分组，
  返回 `{ id, items, size, el, label, startIndex }`，
  保证「侧栏看到的组」与「浏览器翻到的组」**不可能不一致**。
- 浏览界面左侧新增可折叠树形目录：
  - 拉手按钮常驻；展开后按组列出，组头显示序号 + 标签 + 张数；
  - 当前所在组自动展开并高亮（`fiv-cur`）；
  - 单击组头 = 展开/收起；双击组头 = 进入该组浏览；
  - 点击组内某行 = 直接跳到该张图。
- `labelForGroup()` 生成人类可读标签（如「第 2 组 · 3 张」）。
- 组数 < 2 时不显示目录（`fiv-hastree` 不置位），避免噪音。
- 快捷键 **`L`** 展开/收起目录。
- `currentGroupId()` 增强：**未进入任何组**（全局浏览）时，
  也按当前下标落组高亮 —— 侧栏始终能指示「你现在在哪一组」。

#### ✨ 新功能：组间连续浏览（groupChaining）

- 新增 `navNext()` / `navPrev()`，**统一接管全部 5 处翻页入口**
  （上/下一张按钮、滚轮导航、方向键 ←/→），消除各自为政的旧逻辑。
- 组尾继续下一张 → 自动跨到**下一组**首张；组首再前一张 → 回到**上一组**末张。
- 越界时用 `edgeToast()` 给出轻提示，并用 `lastEdgeToastAt` 节流防刷屏。
- 配置项 `groupChaining`（默认 **开**）可关闭，关闭后行为退回「组内到底即止」。
- 顶栏「本组」标识随跨组同步更新。

#### 🔧 其他改动

- 新增配置项：`groupChaining: true`、`treeDefaultOpen: false`（「分组浏览」分组）。
- 设置面板新增「分组浏览」区块，含上述两个开关 + 快捷键表新增 `L` 与「组间切换」。
- `Config.onChange`：`treeDefaultOpen` 生效即时联动 `Viewer.setTreeOpen()`。
- `ImagePool.onChange` 现在会调用 `Viewer.rebuildTree()`，采集结果变化时目录同步刷新。
- Viewer 新增导出：`toggleTree / setTreeOpen / syncTree / rebuildTree / navNext / navPrev /
  gotoAdjacentGroup`，以及只读 `treeOpen` / `groupCount`。
- `window.__fiv.groups = () => ImagePool.groups(2)` 便于调试与测试。
- 新增图标 `caret`、`layers`。
- CSS 变量新增 `--fiv-treew: 228px`。

#### ⚠️ 断言变更（非回归）

`verify-group.js` 有 2 条断言编码的是 **v1.3.0 的「组尾即止」行为**，
与本次新特性「组间续览」直接冲突。已按新语义更新：

| 旧断言 | 新断言 |
|---|---|
| 「到 A3 已是本组末张，不越界到 B1」 | 「组尾再翻 → 续览到下一组 B1」 |
| 「当前位置保持为 A3」 | 「退出分组后停留在续览到的 B1」 |

这是**有意的行为变更**，不是回归。

#### 测试

新增 `verify-batch5.js`（45 项断言），覆盖：

- Bug1：停在包裹层 `<a>` 上角标已创建/已显示、交替 a/img 不闪、移出隐藏、
  10 帧微动稳定、**移出 140ms 内移回保持显示**；
- Bug2：缩略图上起拖能滚动、松手退出拖拽态、1px 微动不触发、
  滚轮横向滚动、CSS 断言（track 规则存在 / 未用 `smooth` / 显式 `auto` /
  拖拽时缩略图不抢指针）；
- 树形目录：`groups()` 枚举（组数 / 组大小 / 起始下标 / id 唯一 / label 非空）、
  面板交互（拉手 / `hastree` / 初始收起 / 点击展开 / `treeon` / 渲染组数 /
  计数文本 / 当前组自动展开 / 当前组高亮 / 组内图片行 / 点击展开 / 双击进入 /
  进入后高亮 / 关闭按钮 / 快捷键 `L` 双向）、组数不足时隐藏；
- 组间续览：进入首组 / 组内翻页 / 组尾跨组 / 组首回退 / 关闭续览不跨组 /
  退出分组 / 全局翻页。

> ⚠️ 测试断言细节：CSS 断言需**先剥注释**再匹配
> （`scroll-behavior` 的规则里注释解释了为何不用 `smooth`，直接正则会被注释内容误伤）。

---

### v1.4.0 — 增量扫描 · 虚拟缩略图 · 死代码清理

第四批：性能与工程债清理。核心是把「全页重扫」换成「增量扫描」，并给超多图场景补上虚拟化与全局定位。

#### 增量扫描（P1 性能）

- **新增 `scanNodes(nodes)`**：MutationObserver 回调只把 `addedNodes` 交给它，仅扫描新增子树，不再对全页 `querySelectorAll`。
  - **准入粒度在「注入的最顶层节点」**：只对顶层节点判一次 `isWithinCollectScope()`，其内部所有后代**继承结论**。此前逐个后代判「是否属于采集根」，会让深层 `img`（其父级本身不是根）被误杀。
  - 内部用 `Map<Element, Candidate>` 去重，避免重复候选。
- **MutationObserver 处理分流**：`addedNodes` → `scanAddedDebounced`（自定义 300ms 防抖，攒批处理）；`removedNodes` 与属性变化 → `markFullScanNeeded()`，等下次兜底扫描时统一 `pruneDetached()`。
- **兜底全量扫描频率 2500ms → 15000ms**：增量路径已能覆盖绝大多数动态加载，全量只作为「移除/属性变化」的兜底。
- **新增 `pruneDetached()`**：用 `el.isConnected` 清理已脱离文档的条目，修复长会话里「删楼后池内残留幽灵图」的问题。

#### 采集范围准入语义拆分（P0 正确性）

一次重要修正 —— **「上界」和「准入」是两件不同的事，必须用两个函数**：

| 函数 | 语义 | 使用场景 |
|---|---|---|
| `withinAnyRoot(el)` | 元素是否落在**某采集根之内** | 分组遍历的**上界**（爬到框架外就停） |
| `isWithinCollectScope(el)` | 新增节点是否属于**内容区** | 增量扫描的**准入判定** |

早前用单一函数同时承担两种语义，直接后果是：新注入的兄弟楼层（它本身就是新采集根，不在旧 `rootsCache` 里）被「是否被旧根包含」误杀，`verify.js` 的「新加载图片被自动纳入」从 4 退回 3。

`isWithinCollectScope()` 最终判据（任一满足即准入）：

1. **落在某个采集根之内 / 是某个根的祖先** → 准入；
2. **被 ≥2 个采集根共同覆盖** → **拒绝**（说明它与这些根同处 `body` 这类公共外壳，是侧边栏/广告栏的典型特征）；
3. **自身命中 `AUTO_CONTENT_SELECTORS`** → 准入（如新追加的一个 `.message` 楼层）；
4. **自身与某个根同级、且自身具备图集/内容框架语义**（`looksLikeContentContainer`）→ 准入。

> ⚠️ **退化根特判**：当 `rootsCache` 退化为单个 `[document.body]`（内容容器识别失败，或图片总数 < 3 走了 `cnt >= 3` 的兜底分支）时，「在采集范围内」对任何 `body` 子树恒为真。此时**不能**用判据 1，改为只认语义（判据 3/4）。否则 2 张图的页面里，任何 `body` 下新增的侧边栏都会被无差别放行 —— 这正是 `verify-batch4.js`「准入过滤」用例暴露的问题。

#### 虚拟缩略图 + 全局迷你进度条（P1 性能）

- 缩略图超过 **120 张**时只渲染可视窗口内的节点（虚拟化），避免超长图集下一次性创建上千个 `<img>`。
- 新增 `.fiv-minimap` 迷你进度条：虚拟化后缩略条不再表达全局位置，用一条 4px 的全局进度条（填充 + 游标）补回「我在整个图集的哪个位置」。由 `updateMinimap()` 在 `updateStripCurrent()` / `renderStrip()` 中同步。

#### 配置项补齐（P1 一致性）

- 新增 `whitelistOnly`（开关）与 `whitelist`（多行文本域）配置的**设置面板入口** —— 此前这两个 key 存在于 `ConfigStore` 但无 UI，用户只能改代码。
- 新增 `syncScrollBehavior`（`smooth` / `instant`）下拉，控制页面联动滚动的行为。
- 新增 `textareaRow()` 渲染器；`collect()` 支持 `data-array="1"` 的文本域，按 `[\n,]` 切分、去重后写入。

#### 死代码清理（P1 工程债）

- 删除 `throttle()`（无引用，实际用 `debounce`）。
- 删除 `naturalScale`、`stripOffset` 两个变量及 `scrollStripTo` 中对 `stripOffset` 的引用。
- 删除 `btnSettings`、`btnHideStrip`（保留仍在用的 `btnPlay`）。
- 删除 `boot()` 里空操作的灯箱监听（真实防护已由 `Viewer.bindLightboxGuard()` 承担），替换为说明注释。

### v1.3.0 — 分组算法收敛

针对第三方评审（ChatGPT）提出的「`bestHint` 跨越 `best` 导致跨图集误合并」，以及第一批遗留的 `isHintContainer` 不可达等问题做集中修复。

#### 分组算法重写（P0 功能正确性）

- **删除 `bestHint` 覆盖 `best` 的优先级规则**。
  旧逻辑：任何命中 `GROUP_HINT_SELECTORS` 的祖先，只要含 ≥2 张图，就无条件压过「最近祖先」，导致：
  ```
  post
  ├── gallery A (A1,A2)
  └── gallery B (B1,B2)
  点 A1 → 旧逻辑返回 post（4 张），应为 gallery A（2 张）
  ```
  新逻辑：**最近祖先 `best` 是默认答案，永不被跨越**；hint 只在 `best` 本身就是 hint、或其内只含 1 张图时，才向外提供「语义边界」。
- **新增候选双向收敛**：`best` 向上收集，`outer` 向下收集最外层仍非全页的祖先，取**最紧**的那个作为最终组。隔离的 hint 祖先再也不能反向吞并兄弟容器。
- **`GROUP_HINT_SELECTORS` 降级为「语义边界提示」而非「扩大范围的依据」**，并拆分为两类：
  - `GROUP_SEMANTIC_SELECTORS`（`gallery`/`album`/`photo-list`/`swiper`/`carousel`/`lightbox` 等真实图集语义）；
  - `CONTENT_ROOT_SELECTORS`（`article`/`section`/`li`/`figure`/`.message`/`.t_f` 等**内容框架**语义，与采集范围同源）。
  判据由「命中即是组」改为「**且确实是最近祖先**才认组」。
- **修复 `isHintContainer` 不可达**：旧代码只在 `if (n >= 2)` 分支内判定 hint，单图容器永远不会被识别为语义边界；现在独立判定，不再受图片数量分支限制。
- **移除 `figure` 作为分组边界**（保留在内容框架选择器内）：`<figure>` 常与 `<figcaption>` 一对一，天然只含 1 张图，作边界无意义。

#### 采集框架 → 分组边界打通（P1 架构一致性）

- `collectRoots()` 解析出的**采集根节点缓存为 `rootsCache`**，作为分组的**最高边界**：任何分组结果都不会跨越采集根，修复了「用户已用 `includeSelector` 划出两个独立内容块，却被外层 `article` 重新合并」的问题。
- `includeSelector` 与自动识别容器现在同时扮演两个角色：**采集范围 + 分组边界**，两个模型不再彼此独立。

#### 背景图断链修复（P1 功能正确性）

- **不再用 `fake` 对象冒充 `items[].el`**。背景图直接存入**真实 DOM 元素**，并新增 `isBg` 标记与 `byEl` Map 索引。
- 修复后，背景图可以正常参与 `groupOf()` / `itemOf()` / `scope.el.contains()` 判定，不再是从分组体系里断裂的节点。
- `poolItemsWithin()` 改用 `byEl` 索引 + `contains` 双通道匹配，顺带把分组解析从 O(n·depth) 降到接近 O(n)。

#### 性能与正确性（第一批遗留）

- **`scanNow()` 阶段 2 消除 O(n²)**：原 `merged.map()` 里对每个元素做 `imgCands.find() || bgCands.find()` 线性查找，改为 `Map<Element, Candidate>` 一次建索引、O(1) 回查。
- **新增 `dedupeByUrl` 配置（默认关闭）**：旧行为是「同一 URL 全局只收一张」，会导致同一图片出现在两个帖子时第二张丢失、进而使该帖分组失败。现在默认**按 DOM 节点收集**（多节点同 URL 视为多个条目），需要旧行为时可手动开启去重。
- **`show()` 增加 render token**：快速滚轮切图时，上一张的 `load` 回调不再污染新图的布局与计数器。

#### 设置面板

- 新增开关 `dedupeByUrl`（「按 URL 去重」）。
- 采集范围类字段（`includeSelector`/`excludeSelector`/`minWidth`/`minHeight`/`strictFilter`/`dedupeByUrl`）改动后**自动重建图片池**，不再需要手动刷新页面。

#### 测试

- 新增 `.workbuddy/test/verify-group-v2.js`（**19 项**，每场景独立建页）：覆盖并列 gallery 不合并、内容块被外层 article 包裹、嵌套 gallery 取最紧层、背景图真实节点入池并参与分组、孤立单图不吞并、同 URL 双节点各自成组。
- **全部 8 套件回归：26 + 28 + 8 + 21 + 19 + 15 + 21 + 19 = 157 项断言，失败 0。**

#### 实现中踩到的两个坑（记录备用）

1. **`n < total` 这个守卫本身是个坑**。为区分「恰好覆盖全池」与「真正的页面级容器」，一度把守卫从 `n >= 2 && n < total` 改成 `n >= 2`，结果 `verify-group.js` 里 `.thread`（装下全部 6 张）被认成组，孤立图不再回退。
   → 最终判据改为**两段式**：先按 `n >= 2` 收集，决议后再用 `isPageLevelRoot() || spansSiblingUnits()` 判断"是否只是公共外壳"。`spansSiblingUnits`（容器直接子级中含图兄弟 ≥2）正是区分 `.thread`（横跨多楼层）与 `.floorBg`（单个内容单元内 1 img + 1 背景图）的关键。
2. **`groupOf()` 的返回结构不含 `el`**（只有 `items/size/total/reason/isWholePage`）。写测试时若断言 `g.el.id` 会永远 undefined，误判为算法失败。测试一律基于 `items` 内容与 `size`。

---

### v1.2.1 — 安全加固与语义修正

按第三方评审核实结论，只做优先级最高的 4 项。

| # | 项 | 改动 |
|---|---|---|
| 1 | **URL 安全边界** | 新增 `isSafeImageSrc()`（宽松：管"能否当图看"）与 `isSafeExternalUrl()`（严格：仅 http/https）。接入 `pickSrc()` 及三个外部动作出口（下载 / 新标签打开 / 预览面板按钮），被拦截时给出 toast 而非静默失败。 |
| 2 | **Observer 不再监听 `style`** | `attributeFilter` 移除 `'style'`。悬停角标每次移动都改 `img.style`，原配置会触发全页重扫，形成**自触发扫描**。本批最该先修项。 |
| 3 | **`rejected` 集合语义** | 原代码只 `has`/`delete`、从不 `add`，防重复计算形同虚设。新增 `judge.isPermanent()` 区分**永久拒绝**（排除区/头像表情区/文本黑名单）与**动态拒绝**（尺寸不足，懒加载后会变，不缓存）。 |
| 4 | **白名单空名单语义** | `whitelistOnly=true` 且名单为空时，由 `return true` 改为 **`return false`**，与"仅在这些站点启用"语义对齐。 |

附带：新增 `const VERSION`，与头部 `@version` 对齐并挂到 `window.__fiv.version`。

### v1.2.0 — 图片悬停角标

- 新增 `HoverBadge` 模块：鼠标移到内容图上时，角落浮出半透明胶囊按钮「看这组 · N」，点击进入该组浏览。
- **关键取舍：单例浮动按钮，而非给每张图注入节点。** 理由：不污染站点 DOM、不触发重排（论坛页面动辄数百张图）、动态新图天然适用。
- 命中判定复用 `ImagePool.itemOf()`，头像/表情/小图不会冒角标。
- 配置项：`hoverBadge` / `hoverBadgeOpacity` / `hoverBadgeCorner` / `hoverBadgeGroupOnly`。

### v1.1.0 — 以图定域（图片分组）

- 新增 `resolveGroup()` / `groupOf()`：从被点击的图片反推其所属图片组。
- `Viewer` 引入 `scope` 概念：`null` = 全局浏览，`{el, keys, label}` = 组内浏览。
- 顶栏新增「本组 · N 张」标识；`Esc` 首次退出分组、再次关闭；`G` 键切换组/全局。
- 组从 DOM 移除或失效时自动回退全局，避免卡在空组。

### v1.0.2 — 设置面板可读性修复

- **根因**：主题变量被拆在两处，完整变量集只写入**懒加载**的浏览层根节点。先开设置面板（`Shift+/`）时无任何颜色变量 → 背景透明、文字不可读、点击穿透。
- **修复**：抽出 `themeVars(theme)` 作为唯一真源；`applyRootTheme()` 在启动时就把**完整变量集**写入 `:root` 的 `<style id=fiv-theme-vars>`；并给所有样式补 CSS 兜底值（`var(--fiv-panelbg, #ffffff)`），另加 `html[data-fiv-theme="dark"]` 兜底规则。

### v1.0.1 / v1.0.0 — 基础能力

- 图片池采集、过滤（尺寸、头像表情区、文本黑名单、用户排除区）。
- 浏览层：滚轮翻图、缩放平移、适应屏幕、缩略图进度条、快捷键、下载/复制链接/打开原图。
- 页面联动：跟随滚动、浏览时压暗。
- 动态增量：`MutationObserver` + 兜底定时扫描。
- **历史 bug 修复**：采集顺序必须「跨全部 root 汇总候选 → 按文档顺序排序 → 统一落池」。曾经的「逐个 root 边查边 add」会按「root × 类型」分组，出现 1 楼的图排到 3 楼之后。

---

## 核心设计决策

### 1. 采集范围与分组边界必须同源

**问题**：v1.1 中 `collectRoots()`（决定"哪些图进池"）与 `groupOf()`（决定"哪些图同组"）是两套独立模型。用户用 `includeSelector` 明确划出的两个内容块，会被外层 `article` 重新合并。

**决策**：采集根 = 分组最高边界。任何时候分组都不会跨越采集根。

### 2. 最近祖先优先，语义提示不越权

**问题**：`bestHint` 无条件压过 `best`，只要祖先带 `post`/`section`/`li` 等泛化类名就可能扩大分组。

**决策**：最近祖先（含 ≥2 张图）是**默认答案，永不被跨越**。hint 只在两种情况下介入：

1. `best` 自身就是语义容器 → 采用（本就是同一层）；
2. `best` 内只有 1 张图 → 向外借显式图集语义作边界。

**为什么**：继续往 `GROUP_HINT_SELECTORS` 里塞站点特征，只会让误合并更严重。问题不在"识别得不够多"，而在**容器层级之间的优先级关系没有定义清楚**。

### 3. 悬停角标用单例而非逐图注入

**决策**：`<html>` 下挂一个 `.fiv-badge`，`mousemove` 时做命中判定并移动定位。

**代价**：需要处理"鼠标从图移向按钮途中闪没"——用 140ms `scheduleHide` 延迟取消解决。

### 4. 拒绝缓存只存确定性结论

**决策**：只有区域类/黑名单类拒绝写入 `rejected`；尺寸类拒绝每次重新判定。

**理由**：懒加载图初始 `naturalWidth=0`，或小图被站点放大后可能达标。若一并缓存，会永久漏掉。重新判定的成本极低（就是两次属性读取）。

### 5. 「采集上界」与「准入判定」必须是两个函数

**决策**：`withinAnyRoot()`（上界）与 `isWithinCollectScope()`（准入）分开实现，不复用。

**理由**：两者问的是不同的问题——

- 上界问：「从这个元素往上爬，什么时候已经爬出内容框架了？」→ 用旧根包含关系。
- 准入问：「这个**新注入**的节点，算不算内容区？」→ 新节点往往本身就是新根，不在旧 `rootsCache` 里。

用同一个函数，增量扫描必然误杀新楼层。这个坑在 v1.3→v1.4 期间被 `verify.js` 抓到（新图纳入数从 4 退回 3）。

### 6. 增量准入按「注入的顶层节点」判定，后代继承结论

**决策**：`scanNodes()` 只对传入的顶层节点调一次 `isWithinCollectScope()`，其内部全部后代直接纳入。

**理由**：逐后代判定时，深层 `img` 的父级往往不是采集根，会被判为「范围外」而误杀。准入是一个「整块内容区进来/不进来」的决策，粒度应在容器层。

---

## 图片分组算法（以图定域）

### 输入

- 用户触发点：某个 DOM 元素（`<img>` 或背景图容器）
- 图片池：`items[]`（按文档顺序），`byEl: Map<Element, item>` 索引
- 采集根：`rootsCache: Element[]`

### 算法

```
resolveGroup(el):
  1. 从 el 向上逐级遍历祖先（含自身，兼容背景图容器）
  2. best =  第一个「含 ≥2 张已入池图片」的祖先       ← 最近祖先
     outer = 最外层仍「含 < 全部图片」的祖先          ← 收敛上界
  3. 双向收敛：
       候选 = (outer 存在且外层图片数 < best 图片数) ? outer : best
  4. 语义提示（不越权）：
       · best 自身是语义容器     → 采用 best
       · best 内仅 1 张图        → 向外借最近语义容器作边界
  5. 边界约束：任何结果不得跨越采集根（rootsCache）
  6. 兜底：结果 == 全页图片数 → 返回 null（调用方回退全局浏览）
```

### 判据表

| 情形 | 结果 | 说明 |
|---|---|---|
| 单张孤立图，最近同伴是全页 | `null` | 回退全局浏览 |
| 页面上只有 1 张图 | `null` | 池数 < 2，直接返回 |
| 点击图在无 hint 的普通容器内，含 2 张 | 该容器 | 最近祖先机制 |
| 两个 gallery 并列在同一 post 内 | **各自的 gallery** | 修复了旧版合并成 post 的问题 |
| `.post-content` × 2 被外层 `article` 包裹 | **各自的 `.post-content`** | 采集根边界生效 |
| 背景图（CSS 贴图） | 与普通图同等参与 | 真实 DOM 元素入池，无断链 |
| gallery 内嵌套 gallery | 取更紧的那层 | 双向收敛取最紧 |

### 已识别但**不**作为分组边界的元素

`figure`（常与 `<figcaption>` 一对一，只含 1 张图）、`div`/`span` 等无语义容器。

### 语义选择器清单

**真实图集语义**（`GROUP_SEMANTIC_SELECTORS`）：
```
[class*="gallery"] [id*="gallery"]
[class*="image-list"] [class*="img-list"] [class*="imagelist"]
[class*="album"] [id*="album"]
[class*="photo-list"] [class*="pic-list"] [class*="pics"]
[class*="swiper"] [class*="carousel"] [class*="slider"]
[class*="lightbox"] [class*="pswp"] [class*="photoset"]
```

**内容框架语义**（`CONTENT_ROOT_SELECTORS`，与采集范围同源）：
```
[class*="post"] [class*="floor"] [class*="reply"]
.message .postmessage .t_f .pcb
article section li
```

---

## 分组修复补丁清单

v1.3.0 针对分组逻辑的完整补丁清单。**每一条都已落地并纳入测试**，标注位置便于日后回溯。

### P0 · 功能正确性

| # | 缺陷 | 位置 | 补丁 | 验证 |
|---|---|---|---|---|
| 1 | `bestHint` 可跨越 `best`，把同一 post 下多个 gallery 合并成一个 | `resolveGroup()` 决议段 | 删除 `bestHint && ... ? bestHint : best`；改为 `pick = best`，只允许向内收紧 | verify-group-v2 场景1/2 |
| 2 | 泛化选择器（`article`/`section`/`li`/`figure`）作 hint 时主动扩大池 | `GROUP_HINT_SELECTORS` | 拆为 `GROUP_SEMANTIC_SELECTORS` + `CONTENT_ROOT_SELECTORS`；判据改为「**且确实是最近祖先**才认组」；`figure` 移出边界集 | verify-group-v2 场景2/3 |
| 3 | `isHintContainer` 不可达——只在 `n >= 2` 分支内判定，单图容器永远识别不了 | 旧 `isHintContainer` | 移除该函数，改用独立的 `isSemanticGroup()` / `isContentRoot()`，不受图片数量分支限制 | 由 #2 的测试覆盖 |
| 4 | `n === total` 被一律当成「页面级容器」，导致小页面（全部图片本属同一层楼）无法成组 | `resolveGroup()` 兜底 | 两段式判据：`isPageLevelRoot(pick.el) \|\| spansSiblingUnits(pick.el)` 才算无局部组 | verify-group 孤立图 + verify-group-v2 背景图 |

### P1 · 架构一致性与断链

| # | 缺陷 | 位置 | 补丁 | 验证 |
|---|---|---|---|---|
| 5 | 采集框架（`collectRoots`）与分组框架（`groupOf`）是两套独立模型，`includeSelector` 划出的内容块被外层 `article` 合并 | `resolveGroup()` 遍历边界 | 采集根缓存为 `rootsCache`，成为分组**上界**（`withinAnyRoot()` 越界即停） | verify-group-v2 场景2 |
| 6 | 背景图用 `fake` 对象冒充 `items[].el`，`contains()` 永远 false → 分组体系里的断链节点 | `scanNow()` 阶段3 | 直接存**真实 DOM 元素** + `__fivBg` 标记 + `isBg` 字段；尺寸改用 `getBoundingClientRect()` 走 `judgeBg()`/`addBg()` | verify-group-v2 背景图段 |
| 7 | 全局按 URL 去重，同一图片出现在两个帖子时第二张被吞 → 该帖分组失败 | `add()` | 新增 `dedupeByUrl` 配置（**默认关闭**）；默认按 DOM 节点收集，同一 URL 多节点可共存 | verify-group-v2 场景6 |

### P1 · 性能与并发

| # | 缺陷 | 位置 | 补丁 |
|---|---|---|---|
| 8 | `scanNow()` 阶段2 用 `find()` 重映射候选 → O(n²) | `scanNow()` | `Map<Element, Candidate>` 一次建档、O(1) 回查 |
| 9 | `poolItemsWithin()` 每组都 `items.filter(items.find)` → O(n·depth) | `poolItemsWithin()` | 改用 `byEl` Map 索引遍历 |
| 10 | 快速滚轮切图时，上一张的 `load` 回调污染新图布局与计数器 | `show()` | 引入 `renderToken`，回调先校验令牌，不匹配即丢弃 |
| 11 | 改过滤配置后不重建图片池，需手动刷新页面 | `Settings.applyAfterChange()` | 新增 `RANGE_FIELDS` + `lastSaved` 快照比对，命中即 `reset()` + `scanNow()` |

### 明确**不采纳**的评审建议

| 建议 | 不采纳理由 |
|---|---|
| 「继续往 `GROUP_HINT_SELECTORS` 里加站点特征」 | 当前问题不是「识别得不够多」，而是**容器层级之间的优先级关系没定义清楚**。继续加选择器只会让误合并更严重——所以 v1.3 反而**收敛**了选择器（拆成两类 + 移除 `figure`）。 |

---

## 计划中功能：批量打包下载

> **状态：✅ 已于 v1.6.0 实现。** 本节保留为**评审记录**——下面每一条「修正 / 否决 / 遗漏」都已在实现中落实，
> 便于日后回看「为什么是这样设计的」。实现细节见 [v1.6.0](#v160--批量打包下载当前版本)。
>
> 二期候选（本次明确未做）：`GM_xmlhttpRequest` 跨域降级、超阈值分卷 ZIP。

### 总体结论

**可行，方向正确，架构建议采纳。** 规划对「有 `<img>` ≠ 有二进制数据」这一点抓得很准，也正确识别了 CORS 与内存是真正的风险点，而不是 ZIP 算法本身。

但有 **3 处技术判断需要在实现前修正**，另有 **5 项规划完全没提的遗漏**。其中两项如果不处理，功能在论坛场景下会「看起来能用，实际上大部分图片下载失败」。

### 一、采纳的部分

| # | 规划观点 | 采纳理由 |
|---|---|---|
| 1 | 独立 `ImageDownloader` 模块，只单向依赖 `ImagePool.items` | 与现有模块边界一致。**关键是切断反向依赖**：下载不得回写图片池、不得改 `current()`、不得复用 `Viewer.scope` 的可变状态 |
| 2 | 不在浏览时预取 Blob，用户点击时才取 | 论坛帖子几百张图，预取会把 HTTP 缓存和带宽一起打爆。浏览器已经因 `<img>` 加载建立了 HTTP 缓存与解码位图，重取通常在缓存命中 |
| 3 | 不自己实现 ZIP，用成熟库 | 正确。ZIP（尤其 ZIP64、UTF-8 文件名标志位、data descriptor）自研兼容性坑极多 |
| 4 | 文件名需要单独设计，URL 常常没有扩展名 | 正确且重要。现有 `guessName()`（第 112 行）只取 `pathname` 最后一段，对 `image.php?id=12345` 会返回 `image.php`，**扩展名与真实格式不符** |
| 5 | ZIP 内保留图片池顺序，下载可并发、写入必须按序 | 正确。实现上应当「并发取 Blob + 按 `items` 顺序写入」，而不是 `Promise.all` 后按完成顺序写 |
| 6 | 首版只做「下载当前组」，并预留「下载全部」 | 符合现有 `groupOf()` / `scope` 模型。**且规划最后那段判断极有价值**：下载当前组是分组算法的天然验证器——若把隔壁楼层一并打包，分组边界错误立刻暴露 |
| 7 | 必须限制 URL 只允许 `http:`/`https:`，且来源必须是池内条目 | 与现有 `isSafeExternalUrl()` 的安全模型完全一致，属必须项 |

### 二、需要修正的技术判断（实现前必改）

#### 修正 1 · `GM_xmlhttpRequest` 不是「跨域兜底」，而是必须前置评估的能力

规划把 `GM_xmlhttpRequest()` 当作「跨域时再用的 fallback」。这个判断过于乐观，原因：

- 该请求是**扩展进程发起**，**不携带页面 Cookie、Referer，也不读页面 HTTP 缓存**。对需要登录态、防盗链校验、或缓存已命中的图片，它既可能失败，又可能白白产生一次真实网络流量。
- 因此正确优先级是：**先 `fetch()`（同源 + 缓存 + 凭据都对）→ 失败且判定为 CORS 类错误时，才降级到 `GM_xmlhttpRequest`**，并且要在 UI 上说明「降级获取可能无登录态，部分图片会失败」。

#### 修正 2 · Tampermonkey 有更合适的原生能力，规划完全没提

| 能力 | 为什么更适合 | 关键差异 |
|---|---|---|
| `GM_download()` | 官方下载 API，自带跨域、可指定 `name`、可带 `onprogress` | **经浏览器下载器落盘，不经内存** —— 大批量场景内存压力远小于手搓 ZIP |
| `GM_xmlhttpRequest({ responseType: 'blob' })` | 现成的二进制获取通道 | 需要同时补 `@connect` 声明 |
| `GM_registerMenuCommand()` | 已在用，可挂「打包下载当前组」入口 | 零 UI 成本 |

> ⚠️ **元数据缺口**：当前脚本只 `@grant` 了 `GM_setValue/getValue/deleteValue/addStyle/registerMenuCommand`（第 9–13 行），**没有任何下载或跨域相关权限**。若采纳本功能，必须新增：
> ```
> // @grant        GM_xmlhttpRequest
> // @connect      *
> ```
> 其中 `@connect *` 在部分油猴实现（尤其 Firefox / Violentmonkey）下会触发用户授权提示，`*` 是否可接受需要先决策。**这是本功能唯一的元数据层变更，属于「一次改不可逆」的决策**：权限一旦加上，向用户解释成本即产生。

#### 修正 3 · 压缩策略需要显式决策，规划含糊

规划只提到「用 `fflate` 流式 API」，但没回答**用什么压缩级别**。图片（JPEG/PNG/WebP）本身已是压缩格式，再 deflate：

- `level: 0`（仅打包，不压缩）→ **CPU 几乎为零，体积约等于原图总和**。对图片集是**最优解**。
- `level: 6`（默认）→ 对已压缩数据几乎无收益，却可能带来数十秒 CPU 占用，且**可能反而增大体积**（已压缩流 deflate 后略膨胀）。

**结论**：图片类 ZIP 应固定 `level: 0`（或仅对文件名表压缩）。规划需要补上这一决策，否则实现者很可能默认 `level: 6`，用户会看到「打包 100 张图卡住半分钟，ZIP 还比原图大」。

### 三、明确**否决 / 需重新设计**的部分

| 规划内容 | 否决理由 | 替代方案 |
|---|---|---|
| 「ZIP 内部数据 + 最终 ZIP Blob 同时驻留内存，用流式 API 缓解」 | 只要产物是「一个 ZIP Blob」，浏览器就必须把完整 ZIP 放在内存里 —— **流式 API 减少的是中间副本，不是最终产物**。`200 × 5MB = 1GB` 的场景下这一点不会因为流式而消失 | 分批 + **分卷 ZIP**（每 N 张一个 zip 文件），或超阈值时改用 `GM_download` 逐张/分卷落盘。规划需要把「内存上限」变成显式决策，而非用「流式」一句话带过 |
| 「点击 ZIP 时 `fetch()` 就很可能走 HTTP 缓存」 | 结论对，但**前提未写全**：图片响应必须带 `Cache-Control`/`ETag` 才可能命中；且 `fetch()` 默认 **`credentials: 'same-origin'`**，跨域图片若未配 `Access-Control-Allow-Credentials` 会拿不到内容。缓存命中率在论坛 CDN 场景下**通常不高** | 规划应把「缓存命中是锦上添花，不是设计前提」写清楚，失败路径必须完整可用 |

### 四、规划遗漏的 5 项（实现前需补设计）

| # | 遗漏项 | 为什么必须补 |
|---|---|---|
| 1 | **`<img>` 尺寸 vs 原图尺寸不一致** | 这是最容易出错、规划一个字没提的点。论坛缩略图/懒加载图常把 `src` 指向小图、`data-original` 指向原图。用户点「打包下载」期待得到**看到的那些图**。需明确：下载用 `it.src`（池内记录的真实地址，已过 `pickSrc()` 的懒加载属性优先），**而不是** `img.currentSrc`——后者可能是被站点替换过的低分辨率版本 |
| 2 | **重复内容与文件名冲突** | 同一 URL 多节点共存（`dedupeByUrl` 默认关闭）是**已确立的设计**。打包时同 URL 会产出 N 个相同文件；不同 URL 又可能 `guessName` 出同名。必须有「名称去重编号 + 可选 URL 去重开关」策略 |
| 3 | **超时与失败清单** | 单张图可能挂起。需 `AbortController` + 超时，并产出**失败清单**（哪几张没拿到），而不是静默跳过。否则用户拿到「24 张里只有 21 张」的 ZIP 且不知原因 |
| 4 | **进度与取消的取消语义** | 规划画了「取消」按钮，但未定义取消时机：是立即中断、还是「已取到的仍然打包」？建议**立即 Abort 全部在途请求并丢弃**，并明确「下载功能不写图片池 `seenKeys`」——否则打包会被误判为「已浏览」，污染缩略条状态 |
| 5 | **`<img>` 已 `decode()` 的位图无法直接取用** | 规划假设「用已加载的 `<img>` 可以省一次请求」。实际上**无法从 `<img>` 元素直接读出 Blob**（除非同源 + `drawImage` 到 canvas，但这受跨域污染限制）。所以「利用已加载的 `<img>`」在多数情况下**不成立**，只能依赖 HTTP 缓存间接复用。这一点需要写清楚，避免实现时走弯路 |

**另需补充的两条工程项：**

- **文件名清洗**：规划的字符黑名单 `/ \ : * ? " < > |` 需补 **Windows 保留名**（`CON`/`PRN`/`AUX`/`NUL`/`COM1`–`COM9`/`LPT1`–`LPT9`）、**尾随空格与点**、**长度上限**（单段 255 字节，注意中文按 UTF-8 是 3 字节/字），以及**路径穿越**（`..`）。
- **ZIP 文件名编码**：非 ASCII 文件名需置 UTF-8 标志位（bit 11）。部分 Windows 解压工具对未置位的 ZIP 会乱码。选库时需确认该行为，而非默认「库会处理」。

### 五、建议的实现契约（评审产出）

```
ImageDownloader（独立模块，单向依赖 ImagePool.items）
├─ getBlob(item)            // ① memory cache → ② fetch → ③ GM_xmlhttpRequest 降级
│                           //    仅接受 http:/https:（复用 isSafeExternalUrl）
├─ makeFilename(item, idx)  // 池内 name → 清洗 → 去重编号 → 兜底 image-001.ext
│                           //    扩展名优先由 MIME 推断，不信任 URL 后缀
├─ packZip(items, opts)     // 并发取 Blob（限流 N）+ 按 items 顺序写入 + level:0
│                           //    超阈值分卷；产出失败清单
├─ 进度/取消                // onProgress(done,total,bytes) / AbortController
└─ 不写池状态               // 严禁回写 seenKeys / current / scope
```

**UI 落点**（复用现有结构，零新增交互模式）：

| 入口 | 位置 |
|---|---|
| 「📦 打包下载当前组」 | Viewer 工具条（第 1899–1905 行按钮区），仅在 `Viewer.inGroup` 为真时可用 |
| 「📦 打包下载全部」 | 悬浮按钮菜单 / `GM_registerMenuCommand` |
| 进度与取消 | 复用 `Viewer` 的 toast + 一个可取消的进度条 |

### 六、评审结论

| 维度 | 评价 |
|---|---|
| **可行性** | ✅ 高。核心链路（取 Blob → 打包 → 触发下载）均属浏览器标准能力，无技术死点 |
| **完整性** | ⚠️ 中。架构骨架正确，但**压缩级别、内存上限、失败清单、文件名冲突、原图/缩略图区分**五项关键决策缺失 |
| **主要风险** | 🔴 **CORS / 登录态**（修正 1、2）→ 决定功能「可用率」；🟠 **大批量内存**（否决项）→ 决定功能「能否跑完」 |
| **采纳建议** | 采纳架构，按修正 1–3 调整，补足遗漏 1–5 后再进入实现 |
| **分期建议** | 一期只做「当前组 + `fetch` 优先 + `level:0` + 失败清单」；`GM_xmlhttpRequest` 降级与分卷作为二期 |

---

## 架构演进：插件化准备

> **状态：仅评估，未实施。** 以下判断基于当前代码实际结构，不是泛泛建议。

### 结论

**当前不需要真插件化，但已经具备了插件化的两个最关键前提，值得做三点低成本加固。**

### 已具备的有利条件

| 条件 | 现状 |
|---|---|
| 模块边界清晰 | 已有 0–8 号模块 + `boot()`，各自以 IIFE 返回对象，无跨模块私有变量穿透 |
| 有现成扩展入口 | `window.__fiv` 已挂出 `ImagePool`/`Viewer`/`Config`/`Settings`/`HoverBadge` 与两个安全判定函数，并注明「其余逻辑不依赖本段」 |
| 配置有分组归属 | `siteFields` 已区分「全局配置」与「站点级配置」，新增 capability 时可自然挂靠 |
| 事件机制存在 | `Config.onChange` 已有监听者模式，可承载 capability 的启停 |

### 为什么**不**建议现在就插件化

1. **收益不足**：这是单文件 userscript，用户安装方式就是「贴一个文件」。真正的插件化收益（第三方扩展、按需加载、独立发布）目前都不存在。
2. **成本明确**：拆包后 `@require` 多文件会带来**加载顺序、`GM_*` 沙箱作用域、版本一致性**三类新问题，且 `@require` 的远程文件在 `@updateURL` 自动更新链路上容易失配。
3. **当前痛点不在架构**：待办里剩下的是 `strictFilter` 死分支、虚拟缩略图分段渲染这类局部问题，与模块化程度无关。

### 建议的三点低成本加固

| # | 加固项 | 具体做法 | 收益 |
|---|---|---|---|
| 1 | **明确 Module 契约** | 每个模块 IIFE 顶部加一段注释，声明：`依赖`（需要谁） / `导出`（对外给什么） / `状态`（是否有可变内部状态） | 未来任何拆分、任何第三方 capability 接入，都不需要重读全文 |
| 2 | **`__fiv` 升级为能力注册表** | 从「挂调试对象」升级为：`__fiv.register(capability)`，capability 声明 `{name, requires, onEnable, onDisable}` | 下载功能即为第一个 capability 试金石；不改现有模块内部 |
| 3 | **模块只依赖接口，不依赖实例** | 新模块（如 `ImageDownloader`）只接受 `items` getter 与 `onChange` 订阅，**不持有 `ImagePool` 引用** | 这是插件化的本质；做到这点，就随时能拆 |

> **判断标准**：当出现「第二个真正独立的功能模块」（下载是第一个候选）时，再评估是否把 `__fiv.register` 正式化为插件协议。**在此之前，加固 1 与 3 就足够。**

### 与下载功能的关系

下载功能天然是插件化的**试金石**：

- 它**只读** `ImagePool.items`，不写池状态 —— 符合「单向依赖」；
- 它是**可选能力**，用户可能不需要 —— 符合「按需挂载」；
- 它需要**新增 `@grant` 权限** —— 正好验证「capability 能否自行声明所需权限」这一插件化核心问题。

因此建议：**下载功能按「独立 capability」实现，而不是按「Viewer 的一个新方法」实现**。这样即使将来不真插件化，模块边界也已经正确。

---

## 工程约定

1. **先看框架再填内容**，确认后再生成正式产出。
2. **禁止编造数据**：查不到就回"搜不到"；缺失字段标【待确认】/【无来源】。
3. **长跑脚本增量保存**，每一步中间产物落盘到项目文件夹，避免中断后重跑。
4. **改动前先做根因分析**，基于实际失败现象修复，而非猜测式改动。
5. **测试先行于版本号**：所有套件全绿后才升版本号并写入本文档。
6. **主题变量单点真源**：所有颜色/尺寸变量集中在 `themeVars()`，启动即写入 `:root`。
7. **Observer 白名单原则**：只监听业务必需的属性，任何脚本自身会改动的属性（如 `style`）一律排除。

---

## 测试套件

全部位于 `.workbuddy/test/`，通过 jsdom 驱动脚本内部接口（`window.__fiv`）。

| 套件 | 断言 | 覆盖内容 |
|---|---|---|
| `verify.js` | 26 | 基础采集、配置落盘、面板 |
| `verify-features.js` | 28 | 遮罩 + 滚动同步 |
| `verify-fixes.js` | 8 | DOM 顺序 + 断点续看 |
| `verify-settings.js` | 21 | 设置面板回显与交互 |
| `verify-group.js` | 19 | 以图定域 / 分组浏览（v1.5 起断言组间续览） |
| `verify-badge.js` | 15 | 悬停角标 |
| `verify-hardening.js` | 22 | URL 安全、Observer、rejected、白名单 |
| `verify-group-v2.js` | 19 | **v1.3 分组收敛专项** |
| `verify-batch4.js` | 29 | **v1.4 增量扫描 / 准入过滤 / 虚拟缩略图 / 死代码** |
| `verify-batch5.js` | 34 | **v1.5 角标稳定性 / 缩略条拖动与点选（含 CSS 命中测试模拟） / 分组枚举 / 组间续览** |
| `verify-download.js` | 121 | **v1.6 打包下载：ZIP 结构与 CRC 基准校验 / 文件名生成与清洗 / 失败清单 / 取消 / 池状态隔离 / UI 接线** |
| `verify-strip.js` | 25 | **v1.6.1 缩略图条跟随：滚动进视野 / 虚拟窗口跟随 index / 序号与实际数量一致 / 关闭条边界** |
| `verify-lazyload.js` | 47 | **v1.8 懒加载采集：奇葩属性名识别 / CDN 参数兜底 / 占位图跳过 / 非图片值不误判 / 安全过滤不被绕过 / 优先级与属性顺序无关 / 占位图→真图属性替换** |
| **合计** | **446** | **失败 0** |

运行方式：

```bash
export NODE_PATH="C:/Users/lidt/.workbuddy/binaries/node/workspace/node_modules"
NODE="C:/Users/lidt/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
"$NODE" .workbuddy/test/verify-group-v2.js
```

---

## 已知取舍与待办

### 有意保留的取舍

| 项 | 说明 |
|---|---|
| **跨图集不合并** | 优先保证"点哪组看哪组"。若页面结构确实需要跨图集统一浏览，用户应改用全局浏览（悬浮按钮 / 快捷键）。 |
| **`dedupeByUrl` 默认关闭** | 默认按 DOM 节点收集，同一 URL 出现多次会收多份。这是为了让"图片池反映页面节点"，避免因去重导致分组失败。 |
| **语义提示不越权** | 宁可分组偏紧（退化为单图 → 回退全局），也不跨容器误合并。偏紧的代价是"多一次回退"，错误的代价是"看到无关图片"。 |
| **`figure` 不作边界** | 保留在内容框架选择器内，仅用于采集范围。 |

### 待办（第六批，未排期）

- **`strictFilter` 不可达分支**：第四批已清理其余死代码，这一处仍在。
- **虚拟缩略图分段渲染**：当前是「可视窗口 + 迷你进度条」的折中；若要缩略条本身也表达全局密度，可考虑分段渲染。
- **`removedNodes` 的精确增量删除**：现在统一走 `markFullScanNeeded()` + 兜底全量 `pruneDetached()`，尚未做「精确移除某几条」的增量路径。
- **分组间快速跳转**：左侧树形目录已因体验不佳移除（v1.5.1）。若日后重做，需先想清楚交互形态（当前仅靠角标「看这组」+ `G` 键切组 + 组间续览）。
- **打包下载的内存上限（v1.6.0 已知限制）**：产物是「一个 ZIP Blob」，浏览器必须把完整 ZIP 放在内存里 —— 流式 API 减少的是中间副本，不消除最终占用。超过 4GB 或条目 > 65535 会**直接抛错**（不静默截断）。几百张图的论坛帖子无碍；若日后要支持上千张，需做**分卷 ZIP**（已列入二期）。
- **跨域图片可能取不到（v1.6.0 已知限制）**：只用 `fetch`，受 CORS 约束。论坛 CDN 常见「允许 `<img>` 跨域显示但不允许 `fetch` 读内容」，这类图会进失败清单。降级方案见二期。
- **触发方式扩展**：右键菜单 / 组合键，仍待定。

### 计划中

| 功能 | 优先级 | 阻塞项 | 详见 |
|---|---|---|---|
| **打包下载二期**：`GM_xmlhttpRequest` 跨域降级 | 中 | 需新增 `@grant` + `@connect *`（**不可逆权限变更**，需先决策） | [计划中功能：批量打包下载](#计划中功能批量打包下载) |
| **打包下载二期**：超阈值分卷 ZIP | 低 | 需定「阈值」与「每卷条目数」；当前超 4GB 会直接抛错 | 同上 |
| **插件化加固**（模块契约注释 + `__fiv.register` + 单向依赖） | 低 | 无 —— 属于渐进式改造。`ImageDownloader` 已按单向依赖实现，可作样板 | [架构演进：插件化准备](#架构演进插件化准备) |

### 触发方式（未定稿）

分组能力已与触发方式解耦。当前入口为**悬停角标**（v1.2.0，点「看这组」进入所在组），
配合 **`G` 键**在「本组 / 全部」间切换，以及 **组间续览**（v1.5.0，组尾自动续到下一组）。
v1.5.0 曾尝试左侧树形目录作为组间跳转入口，因体验不佳于 v1.5.1 移除；
右键菜单或其他组合键仍在讨论中，未实现。

---

*文档最后更新：对应脚本版本 1.8.0*
