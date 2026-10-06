# 论坛图片浏览器 · 版本改动记录

> 油猴脚本 `forum-image-viewer.user.js`
> 从「论坛帖子看图」逐步收敛为「通用网页图片组浏览」。
> 本文档记录每个版本的改动、设计决策、已知取舍与后续待办。

---

## 目录

- [当前状态](#当前状态)
- [版本历史](#版本历史)
- [核心设计决策](#核心设计决策)
- [图片分组算法（以图定域）](#图片分组算法以图定域)
- [分组修复补丁清单](#分组修复补丁清单)
- [计划中功能：批量打包下载](#计划中功能批量打包下载)
- [架构演进：插件化准备](#架构演进插件化准备)
- [工程约定](#工程约定)
- [测试套件](#测试套件)
- [已知取舍与待办](#已知取舍与待办)

---

## 当前状态

| 项 | 值 |
|---|---|
| 当前版本 | **1.5.1** |
| 文件行数 | ~3950 |
| 匹配范围 | `*://*/*`（全站可用，含白名单模式） |
| 测试套件 | 10 个，合计 **218 项断言全绿** |
| 定位 | 通用网页图片组浏览；论坛场景为最优适配对象 |
| 计划中 | 批量打包下载（已评审未实现）、插件化加固（仅评估） |

### 模块布局

| 序号 | 模块 | 职责 |
|---|---|---|
| 0 | utils/consts | 常量、URL 安全边界、DOM 顺序排序、`debounce` |
| 1 | ConfigStore | 全局配置 + 站点级配置覆盖与落盘 |
| 2 | ImagePool | 图片采集 / 过滤 / 动态增量 / **以图定域** / `groups()` 分组枚举 |
| 3 | ThemeProbe | 站点主题探测（主色、圆角、字体、明暗） |
| 4 | CSS | 样式注入与主题变量单点写入 |
| 5 | Viewer + ThumbBar | 浏览层、缩略图进度条、悬停预览、缩放平移、快捷键、组间续览 |
| 5.5 | HoverBadge | 图片悬停角标（分组浏览的默认入口） |
| 6 | Dimmer | 浏览时压暗页面 |
| 7 | Settings | 配置面板 |
| 8 | FloatingButton | 悬浮入口按钮 |
| — | `boot()` | 启动装配 |

---

## 版本历史

### v1.5.1 — 缩略图点选修复 · 移除分组目录（当前版本）

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

| 套件 | v1.5.0 | v1.5.1 |
|---|---|---|
| `verify-batch5.js` | 45 | **32** |
| 合计 | 231 | **218** |

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

> **状态：已评审，未实现。** 本节是设计定稿前的评审记录，代码尚未改动。
> 目标版本：v1.5.0（若采纳）。
>
> 原始规划由 ChatGPT 生成，评审方为项目自身。以下按「结论 → 采纳 / 修正 / 否决 → 遗漏补充」组织。

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
| `verify-hardening.js` | 21 | URL 安全、Observer、rejected、白名单 |
| `verify-group-v2.js` | 19 | **v1.3 分组收敛专项** |
| `verify-batch4.js` | 29 | **v1.4 增量扫描 / 准入过滤 / 虚拟缩略图 / 死代码** |
| `verify-batch5.js` | 32 | **v1.5 角标稳定性 / 缩略条拖动与点选 / 分组枚举 / 组间续览** |
| **合计** | **218** | **失败 0** |

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
- **触发方式扩展**：右键菜单 / 组合键，仍待定。

### 计划中（已评审，未实现）

| 功能 | 优先级 | 阻塞项 | 详见 |
|---|---|---|---|
| **批量打包下载** | 待定 | 需决策：是否新增 `@grant GM_xmlhttpRequest` / `@connect`；压缩级别与内存上限 | [计划中功能：批量打包下载](#计划中功能批量打包下载) |
| **插件化加固**（模块契约注释 + `__fiv.register` + 单向依赖） | 低 | 无 —— 属于渐进式改造，可与下载功能同步落地 | [架构演进：插件化准备](#架构演进插件化准备) |

### 触发方式（未定稿）

分组能力已与触发方式解耦。当前入口为**悬停角标**（v1.2.0，点「看这组」进入所在组），
配合 **`G` 键**在「本组 / 全部」间切换，以及 **组间续览**（v1.5.0，组尾自动续到下一组）。
v1.5.0 曾尝试左侧树形目录作为组间跳转入口，因体验不佳于 v1.5.1 移除；
右键菜单或其他组合键仍在讨论中，未实现。

---

*文档最后更新：对应脚本版本 1.5.1*
