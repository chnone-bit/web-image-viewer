/**
 * v1.6 批量打包下载专项测试
 *
 * 覆盖：
 *   A. ZIP 二进制结构（STORE 模式）
 *      - 魔数 / 本地头 / 中央目录 / EOCD 位置与长度
 *      - CRC-32 与 Node zlib.crc32 逐字节比对（**外部基准校验**，不信任自实现）
 *      - UTF-8 文件名标志位 bit 11 必须置位（否则 Windows 解压中文名乱码）
 *      - STORE 模式：压缩后大小 == 原始大小，压缩方法 == 0
 *   B. 文件名生成
 *      - 序号 + 原名 + 扩展名
 *      - 扩展名按 MIME 推断，不信任 URL 后缀（评审遗漏 1）
 *      - Windows 保留名 / 非法字符 / 尾随点空格 / 路径穿越（评审补充项）
 *   C. 失败清单与并发取
 *      - 单张失败不阻断整体，如实进失败清单（评审遗漏 3）
 *      - 失败项不进 ZIP
 *   D. 取消语义
 *      - AbortController 取消后立即返回 cancelled，不产出文件
 *   E. 不污染图片池（评审遗漏 4 的关键约束）
 *      - 打包后 seenKeys / current / scope 不被修改
 *   F. UI 接线
 *      - 工具条按钮、Shift+D 拦截、菜单命令、window.__fivPack
 *
 * 关键设计：CRC 校验不用被测代码自己的实现做基准（自己验自己必然通过），
 * 而是用 Node 内置 zlib.crc32 独立算一遍再比对。
 */
const fs = require('fs');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const SRC = 'C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js';
const CODE = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

/* ---------- 从字节流里读小端整数 ---------- */
function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

/** 解析 buildZip 产出的字节流，返回结构化描述 */
function parseZip(bytes) {
  const sig = u32(bytes, 0);
  if (sig !== 0x04034b50) return { error: '首部魔数不是本地文件头' };
  const flags = u16(bytes, 6);
  const method = u16(bytes, 8);
  const crc = u32(bytes, 14);
  const compSize = u32(bytes, 18);
  const rawSize = u32(bytes, 22);
  const nameLen = u16(bytes, 26);
  const extraLen = u16(bytes, 28);
  const name = Buffer.from(bytes.subarray(30, 30 + nameLen)).toString('utf8');
  const dataStart = 30 + nameLen + extraLen;
  const data = bytes.subarray(dataStart, dataStart + compSize);

  // 从尾部找 EOCD（可能有注释，这里没有，所以固定在末尾 22 字节）
  const eocd = bytes.length - 22;
  const eocdSig = u32(bytes, eocd);
  return {
    flags, method, crc, compSize, rawSize, name, data,
    localSize: 30 + nameLen + extraLen,
    eocdOk: eocdSig === 0x06054b50,
    eocdCount: u16(bytes, eocd + 10),
    eocdCentralSize: u32(bytes, eocd + 12),
    eocdCentralOffset: u32(bytes, eocd + 16),
    total: bytes.length
  };
}

const THREE_GROUPS = '<div class="thread">'
  + '<div class="post" id="p1"><div class="message" id="mA">'
  + '<img id="A1" src="https://x.com/a1.jpg"><img id="A2" src="https://x.com/a2.jpg">'
  + '</div></div>'
  + '<div class="post" id="p2"><div class="message" id="mB">'
  + '<img id="B1" src="https://x.com/b1.jpg"><img id="B2" src="https://x.com/b2.jpg">'
  + '</div></div>'
  + '</div>';

/* ---- GM_xmlhttpRequest 桩 ----
 * 模拟油猴跨域通道。默认不启用（NEXT_GM 为 null 时不定义该函数），
 * 这样「无 GM 环境」与「有 GM 环境」两种降级路径都能测。
 * 用模块级变量是因为 withPage 内部就 new JSDOM，外部无法提前注入。 */
let NEXT_GM = null;
function setGmImpl(fn) { NEXT_GM = fn; }

function withPage(html) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>',
    { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
  w.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0 };
  };
  w.getComputedStyle = () => ({
    backgroundImage: 'none', display: 'block', visibility: 'visible', opacity: '1',
    getPropertyValue() { return ''; }
  });
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = () => {};
  w.console.error = () => {};
  w.console.warn = () => {};
  if (!w.PointerEvent) {
    w.PointerEvent = class extends w.MouseEvent {
      constructor(t, o = {}) { super(t, o); this.pointerId = o.pointerId || 1; this.pointerType = o.pointerType || 'mouse'; this.button = o.button || 0; }
    };
  }
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.releasePointerCapture = function () {};
  // fetch 桩：默认全部成功，测试里可替换
  // ⚠️ jsdom 的 window 上没有 Response/Headers（那是 fetch API 的实现细节），
  //    所以这里用 Node 全局的 Response 构造，并按 fetch 契约返回。
  const NodeResponse = globalThis.Response;
  w.__fetchImpl = async () => new NodeResponse(new Uint8Array([1, 2, 3, 4]), {
    status: 200, headers: { 'content-type': 'image/jpeg' }
  });
  w.fetch = function (url) { return w.__fetchImpl(url); };

  /* ---- GM_xmlhttpRequest 桩 ----
   * 默认不存在（NEXT_GM 为 null 时不定义该函数），
   * 这样「无 GM 环境」与「有 GM 环境」两种降级路径都能测。 */
  w.__gmCalls = [];
  if (NEXT_GM) {
    w.GM_xmlhttpRequest = function (opt) {
      w.__gmCalls.push({ url: opt.url, method: opt.method, responseType: opt.responseType, anonymous: opt.anonymous });
      const req = { aborted: false, abort() { this.aborted = true; } };
      setTimeout(() => {
        if (req.aborted) { if (opt.onabort) opt.onabort(); return; }
        NEXT_GM(opt, req);
      }, 0);
      return req;
    };
  }
  // 记录 <a download> 触发
  w.__downloads = [];
  const origClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () {
    if (this.download) { w.__downloads.push({ name: this.download, href: this.href }); return; }
    return origClick.call(this);
  };
  w.URL.createObjectURL = () => 'blob:mock';
  w.URL.revokeObjectURL = () => {};
  w.eval(CODE);
  return new Promise((resolve) => setTimeout(() => resolve({
    w,
    P: w.__fiv.ImagePool,
    V: w.__fiv.Viewer,
    C: w.__fiv.Config,
    D: w.__fiv.ImageDownloader
  }), 400));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => new TextEncoder().encode(s);

(async () => {
  /* ================= A. ZIP 二进制结构 ================= */
  console.log('\n【ZIP】STORE 模式结构与 CRC 正确性');
  {
    const { D } = await withPage(THREE_GROUPS);
    // 三个不同内容的文件
    const files = [
      { name: '001_alpha.jpg', data: enc('ABCDEFGH') },
      { name: '002_中文名.png', data: enc('hello') },
      { name: '003_empty.gif', data: new Uint8Array(0) }
    ];
    const bytes = D._buildZip(files);
    const z = parseZip(bytes);

    ok('首部为本地文件头魔数', u32(bytes, 0) === 0x04034b50);
    ok('压缩方法 = 0（STORE，不压缩）', z.method === 0, 'method=' + z.method);
    ok('置 UTF-8 文件名标志位 bit 11', (z.flags & 0x0800) !== 0, 'flags=0x' + z.flags.toString(16));
    ok('STORE 模式：压缩后大小 == 原始大小', z.compSize === z.rawSize, z.compSize + ' vs ' + z.rawSize);
    ok('EOCD 签名正确', z.eocdOk);
    ok('EOCD 条目数 = 3', z.eocdCount === 3, 'count=' + z.eocdCount);
    ok('首个文件名正确', z.name === '001_alpha.jpg', z.name);
    ok('数据内容一致', Buffer.from(z.data).toString() === 'ABCDEFGH', Buffer.from(z.data).toString());

    // ★ 关键：用 Node 内置 zlib.crc32 独立校验，不信任被测实现
    ok('CRC-32 与 Node zlib 基准一致',
      z.crc === zlib.crc32(Buffer.from('ABCDEFGH')),
      'got ' + z.crc + ' want ' + zlib.crc32(Buffer.from('ABCDEFGH')));
    ok('_crc32() 与 Node 基准一致（空输入）',
      D._crc32(new Uint8Array(0)) === zlib.crc32(Buffer.alloc(0)));
    ok('_crc32() 与 Node 基准一致（二进制含 0xFF）',
      D._crc32(new Uint8Array([0, 255, 128, 1])) === zlib.crc32(Buffer.from([0, 255, 128, 1])));
  }

  console.log('\n【ZIP】中文文件名与多文件偏移');
  {
    const { D } = await withPage(THREE_GROUPS);
    const files = [
      { name: '001_图片.jpg', data: enc('AA') },
      { name: '002_第二张.png', data: enc('BBBB') },
      { name: '003_第三张.webp', data: enc('CCCCC') }
    ];
    const bytes = D._buildZip(files);

    // 逐个解析本地头，验证偏移与内容
    let p = 0;
    const parsed = [];
    for (let i = 0; i < files.length; i++) {
      const nameLen = u16(bytes, p + 26);
      const extraLen = u16(bytes, p + 28);
      const size = u32(bytes, p + 22);
      const name = Buffer.from(bytes.subarray(p + 30, p + 30 + nameLen)).toString('utf8');
      const d = bytes.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
      parsed.push({ name, content: Buffer.from(d).toString() });
      p += 30 + nameLen + extraLen + size;
    }
    ok('中文文件名正确解码（UTF-8 标志位生效）', parsed[0].name === '001_图片.jpg', parsed[0].name);
    ok('三个文件按顺序写入且内容不串位',
      parsed[1].content === 'BBBB' && parsed[2].content === 'CCCCC',
      parsed.map((x) => x.content).join('|'));
    ok('数据区结束位置 == 中央目录偏移', p === u32(bytes, bytes.length - 22 + 16),
      p + ' vs ' + u32(bytes, bytes.length - 22 + 16));
    // 中央目录条目数与本地头数一致
    ok('中央目录条目数 = 3', u16(bytes, bytes.length - 22 + 10) === 3);
  }

  /* ================= B. 文件名生成 ================= */
  console.log('\n【文件名】序号 + 原名 + MIME 推断扩展名');
  {
    const { D } = await withPage(THREE_GROUPS);
    const mk = D._makeFilename;
    ok('基本形态：001_xxx.jpg', mk(0, 'photo', 'image/jpeg') === '001_photo.jpg', mk(0, 'photo', 'image/jpeg'));
    ok('序号补零到 3 位', mk(9, 'a', 'image/png') === '010_a.png', mk(9, 'a', 'image/png'));
    ok('MIME 优先于原名后缀（评审遗漏1：URL 后缀不可信）',
      mk(0, 'image.php', 'image/webp') === '001_image.webp', mk(0, 'image.php', 'image/webp'));
    ok('MIME 缺失时回退原名后缀', mk(0, 'x.jpeg', '') === '001_x.jpeg', mk(0, 'x.jpeg', ''));
    ok('MIME 与后缀都无 → 兜底 .jpg', mk(0, 'noext', '') === '001_noext.jpg', mk(0, 'noext', ''));
    ok('MIME 含 charset 参数仍能识别', mk(0, 'a', 'image/PNG; charset=binary') === '001_a.png',
      mk(0, 'a', 'image/PNG; charset=binary'));
    ok('SVG 扩展名正确', mk(0, 'icon', 'image/svg+xml') === '001_icon.svg', mk(0, 'icon', 'image/svg+xml'));
  }

  console.log('\n【文件名】清洗：Windows 保留名 / 非法字符 / 路径穿越');
  {
    const { D } = await withPage(THREE_GROUPS);
    const s = D._sanitizeName;
    ok('Windows 保留名 CON 被保护', s('CON') === '_CON', s('CON'));
    ok('Windows 保留名 con.jpg 被保护', s('con.jpg') === '_con.jpg', s('con.jpg'));
    ok('LPT1 被保护', s('LPT1') === '_LPT1', s('LPT1'));
    ok('非法字符 <>:"|?* 被替换', s('a<b>c:d"e|f?g*h') === 'a_b_c_d_e_f_g_h', s('a<b>c:d"e|f?g*h'));
    ok('路径分隔符被替换（防目录穿越）', !s('../../etc/passwd').includes('/'), s('../../etc/passwd'));
    ok('相对路径 .. 被消除', !s('..').startsWith('..'), s('..'));
    ok('尾部空格被去除', s('name   ') === 'name', JSON.stringify(s('name   ')));
    ok('尾部点被去除', s('name...') === 'name', JSON.stringify(s('name...')));
    ok('前导点被去除（防隐藏文件）', s('.gitignore') === 'gitignore', s('.gitignore'));
    ok('空名兜底为 image', s('') === 'image' && s(null) === 'image');
    ok('超长名被截断且不超过上限', D._makeFilename(0, 'x'.repeat(400), 'image/jpeg').length <= 128,
      'len=' + D._makeFilename(0, 'x'.repeat(400), 'image/jpeg').length);
  }

  /* ================= C. 失败清单 ================= */
  console.log('\n【打包】失败清单：单张失败不阻断整体');
  {
    const { w, D } = await withPage(THREE_GROUPS);
    let n = 0;
    w.__fetchImpl = async (url) => {
      n++;
      if (url.includes('b1')) return new globalThis.Response('nope', { status: 404 });
      if (url.includes('b2')) throw new Error('network down');
      return new globalThis.Response(enc('IMG' + n), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const list = [
      { src: 'https://x.com/a1.jpg', name: 'a1.jpg' },
      { src: 'https://x.com/b1.jpg', name: 'b1.jpg' },
      { src: 'https://x.com/b2.jpg', name: 'b2.jpg' },
      { src: 'https://x.com/a2.jpg', name: 'a2.jpg' }
    ];
    const res = await D.download(list, { zipName: 'test' });
    ok('成功数 = 2', res.ok === 2, 'ok=' + res.ok);
    ok('失败数 = 2（如实上报，不静默跳过）', res.failed.length === 2, 'failed=' + res.failed.length);
    ok('失败原因含 HTTP 状态', res.failed.some((f) => /404/.test(f.reason)), JSON.stringify(res.failed.map((f) => f.reason)));
    ok('失败原因含网络异常', res.failed.some((f) => /network down/.test(f.reason)), JSON.stringify(res.failed.map((f) => f.reason)));
    ok('已触发 ZIP 下载', w.__downloads.length === 1, 'downloads=' + w.__downloads.length);
    ok('ZIP 文件名以 .zip 结尾', w.__downloads.length > 0 && /\.zip$/.test(w.__downloads[0].name),
      w.__downloads.length ? w.__downloads[0].name : '未触发下载');
  }

  console.log('\n【打包】全部失败时不产出空 ZIP');
  {
    const { w, D } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => new globalThis.Response('x', { status: 500 });
    const res = await D.download([{ src: 'https://x.com/a.jpg', name: 'a.jpg' }], { zipName: 't' });
    ok('ok = 0', res.ok === 0);
    ok('全部进失败清单', res.failed.length === 1);
    ok('未触发任何下载', w.__downloads.length === 0, 'downloads=' + w.__downloads.length);
  }

  console.log('\n【打包】非图片响应被拒');
  {
    const { w, D } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => new globalThis.Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const res = await D.download([{ src: 'https://x.com/a.jpg', name: 'a.jpg' }], { zipName: 't' });
    ok('HTML 响应被拒并进失败清单', res.ok === 0 && res.failed.length === 1, JSON.stringify(res.failed.map((f) => f.reason)));
  }

  console.log('\n【安全】只放行 http/https');
  {
    const { w, D } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async (url) => {
      throw new Error('SHOULD_NOT_FETCH ' + url);
    };
    const res = await D.download([
      { src: 'javascript:alert(1)', name: 'evil.jpg' },
      { src: 'data:image/png;base64,AAAA', name: 'd.png' },
      { src: 'file:///C:/secret.jpg', name: 'f.jpg' }
    ], { zipName: 't' });
    ok('非 http(s) 全部拒绝且未发起请求', res.ok === 0 && res.failed.length === 3,
      'ok=' + res.ok + ' failed=' + res.failed.length);
  }

  /* ================= D. 取消语义 ================= */
  console.log('\n【取消】AbortController 中断');
  {
    const { w, D } = await withPage(THREE_GROUPS);
    const ctrl = new AbortController();
    let calls = 0;
    w.__fetchImpl = async () => {
      calls++;
      await sleep(50);
      return new globalThis.Response(enc('X'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const list = Array.from({ length: 20 }, (_, i) => ({ src: 'https://x.com/i' + i + '.jpg', name: 'i' + i + '.jpg' }));
    const p = D.download(list, { zipName: 't', signal: ctrl.signal });
    await sleep(30);
    ctrl.abort();
    const res = await p;
    ok('取消后返回 cancelled=true', res.cancelled === true, JSON.stringify({ c: res.cancelled, ok: res.ok }));
    ok('取消后不产出任何文件', res.ok === 0 && w.__downloads.length === 0, 'ok=' + res.ok + ' dl=' + w.__downloads.length);
    ok('取消后请求数少于总数（提前收敛）', calls < 20, 'calls=' + calls);
  }

  /* ================= E. 不污染图片池 ================= */
  console.log('\n【隔离】打包不得回写图片池状态（评审遗漏4）');
  {
    const { w, P, V, D } = await withPage(THREE_GROUPS);
    const A1 = w.document.getElementById('A1');
    V.openGroup(A1);
    await sleep(120);
    const inGroupBefore = V.inGroup;
    const countBefore = V.itemCount;
    const idxBefore = V.index;
    // 记录 seen 状态（缩略条上的已看小点）
    const seenBefore = P.items.map((it) => !!(P.seenKeys && P.seenKeys.has(it.key)));

    await D.download(P.items.map((it) => ({ src: it.src, name: it.name })), { zipName: 't' });

    ok('分组状态未被改变（未误判为已浏览）', V.inGroup === inGroupBefore, V.inGroup + ' vs ' + inGroupBefore);
    ok('条目数未变', V.itemCount === countBefore, V.itemCount + ' vs ' + countBefore);
    ok('当前下标未变', V.index === idxBefore, V.index + ' vs ' + idxBefore);
    ok('图片池条数未变', P.count === 4, 'count=' + P.count);
    const seenAfter = P.items.map((it) => !!(P.seenKeys && P.seenKeys.has(it.key)));
    ok('seenKeys 未被写入', JSON.stringify(seenBefore) === JSON.stringify(seenAfter),
      JSON.stringify(seenBefore) + ' vs ' + JSON.stringify(seenAfter));
  }

  /* ================= F. UI 接线 ================= */
  console.log('\n【UI】入口接线');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    V.openAt(0);
    await sleep(120);
    const btn = w.document.querySelector('[data-act="pack-group"]');
    ok('工具条存在「打包下载本组」按钮', !!btn);
    ok('按钮有 package 图标', btn && btn.querySelector('svg'), '');
    ok('Viewer 导出 packDownload', typeof V.packDownload === 'function');
    ok('window.__fivPack 可用（供菜单命令）', typeof w.__fivPack === 'function');
    ok('window.__fiv.ImageDownloader 已导出', !!w.__fiv.ImageDownloader);
  }

  console.log('\n【UI】进度与取消控件');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => {
      await sleep(80);
      return new globalThis.Response(enc('Z'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(200);
    const pack = w.document.querySelector('.fiv-pack');
    ok('进度面板已创建', !!pack);
    ok('进度面板有取消按钮', !!(pack && pack.querySelector('.fiv-pack-cancel')));
    ok('进度面板有进度条', !!(pack && pack.querySelector('.fiv-pack-fill')));
    ok('面板处于显示态', pack && pack.classList.contains('fiv-on'), pack ? pack.className : '无');
    ok('文案含进度信息', pack && /获取|打包/.test(pack.querySelector('.fiv-pack-txt').textContent),
      pack ? pack.querySelector('.fiv-pack-txt').textContent : '');
    await sleep(600);
    const txt = pack ? pack.querySelector('.fiv-pack-txt').textContent : '';
    ok('完成后显示成功数量', /已打包\s*\d+\s*张/.test(txt), txt);
  }

  console.log('\n【UI】菜单命令注册');
  {
    const cmds = [];
    const dom = new JSDOM('<!DOCTYPE html><html><body>' + THREE_GROUPS + '</body></html>',
      { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
    Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
    w.Element.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0 };
    };
    w.getComputedStyle = () => ({ backgroundImage: 'none', display: 'block', visibility: 'visible', opacity: '1', getPropertyValue() { return ''; } });
    w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
    w.cancelAnimationFrame = (id) => clearTimeout(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = () => {};
    w.GM_setValue = () => {}; w.GM_getValue = () => undefined; w.GM_deleteValue = () => {};
    w.GM_addStyle = () => {};
    w.GM_registerMenuCommand = (name, fn) => cmds.push({ name, fn });
    w.URL.createObjectURL = () => 'blob:mock';
    w.URL.revokeObjectURL = () => {};
    w.__dl = [];
    const oc = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () {
      if (this.download) { w.__dl.push(this.download); return; }
      return oc.call(this);
    };
    w.fetch = async () => new globalThis.Response(new Uint8Array([1, 2]), {
      status: 200, headers: { 'content-type': 'image/jpeg' }
    });
    w.eval(CODE);
    await sleep(500);
    ok('注册了菜单命令', cmds.length >= 4, 'count=' + cmds.length);
    ok('有「打包下载全部」菜单', cmds.some((c) => /打包下载全部/.test(c.name)),
      cmds.map((c) => c.name).join(' | '));
    ok('有「打包下载当前组」菜单', cmds.some((c) => /打包下载当前组/.test(c.name)),
      cmds.map((c) => c.name).join(' | '));

    // ⚠️ 回归：菜单命令实际调用 window.__fivPack。
    //    曾经踩过的坑：__fivPack 写成箭头函数直接引用 packDownload，
    //    而 packDownload 定义在 Viewer 的闭包里 → ReferenceError，菜单完全失效。
    const packAll = cmds.find((c) => /打包下载全部/.test(c.name));
    let menuErr = null;
    try { await packAll.fn(); } catch (e) { menuErr = e; }
    await sleep(300);
    ok('点击菜单命令不抛异常', !menuErr, menuErr ? menuErr.constructor.name + ': ' + menuErr.message : '');
    ok('菜单命令真的产出了下载', w.__dl.length === 1, 'downloads=' + w.__dl.length);
  }

  console.log('\n【回归】__fivPack 作用域（曾抛 ReferenceError）');
  {
    const { w } = await withPage(THREE_GROUPS);
    let err = null;
    try { await w.__fivPack('all'); } catch (e) { err = e; }
    await sleep(200);
    ok('__fivPack("all") 不抛异常', !err, err ? err.message : '');
    ok('__fivPack 真的触发了下载', w.__downloads.length === 1, 'downloads=' + w.__downloads.length);
    const before = w.__downloads.length;
    try { await w.__fivPack('group'); } catch (e) { err = e; }
    await sleep(200);
    ok('__fivPack("group") 不抛异常', !err, err ? err.message : '');
    ok('__fivPack("group") 也触发下载', w.__downloads.length === before + 1,
      'before=' + before + ' now=' + w.__downloads.length);
  }

  console.log('\n【体验】全部失败时必须明确告知原因（不能"点了没反应"）');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    // 模拟跨域被拦：fetch 抛 TypeError（真实浏览器里是 "Failed to fetch"）
    w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(400);
    const panel = w.document.querySelector('.fiv-pack');
    ok('失败时进度面板仍然出现', !!panel && panel.classList.contains('fiv-on'),
      panel ? panel.className : '无面板');
    const txt = panel ? panel.querySelector('.fiv-pack-txt').textContent : '';
    ok('文案说明「全部获取失败」而非沉默', /全部.*获取失败/.test(txt), txt);
    ok('文案给出跨域原因提示', /跨域|CORS/.test(txt), txt);
    const detail = panel ? panel.querySelector('.fiv-pack-detail').textContent : '';
    ok('列出失败清单与原因', /Failed to fetch/.test(detail), detail.slice(0, 80));
  }

  console.log('\n【体验】部分失败也要展示「成功 + 失败」两件事');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    let n = 0;
    w.__fetchImpl = async () => {
      n++;
      if (n % 2 === 0) throw new TypeError('Failed to fetch');
      return new globalThis.Response(enc('A'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(500);
    const panel = w.document.querySelector('.fiv-pack');
    const txt = panel ? panel.querySelector('.fiv-pack-txt').textContent : '';
    ok('显示成功张数', /已打包\s*2\s*张/.test(txt), txt);
    // ⚠️ 主文案必须同时带失败数，否则用户会以为另外 2 张不存在
    ok('主文案同时告知失败张数', /2\s*张失败/.test(txt), txt);
    const detailTxt = panel ? panel.querySelector('.fiv-pack-detail').textContent : '';
    ok('失败明细可查', /有\s*2\s*张未能获取/.test(detailTxt), detailTxt.slice(0, 80));
  }

  console.log('\n【诊断】__fiv.diagPack 排障入口');
  {
    const { w } = await withPage(THREE_GROUPS);
    ok('__fiv.diagPack 已暴露', typeof w.__fiv.diagPack === 'function');
    let rows = null, err = null;
    try { rows = await w.__fiv.diagPack('all'); } catch (e) { err = e; }
    ok('diagPack 可执行不抛异常', !err, err ? err.message : '');
    ok('逐张返回诊断结果', Array.isArray(rows) && rows.length === 4, 'rows=' + (rows ? rows.length : 'null'));
    ok('结果含 ok 字段', !!(rows && rows[0] && 'ok' in rows[0]),
      rows && rows[0] ? JSON.stringify(rows[0]) : '');
    // v1.7.0 起 diagPack 走真实取数链路（含 GM 降级），
    // 因此成功项的标识从 HTTP status 变为通道名 via。
    ok('结果含 via（fetch / gm）字段', !!(rows && rows[0] && 'via' in rows[0]),
      rows && rows[0] ? JSON.stringify(rows[0]) : '');
  }

  console.log('\n【跨域降级】fetch 被 CORS 拦下时改走 GM 通道（用户真机反馈的核心问题）');
  {
    // 场景还原：论坛图床 23img / thumbsnap 等不返回 Access-Control-Allow-Origin，
    // 浏览器 fetch 直接 TypeError: Failed to fetch。
    setGmImpl((opt) => {
      opt.onload({
        status: 200,
        responseHeaders: 'content-type: image/jpeg\r\ncontent-length: 4\r\n',
        response: new Uint8Array([9, 9, 9, 9]).buffer
      });
    });
    const { w, V } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    ok('GM 通道被识别为可用', w.__fiv.ImageDownloader.hasGmXhr() === true);

    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(500);

    ok('跨域请求确实发到了 GM 通道', w.__gmCalls.length > 0, 'calls=' + w.__gmCalls.length);
    ok('使用了 arraybuffer 响应类型', w.__gmCalls.every((c) => c.responseType === 'arraybuffer'),
      JSON.stringify(w.__gmCalls[0] || {}));
    ok('携带 Cookie（登录态图床必需）', w.__gmCalls.every((c) => c.anonymous === false),
      JSON.stringify(w.__gmCalls[0] || {}));
    ok('CORS 拦截下仍成功打包', w.__downloads.length === 1, 'downloads=' + w.__downloads.length);
    ok('产出的是 ZIP', w.__downloads.length > 0 && /\.zip$/.test(w.__downloads[0].name),
      w.__downloads.length ? w.__downloads[0].name : '无');

    const panel = w.document.querySelector('.fiv-pack');
    const txt = panel ? panel.querySelector('.fiv-pack-txt').textContent : '';
    ok('全部成功无失败提示', /已打包\s*4\s*张/.test(txt), txt);
    ok('主文案标明走了跨域通道', /跨域通道/.test(txt), txt);
  }

  console.log('\n【跨域降级】无 GM 权限 / 用户关闭开关时不得发起扩展层请求');
  {
    setGmImpl(null);   // 模拟油猴未授予权限
    const { w, V } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    ok('无 GM 时 hasGmXhr 为 false', w.__fiv.ImageDownloader.hasGmXhr() === false);

    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(400);
    ok('未产出 ZIP（符合预期，无可用通道）', w.__downloads.length === 0);
    const panel = w.document.querySelector('.fiv-pack');
    const txt = panel ? panel.querySelector('.fiv-pack-txt').textContent : '';
    ok('提示指向权限缺失而非泛泛说跨域', /权限/.test(txt), txt);
  }
  {
    // 用户主动关闭降级开关：即使有 GM 权限也不得使用
    setGmImpl((opt) => opt.onload({
      status: 200, responseHeaders: 'content-type: image/jpeg', response: new Uint8Array([1]).buffer
    }));
    const { w, V, C } = await withPage(THREE_GROUPS);
    C.set('crossOriginFallback', false);
    w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    ok('开关关闭后 hasGmXhr 为 false', w.__fiv.ImageDownloader.hasGmXhr() === false,
      '开关未生效');

    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(400);
    ok('开关关闭时零扩展层请求', w.__gmCalls.length === 0, 'calls=' + w.__gmCalls.length);
    ok('开关关闭时不产出 ZIP', w.__downloads.length === 0);
  }
  setGmImpl(null);

  console.log('\n【跨域降级】同源可用时不走 GM（避免无谓的权限使用）');
  {
    setGmImpl((opt) => opt.onload({
      status: 200, responseHeaders: 'content-type: image/jpeg', response: new Uint8Array([1]).buffer
    }));
    const { w, V } = await withPage(THREE_GROUPS);
    // fetch 正常返回，不该触发降级
    w.__fetchImpl = async () => new globalThis.Response(new Uint8Array([1, 2]), {
      status: 200, headers: { 'content-type': 'image/jpeg' }
    });
    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(400);
    ok('同源成功时零 GM 请求', w.__gmCalls.length === 0, 'calls=' + w.__gmCalls.length);
    ok('同源成功时正常产出 ZIP', w.__downloads.length === 1);
    const panel = w.document.querySelector('.fiv-pack');
    const txt = panel ? panel.querySelector('.fiv-pack-txt').textContent : '';
    ok('主文案不误报跨域通道', !/跨域通道/.test(txt), txt);
  }
  setGmImpl(null);

  console.log('\n【跨域降级】GM 侧的各类失败必须如实上报，不得静默');
  {
    const cases = [
      ['HTTP 404', (opt) => opt.onload({ status: 404, responseHeaders: '', response: new ArrayBuffer(0) }), /HTTP 404/],
      ['非图片响应', (opt) => opt.onload({ status: 200, responseHeaders: 'content-type: text/html', response: new ArrayBuffer(2) }), /非图片响应/],
      ['网络错误', (opt) => opt.onerror(), /跨域请求失败/],
      ['超时', (opt) => opt.ontimeout(), /超时/],
      ['响应为空', (opt) => opt.onload({ status: 200, responseHeaders: 'content-type: image/jpeg', response: null }), /响应为空/]
    ];
    for (const [name, impl, re] of cases) {
      setGmImpl(impl);
      const { w, V } = await withPage(THREE_GROUPS);
      w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
      V.openAt(0);
      await sleep(80);
      V.packDownload('all');
      await sleep(350);
      const panel = w.document.querySelector('.fiv-pack');
      const detail = panel ? panel.querySelector('.fiv-pack-detail').textContent : '';
      ok('GM ' + name + ' 被如实上报', re.test(detail), detail.slice(0, 90));
      ok('GM ' + name + ' 时不产出 ZIP', w.__downloads.length === 0);
    }
  }
  setGmImpl(null);

  console.log('\n【跨域降级】取消必须能中断正在飞的 GM 请求');
  {
    setGmImpl((opt) => {
      // 永不回调，模拟慢响应
      void opt;
    });
    const { w, V } = await withPage(THREE_GROUPS);
    w.__fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    V.openAt(0);
    await sleep(100);
    V.packDownload('all');
    await sleep(150);
    const cancel = w.document.querySelector('.fiv-pack button');
    ok('进度面板提供取消按钮', !!cancel);
    if (cancel) cancel.click();
    await sleep(400);
    ok('取消后不产出 ZIP', w.__downloads.length === 0, 'downloads=' + w.__downloads.length);
  }
  setGmImpl(null);

  console.log('\n【安全边界】跨域权限有明确边界且可由用户关闭');
  {
    const head = CODE.slice(0, CODE.indexOf('==/UserScript=='));
    const grants = (head.match(/@grant\s+(\S+)/g) || []).map((s) => s.replace('@grant', '').trim());
    // v1.7.0 起：用户实测确认论坛图床（23img/66img/thumbsnap）全部拦 CORS，
    // 纯 fetch 方案不可用，经用户决策加入 GM_xmlhttpRequest。
    // 此处断言随之从「禁止新增」改为「新增的权限必须被显式记录 + 必须可关闭」。
    ok('已授予 GM_xmlhttpRequest（跨域取图必需）', grants.includes('GM_xmlhttpRequest'), grants.join(','));
    ok('grant 数量为 6（原 5 + GM_xmlhttpRequest）', grants.length === 6, 'grants=' + grants.length + ' → ' + grants.join(','));
    ok('存在 @connect 声明', /@connect\s+\S/.test(head),
      (head.match(/@connect[^\n]*/) || ['无'])[0]);
    ok('@connect 之后没有其它新 grant 混入', grants.filter((g) => !/^(GM_setValue|GM_getValue|GM_deleteValue|GM_addStyle|GM_registerMenuCommand|GM_xmlhttpRequest)$/.test(g)).length === 0,
      grants.join(','));

    // 安全阀：用户必须能关掉跨域降级，否则「扩展层向任意站点发请求」无法收敛
    ok('提供 crossOriginFallback 开关', /crossOriginFallback/.test(CODE));
    ok('开关默认开启', /crossOriginFallback:\s*true/.test(CODE));
    ok('hasGmXhr 读取该开关', /hasGmXhr[\s\S]{0,400}crossOriginFallback/.test(CODE),
      'hasGmXhr 未受开关控制');
    ok('开关出现在设置面板中', /toggleRow\('crossOriginFallback'\)/.test(CODE));
  }

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();
