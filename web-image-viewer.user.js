// ==UserScript==
// @name         网页图片浏览器
// @name:en      Web Image Viewer
// @namespace    local.web.imageviewer
// @version      1.8.0
// @description  图片沉浸式浏览：滚轮翻图 + 缩略图进度条（超多图自动虚拟化 + 全局迷你进度条）+ 悬停角标「只看这组」+ 组间续览（组尾自动续到下一组）+ 批量打包下载（当前组/全部，ZIP 打包，跨域自动降级，失败清单）。自动识别图片容器与分组边界（懒加载属性全量启发式识别，兼容各站私有命名），动态加载的新图增量并入（不全页重扫），自适应站点原生风格。论坛、电商图集、图文页面通用。
// @author       Mark
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-disable no-empty */
(function () {
  'use strict';

  /* =========================================================================
   * 0. 常量与工具
   * ========================================================================= */

  const NS = 'fiv';                     // 命名空间前缀
  const VERSION = '1.8.0';              // 与头部 @version 保持一致
  const Z_BASE = 2147483000;            // 遮罩层级
  const LOG_PREFIX = '[图片浏览器]';

  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  /* ------------------------- URL 安全边界 -------------------------
   * 网页 DOM 里的 URL 是**不可信数据**：任何站点都能给 img 挂
   * `data-original="javascript:..."` 之类的脏地址。
   *
   * 处理原则：
   *   · 只用于 `<img src>` 渲染的（相对地址可用）→ 宽松放行，
   *     但拦掉 javascript:/vbscript: 这类可执行的伪协议。
   *   · 用于「外部导航 / 下载 / window.open」的 → 严格，
   *     只允许 http:/https:（含相对地址解析后的结果）。
   * ------------------------------------------------------------------ */

  /** 可执行 / 危险的伪协议（用于 img.src 也要拦） */
  const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|file)\s*:/i;

  /**
   * 宽松放行：判断该 URL 是否可以安全地赋给 `<img>.src`。
   * 允许 http/https/相对路径/blob/data:image/*；
   * 拒绝 javascript:/vbscript:/file: 以及 data: 非图片类型。
   */
  function isSafeImageSrc(url) {
    if (!url || typeof url !== 'string') return false;
    const s = url.trim();
    if (!s) return false;
    if (DANGEROUS_SCHEME.test(s)) return false;
    if (/^\s*data:/i.test(s)) {
      // data: 只放行图片类型；data:image/svg+xml 也仅在 <img> 里渲染，安全
      return /^\s*data:image\//i.test(s);
    }
    if (/^\s*blob:/i.test(s)) return true;
    return true; // http/https/相对路径/协议相对（//host）
  }

  /**
   * 严格放行：判断该 URL 是否可用于「打开新标签 / 下载」这类外部动作。
   * 只接受解析后协议为 http: 或 https: 的地址。
   */
  function isSafeExternalUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const s = url.trim();
    if (!s) return false;
    if (DANGEROUS_SCHEME.test(s)) return false;
    try {
      const u = new URL(s, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  /** 防抖 */
  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
    };
  }

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /** 把 url 归一化成去重 key（去掉协议、缩略图后缀、查询串中易变参数） */
  function normalizeKey(raw) {
    if (!raw) return '';
    let u = raw.trim();
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
    try {
      const url = new URL(u, location.href);
      let p = url.pathname;
      // 常见缩略图后缀还原： xxx.thumb.jpg / xxx.small.png / xxx_300x300.jpg
      p = p.replace(/\.(thumb|small|medium|mini|preview|list)(?=\.[a-z0-9]{2,5}$)/i, '');
      p = p.replace(/[_\-](\d{1,4})x(\d{1,4})(?=\.[a-z0-9]{2,5}$)/i, '');
      return (url.hostname + p).toLowerCase();
    } catch (e) {
      return u.toLowerCase();
    }
  }

  /** 从 url 猜文件名 */
  function guessName(raw, fallback) {
    if (!raw) return fallback;
    try {
      const url = new URL(raw, location.href);
      const seg = url.pathname.split('/').filter(Boolean).pop() || '';
      const name = decodeURIComponent(seg.split('?')[0]);
      return name || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** 元素是否「明显不可见」（display:none / visibility:hidden / 尺寸为 0） */
  function isHiddenEl(el) {
    if (!el || el.nodeType !== 1) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
    const r = el.getBoundingClientRect();
    return r.width < 1 && r.height < 1;
  }

  /* =========================================================================
   * 1. ConfigStore —— 配置存储（GM 存储 + 按站点记忆 + 导入导出）
   * ========================================================================= */

  const DEFAULT_CONFIG = {
    // —— 过滤 ——
    minWidth: 200,              // 小于该宽度(原始像素)视为小图
    minHeight: 200,             // 小于该高度(原始像素)视为小图
    strictFilter: false,        // 严格模式：连带排除装饰性 background-image
    // —— 触发 ——
    showFloatingButton: true,
    minImagesForButton: 5,      // 页面图片数达到该值才显示悬浮按钮
    whitelistOnly: false,       // 仅在下方白名单站点启用
    whitelist: [],              // 站点白名单（hostname 片段）
    // —— 图片悬停角标（以图定域入口）——
    hoverBadge: true,           // 悬停内容图时显示半透明「看这组」角标
    hoverBadgeOpacity: 0.72,    // 角标不透明度 0.3~1
    hoverBadgeCorner: 'tr',     // 角标位置：tl / tr / bl / br
    hoverBadgeGroupOnly: true,  // 仅当该图所在组含 ≥2 张时才显示（单图不显示）
    // —— 分组浏览 ——
    groupChaining: true,        // 组内翻到边界时，自动续到相邻组（否则仅提示）
    // —— 打包下载 ——
    // fetch 被 CORS 拦截时，是否降级到 GM_xmlhttpRequest 绕过同源策略。
    // 关闭后仅能下载同源/已开放 CORS 的图；开启会由扩展层发出跨域请求。
    crossOriginFallback: true,
    // —— 观感 ——
    adaptTheme: true,           // 自适应论坛原生风格
    thumbnailBar: true,
    thumbSize: 64,              // 缩略图条高度
    animation: true,
    // —— 阅读 ——
    wheelNavigate: true,        // 滚轮翻图
    wheelZoom: false,           // 悬停图片时滚轮改为缩放
    zoomStep: 0.25,
    maxZoom: 8,
    autoplayInterval: 3000,
    // —— 页面联动 ——
    syncPageScroll: true,       // 浏览时把页面同步滚动到当前图片位置
    syncScrollBehavior: 'smooth', // 'smooth' | 'instant'
    dimPage: true,              // 浏览时把网页调暗（不完全黑）
    dimLevel: 0.62,             // 调暗程度 0~0.95（越大越暗）
    // —— 站点自定义规则 ——
    includeSelector: '',        // 只在这些容器内取图（同时是分组边界）
    excludeSelector: '',        // 额外排除这些容器
    dedupeByUrl: false,         // 按 URL 去重：同 URL 全页只收一张（默认按 DOM 节点收）
    disableSiteLightbox: false  // 激活时禁用站点自带灯箱
  };

  /** 合并默认值，保证字段完整 */
  function withDefaults(obj) {
    const out = Object.assign({}, DEFAULT_CONFIG);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (obj[k] !== undefined && obj[k] !== null && typeof obj[k] === typeof DEFAULT_CONFIG[k]) {
          out[k] = obj[k];
        } else if (obj[k] !== undefined && obj[k] !== null && Array.isArray(DEFAULT_CONFIG[k])) {
          out[k] = Array.isArray(obj[k]) ? obj[k] : out[k];
        }
      }
    }
    return out;
  }

  const GM = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, def);
      } catch (e) {}
      try {
        const v = localStorage.getItem(NS + ':' + key);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(key, val);
      } catch (e) {}
      try { localStorage.setItem(NS + ':' + key, JSON.stringify(val)); } catch (e) {}
    },
    del(key) {
      try {
        if (typeof GM_deleteValue === 'function') return GM_deleteValue(key);
      } catch (e) {}
      try { localStorage.removeItem(NS + ':' + key); } catch (e) {}
    }
  };

  const Config = (() => {
    const GLOBAL_KEY = 'config:global';
    const siteKey = (host) => 'config:site:' + (host || location.hostname);

    const listeners = [];
    let cfg = load();

    function load() {
      const globalCfg = GM.get(GLOBAL_KEY, null);
      const siteCfg = GM.get(siteKey(), null);
      // 站点级字段覆盖全局字段
      return withDefaults(Object.assign({}, globalCfg || {}, siteCfg || {}));
    }

    function persist() {
      const siteFields = ['includeSelector', 'excludeSelector', 'minWidth', 'minHeight',
        'disableSiteLightbox', 'strictFilter', 'dedupeByUrl'];
      const globalPart = {};
      const sitePart = {};
      for (const k of Object.keys(cfg)) {
        (siteFields.includes(k) ? sitePart : globalPart)[k] = cfg[k];
      }
      const merged = Object.assign({}, GM.get(GLOBAL_KEY, null) || {}, globalPart);
      GM.set(GLOBAL_KEY, merged);
      GM.set(siteKey(), sitePart);
    }

    return {
      get all() { return cfg; },
      get(k) { return cfg[k]; },
      set(k, v) {
        if (cfg[k] === v) return;
        cfg[k] = v;
        persist();
        listeners.forEach((fn) => { try { fn(k, v); } catch (e) {} });
      },
      /** 批量合并（用于配置面板与导入） */
      merge(obj) {
        Object.assign(cfg, withDefaults(Object.assign({}, cfg, obj)));
        persist();
        listeners.forEach((fn) => { try { fn('*'); } catch (e) {} });
      },
      reset() {
        const keepWhitelist = cfg.whitelist;
        cfg = withDefaults({ whitelist: keepWhitelist });
        GM.set(GLOBAL_KEY, cfg);
        GM.del(siteKey());
        listeners.forEach((fn) => { try { fn('*'); } catch (e) {} });
      },
      onChange(fn) { listeners.push(fn); },
      export() {
        return JSON.stringify({
          _app: NS, _version: 1, exportedAt: new Date().toISOString(),
          host: location.hostname, config: cfg
        }, null, 2);
      },
      import(text) {
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败'); }
        const incoming = data && data.config ? data.config : data;
        if (!incoming || typeof incoming !== 'object') throw new Error('未找到 config 字段');
        this.merge(incoming);
        return true;
      }
    };
  })();

  /* =========================================================================
   * 2. ImagePool —— 图片池（采集 / 过滤 / 动态增量）
   * ========================================================================= */

  /** 自动识别的内容容器选择器（按优先级从具体到宽泛） */
  const AUTO_CONTENT_SELECTORS = [
    '.t_f', '.postmessage', '.message', '.pcb', '.pct',
    '.post_content', '.post-content', '.article-content', '.article_content',
    '.entry-content', '.postbody', '.forum-post-content', '.thread-content',
    'article', '[itemprop="articleBody"]',
    '[class*="post-content"]', '[class*="post_content"]', '[class*="postmessage"]',
    '[class*="article-content"]', '[class*="article_content"]',
    '[class*="thread-content"]', '[class*="topic-content"]', '[class*="content-body"]',
    '[id*="postcontent"]', '[id*="post_content"]', '[id*="postmessage"]'
  ];

  /** 头像 / 表情 / 图标区域选择器 */
  const AVATAR_EMOJI_SELECTORS = [
    '.avatar', '[class*="avatar"]', '[id*="avatar"]',
    '.user-avatar', '.poster-avatar', '.profile-avatar', '.headimg', '.userhead',
    '.smiley', '.emoji', '[class*="emoji"]', '[class*="smiley"]', '[class*="emoticon"]',
    '.emoji-img', '.post-emoticon', '.facetable', '.mgc-img',
    '.icon', '[class*="icon-"]', '[class*="icon_"]',
    '.badge', '.medal', '.rank', '.level', '.user-level',
    '.logo', '[class*="logo"]', '.signature', '.post-signature', '.footnote'
  ];

  /** 文本特征词表（命中即判定为装饰性图片） */
  const TEXT_BLACKLIST = [
    'avatar', 'emoticon', 'smiley', 'emoji', 'icon', 'logo', 'badge', 'medal',
    'level', 'rank', 'sprite', 'blank', 'spacer', 'loading', 'placeholder',
    'touxiang', 'biaoqing', 'headimg', 'userhead', 'stat', 'captcha', 'verify',
    'qrcode', 'erweima', 'bg_', 'shadow', 'arrow', 'btn', 'button'
  ];

  const ImagePool = (() => {
    /** @type {Array<{src:string,key:string,name:string,w:number,h:number,el?:Element,isBg?:boolean}>} */
    let items = [];
    /** 元素 → 池内条目 索引。分组/命中判定都走它，避免每次 items.find() 线性扫 */
    const byEl = new Map();
    /** 元素 → key（去重模式下用；默认按节点收集，允许多节点同 URL） */
    const keySet = new Set();
    /** 已判定为不合格的 key，避免重复计算 */
    const rejected = new Set();
    /** 上一次全量扫描中清理掉的「脱离文档」条目数（调试用） */
    let prunedCount = 0;
    /** 上一次采集用的根节点，同时作为「分组不可跨越的上界」 */
    let rootsCache = [];
    const observers = [];
    const changeCbs = [];

    const emitChange = debounce(() => {
      changeCbs.forEach((fn) => { try { fn(items); } catch (e) {} });
    }, 60);

    function ongChange(fn) { changeCbs.push(fn); }

    /* ------------------------- 过滤判定 ------------------------- */

    function inAvatarEmojiZone(el) {
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        if (node.id === NS + '-root') return false;
        try {
          if (node.matches && node.matches(AVATAR_EMOJI_SELECTORS.join(','))) return true;
        } catch (e) {}
        node = node.parentElement;
        depth++;
      }
      return false;
    }

    function inUserExcludeZone(el) {
      const sel = (Config.get('excludeSelector') || '').trim();
      if (!sel) return false;
      try { return !!(el.closest && el.closest(sel)); } catch (e) { return false; }
    }

    function hitTextBlacklist(el, src) {
      const parts = [
        el.getAttribute('alt') || '',
        el.getAttribute('title') || '',
        el.className && typeof el.className === 'string' ? el.className : '',
        src || ''
      ].join(' ').toLowerCase();
      return TEXT_BLACKLIST.some((w) => parts.includes(w));
    }

    /**
     * 完整判定一张图是否入池
     * @returns {'ok'|'pending'|'reject'}
     */
    function judge(el, src) {
      if (!src) return 'reject';
      if (inUserExcludeZone(el)) return 'reject';
      if (inAvatarEmojiZone(el)) return 'reject';
      if (hitTextBlacklist(el, src)) return 'reject';

      const nw = el.naturalWidth || 0;
      const nh = el.naturalHeight || 0;
      // 尚未加载完成（含懒加载）：不确定，等 load 后再判
      if (nw === 0 || nh === 0) return 'pending';

      const minW = Number(Config.get('minWidth')) || 0;
      const minH = Number(Config.get('minHeight')) || 0;
      if (nw < minW || nh < minH) {
        /* ⚠️ 「当前 src 是占位图」→ 不拒绝，改为 pending。
           典型场景：站点先塞一张 1×1 / 极小灰图占位，滚动到视口时才换成真图。
           此时 naturalWidth 有值但远小于阈值，若直接 reject 就永远错过真图了
           —— 因为站点的替换动作不保证触发 load（有时是直接改属性，甚至同 src 重载）。
           必须等属性变化（MutationObserver 已监听全量 data-*）或 load 后重判。 */
        if (greyPlaceholderCandidate(el, src)) return 'pending';
        return 'reject';
      }
      return 'ok';
    }

    /**
     * 该次 reject 是否「永久」（不随图片后续加载而改变）。
     * 用于决定要不要写进 rejected 缓存：
     *   - 区域/黑名单/协议类 → 永久，可缓存，省去重复判定
     *   - 尺寸不足           → 可变（懒加载、站点放大），**不缓存**
     */
    judge.isPermanent = function (el, src) {
      if (!src) return true;
      if (inUserExcludeZone(el)) return true;
      if (inAvatarEmojiZone(el)) return true;
      if (hitTextBlacklist(el, src)) return true;
      return false;   // 走到这里说明是尺寸类拒绝 → 不缓存
    };

    /**
     * 「像不像图片地址」的启发式判定。
     *
     * 为什么需要启发式：社区懒加载属性名没有规范，data-tfsrc / data-original-src /
     * data-raw / data-ks-lazyload / data-originalUrl… 几十种写法，靠枚举属性名必然漏。
     * 与其补名单（补完又出新名字），不如判断「值长得像不像一个图片地址」。
     */
    function looksLikeImageUrl(s) {
      if (!s) return false;
      const v = String(s).trim();
      if (!v || v.length > 2048) return false;          // 超长几乎必是 base64 data URI
      if (/^data:/i.test(v)) return false;                // 占位用的 data URI，不是真图
      if (/^(javascript|vbscript|file|blob|about):/i.test(v)) return false;
      // 必须是可解析的相对/绝对地址
      if (!/^(https?:)?\/\//i.test(v) && !/^(\.{0,2}\/|\/)/.test(v)) return false;
      // 必须像图片：扩展名或 CDN 图片参数特征
      if (/\.(jpe?g|png|gif|webp|avif|bmp|heic|tiff?)(\?|#|$)/i.test(v)) return true;
      // 无扩展名时靠常见图床/CDN 参数特征兜底。两种写法都要认：
      //   等号式  ?imageView&type=webp  /  ?w=1200&h=800  /  ?thumb
      if (/\?(?:.*&)?(imageview2?|type|format|w|h|width|height|quality|thumb|resize)\s*=/i.test(v)) return true;
      //   斜杠式（阿里云 OSS 风格）?imageView2/1/w/800  /  ?imageMogr2/thumbnail/800x
      if (/\?(?:.*&)?(imageview2?|imagemogr2?|thumbnail)\/\d/i.test(v)) return true;
      if (/\/(thumb|thumbnail|small|middle|big|large|origin|raw|original)\//i.test(v)) return true;
      return false;
    }

    /**
     * 已知的高优先级属性名（先按这些取，命中即用）。
     * 顺序有意义：这些是各框架/ CMS 的约定名，可信度高于启发式扫描的结果。
     */
    const LAZY_ATTR_PRIORITY = [
      'data-original', 'data-src', 'data-lazy-src', 'data-actualsrc',
      'data-echo', 'data-url', 'data-image', 'data-large', 'data-origin'
    ];

    /**
     * 取图片真实地址。
     *
     * 三层策略：
     *   1. 已知高优先级 data-* 属性
     *   2. **全量扫描其余 data-* 属性**（启发式判断值是否像图片地址）——
     *      覆盖 data-tfsrc / data-original-src / data-raw 等几十种社区命名
     *   3. srcset取最大的一张 → currentSrc / src
     *
     * ⚠️ 安全：所有分支返回前统一过 isSafeImageSrc()，拦掉 javascript: / file: 等脏协议。
     */
    function pickSrc(el) {
      const ok = (v) => {
        if (!v) return false;
        const s = String(v).trim();
        if (!s) return false;
        if (s.startsWith('data:image/gif')) return false;   // 常见的追踪像素
        return isSafeImageSrc(s);
      };

      // —— 第 1 层：已知高优先级属性 ——
      for (const a of LAZY_ATTR_PRIORITY) {
        const v = el.getAttribute && el.getAttribute(a);
        if (ok(v)) return String(v).trim();
      }

      // —— 第 2 层：全量扫描 data-* ——
      // ⚠️ 必须**跳过已在上层查过的**，否则低优先级属性会抢在 srcset 之前被选中。
      const seen = new Set(LAZY_ATTR_PRIORITY);
      const attrs = el.attributes;
      if (attrs && attrs.length) {
        for (let i = 0; i < attrs.length; i++) {
          const name = attrs[i].name;
          if (!name || name.slice(0, 5) !== 'data-') continue;
          const low = name.toLowerCase();
          if (seen.has(low) || seen.has(name)) continue;
          seen.add(low);
          const v = attrs[i].value;
          if (!ok(v)) continue;
          if (!looksLikeImageUrl(v)) continue;
          // 占位图特征文件名直接跳过（loading.gif / placeholder.png / spacer.svg）
          if (greyPlaceholderCandidate(el, String(v).trim())) continue;
          // 值里带占位词（data-src="loading/real.jpg"）不排除 —— 后缀匹配已足够保守
          return String(v).trim();
        }
      }

      // —— 第 3 层：srcset / picture / currentSrc ——
      const ss = el.getAttribute && el.getAttribute('srcset');
      if (ss) {
        const best = ss.split(',').map((s) => s.trim().split(/\s+/))
          .filter((p) => p[0] && ok(p[0]))
          .sort((a, b) => parseFloat(b[1] || 0) - parseFloat(a[1] || 0))[0];
        if (best && best[0]) return best[0];
      }
      const cur = el.currentSrc || el.src;
      if (ok(cur) && !String(cur).startsWith('data:image/svg')) return cur;
      return '';
    }

    /* ------------------------- 入池 ------------------------- */

    function add(el, src) {
      const verdict = judge(el, src);
      if (verdict !== 'ok') {
        if (verdict === 'pending') {
          /* 占位图等待真图：**不挂任何观察器**。
             ⚠️ 曾试过给每个元素挂 MutationObserver，思路是「属性一变就重判」，
             但这是错的：几百张图就是几百个 observer 实例，滚动时批量换 src
             会同时触发几百个回调，实测明显掉帧。而且下面的 load 监听已经覆盖了
             「图片真的换了地址并加载完成」这一主路径。
             现在依赖三条既有通道，无需额外开销：
               1. load 事件——站点改 src 后浏览器加载真图，会触发
               2. 全局 MutationObserver —— 已把 data-* 高频命名纳入 attributeFilter，
                  属性变化时置 needFull；虽然全量扫描低频，但配合下一条兜底
               3. 15s 兜底全量扫描 —— 保证最坏情况下也会收敛
             （代价：从占位图切到真图最多有 15s 延迟，这是可接受的取舍；
               想要立即生效可菜单「↻ 重新扫描页面图片」。） */
          if (!el.__fivHooked) {
            el.__fivHooked = true;
            const onLoad = () => {
              const s = pickSrc(el);
              const k = normalizeKey(s);
              if (k) { rejected.delete(k); add(el, s); }
            };
            el.addEventListener('load', onLoad, { once: true });
            el.addEventListener('error', () => { el.__fivFailed = true; }, { once: true });
          }
          // 记下当前占位地址，便于排障与后续逻辑判断
          if (!el.__fivPendingSrc) el.__fivPendingSrc = src;
        } else if (verdict === 'reject' && judge.isPermanent(el, src)) {
          /* ⚠️ 只有「确定性」的拒绝才写入 rejected（头像/表情区、排除区、
             文本黑名单、非图片协议）——这些不会因为图片后续加载而改变。
             而「尺寸不足」是**延迟可变的**：懒加载图一开始 naturalWidth=0、
             或小图被站点放大后可能变大，若一并缓存，就会永久漏掉。
             所以尺寸类拒绝不进 rejected，每次扫描重新判（成本很低）。 */
          const k = normalizeKey(src);
          if (k) rejected.add(k);
        }
        return false;
      }

      const key = normalizeKey(src);
      if (!key || rejected.has(key)) return false;

      /* 去重策略：
         · dedupeByUrl = true  → 同一图片 URL 全页只收一张（旧行为，省内存）
         · 默认 false          → 按 **DOM 节点** 收集：同一 URL 出现在两个帖子里
                                 就收两条。若全局按 URL 去重，第二张会被吞掉，
                                 导致那个帖子「只剩一张图」→ 分组解析失败 → 退回全局。
         这是「去重策略与分组模型耦合」的直接修复。 */
      if (Config.get('dedupeByUrl') && keySet.has(key)) return false;
      // 同一节点重复扫描时不重复入池
      if (el && byEl.has(el)) return false;

      const w = el.naturalWidth || 0;
      const h = el.naturalHeight || 0;
      const name = guessName(src, '图片 ' + (items.length + 1));

      const item = { src, key, name, w, h, el, isBg: !!el.__fivBg };
      items.push(item);
      if (el) {
        byEl.set(el, item);
        // 已定案：停掉该元素上pending 期的属性观察，避免无谓的重判回调
        el.__fivDone = true;
        if (el.__fivPendingSrc) el.__fivPendingSrc = src;
      }
      keySet.add(key);
      emitChange();
      return true;
    }

    /* ------------------------- 增量扫描 ------------------------- */

    /**
     * 只扫描「新加到页面里的节点」，把它们并入池中。
     *
     * 为什么需要：
     *   论坛/瀑布流页面靠滚动不断注入新楼层，如果每次都全量 scanNow()，
     *   代价是「遍历整棵 DOM × 计算每个元素的 background-image」
     *   （getComputedStyle 是强制样式计算，最贵的部分）。图片上千后，
     *   每次全量扫描可能吃掉几十毫秒，滚动时反复触发会明显掉帧。
     *
     * 正确性约束（与全量扫描对齐）：
     *   · 新增节点可能是一整棵子树 → 必须 querySelectorAll 展开
     *   · 必须**按文档顺序**落池，否则会出现「1 楼的图排到 3 楼之后」
     *     但由于追加的节点天然位于现有内容之后，这里只需对「本批新增候选」
     *     排序即可；与已入池条目的相对顺序由 add() 的追加语义保证。
     *   · 已入池节点会被 byEl 挡掉，重复触发安全。
     *
     * @param {Node[]} nodes 本次新增的节点（MutationRecord.addedNodes 汇总）
     * @returns {number} 新增入池数量
     */
    function scanNodes(nodes) {
      if (!nodes || !nodes.length) return 0;

      const candByEl = new Map();

      /* ⚠️ 准入判定的粒度是「本次新增的顶层节点」，不是每个后代元素。
         原因：新注入的往往是一整块容器（一个 .message 楼层）。
         容器本身可能命中内容选择器（准入通过），但它内部的 <img> 的
         parentElement 是那个新容器、不是采集根，逐个判定会全军覆没。
         正确做法：顶层节点过一次准入，其内部所有元素一律继承该结论。 */
      const acceptedRoots = [];
      for (const n of nodes) {
        if (n.nodeType !== 1) continue;
        if (isWithinCollectScope(n)) acceptedRoots.push(n);
      }
      if (!acceptedRoots.length) return 0;

      const considerEl = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (byEl.has(el)) return;                // 已入池
        if (el.tagName === 'IMG') {
          if (isHiddenEl(el)) return;
          const src = pickSrc(el);
          if (src) candByEl.set(el, { el, src, isBg: false });
          return;
        }
        // 背景图容器
        if (el.__fivBg) return;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none' || bg.indexOf('url(') !== 0) return;
        const m = /url\(["']?(.*?)["']?\)/.exec(bg);
        if (!m || !m[1] || m[1].startsWith('data:')) return;
        candByEl.set(el, { el, src: m[1], isBg: true });
      };

      for (const root of acceptedRoots) {
        considerEl(root);                                   // 顶层节点自身
        if (root.querySelectorAll) {
          for (const el of root.querySelectorAll('img')) considerEl(el);
          // 背景图只在本批子树里找，避免又退化成全页扫描
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName !== 'IMG') considerEl(el);
          }
        }
      }

      if (!candByEl.size) return 0;

      let added = 0;
      const merged = sortByDocumentOrder(Array.from(candByEl.keys()))
        .map((el) => candByEl.get(el));

      for (const cand of merged) {
        const { el, src, isBg } = cand;
        if (isBg) {
          if (Config.get('strictFilter') && inAvatarEmojiZone(el)) continue;
          if (greyPlaceholderCandidate(el, src)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 120) continue;
          if (inAvatarEmojiZone(el) || inUserExcludeZone(el) || hitTextBlacklist(el, src)) continue;
          el.__fivBg = true;
          const w = el.naturalWidth || Math.round(r.width);
          const h = el.naturalHeight || Math.round(r.height);
          if (judgeBg(el, src, w, h) !== 'ok') continue;
          if (addBg(el, src, w, h)) added++;
        } else {
          if (add(el, src)) added++;
        }
      }

      if (added) emitChange();
      return added;
    }

    /* ------------------------- 全量扫描 ------------------------- */

    /**
     * 全量扫描当前页面。
     *
     * ⚠️ 顺序正确性的关键（历史 bug 修复）：
     * 必须先把所有候选节点（img + 背景图容器）**跨全部 root 汇总到一个数组**，
     * 再用 sortByDocumentOrder() 按文档顺序（即页面里图片实际的摆放位置）排序，
     * 最后才按顺序 add()。
     *
     * 曾经的错误写法是「逐个 root 边查边 add」——由于 collectRoots 返回多个 root、
     * 且每个 root 内 img 先于背景图，结果会按「root × 类型」分组，
     * 出现 1 楼的图排到 3 楼之后这种错乱。
     */
    function scanNow() {
      let added = 0;
      const roots = collectRoots();
      rootsCache = roots;      // 供分组用：分组边界不得跨越采集根

      /* 有节点被移除过 → 顺手清理池内「已脱离文档」的条目。
         不单独为移除做一次扫描（那是另一遍全量），而是搭这次全量的便车。
         判据：条目的 el 不再与文档相连（isConnected 为 false）。 */
      if (fullScanNeeded) {
        prunedCount = pruneDetached();
        fullScanNeeded = false;
      }

      // ---- 阶段 1：汇总候选（不落池，只收集 DOM 节点 + 来源信息）----
      const candByEl = new Map();   // Element → { el, src, isBg }

      for (const root of roots) {
        if (!root.querySelectorAll) continue;

        // 1) img 标签
        const imgs = root.querySelectorAll('img');
        for (const img of imgs) {
          if (isHiddenEl(img)) continue;
          const src = pickSrc(img);
          if (src && !candByEl.has(img)) candByEl.set(img, { el: img, src, isBg: false });
        }

        // 2) background-image（论坛常用 CSS 贴图）
        const all = root.querySelectorAll('*');
        let budget = 4000; // 防止极端页面卡死
        for (const el of all) {
          if (budget-- <= 0) break;
          if (el.tagName === 'IMG') continue;
          if (candByEl.has(el)) continue;
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === 'none' || bg.indexOf('url(') !== 0) continue;
          const m = /url\(["']?(.*?)["']?\)/.exec(bg);
          if (!m || !m[1]) continue;
          const src = m[1];
          if (src.startsWith('data:')) continue;
          candByEl.set(el, { el, src, isBg: true });
        }
      }

      /* ---- 阶段 2：按文档顺序合并排序（img 与背景图混排，还原页面真实位置）----
         ⚠️ 性能：旧写法在 map 里对每个元素做 imgCands.find() || bgCands.find()，
            图片上千时是 O(n²)。这里改为 Map 一次建档、O(1) 回查。 */
      const merged = sortByDocumentOrder(Array.from(candByEl.keys()))
        .map((el) => candByEl.get(el));

      // ---- 阶段 3：按顺序落池 ----
      for (const cand of merged) {
        const { el, src, isBg } = cand;
        if (isBg) {
          /* 背景图：沿用原过滤规则。
             ⚠️ 注意这里**不再构造 fake 对象**——旧写法把 fake 当作 items[].el 存进池，
               而 resolveGroup/itemOf/scope.el.contains 全都依赖「真实 DOM 节点」，
               于是背景图在分组体系里是断链节点（contains 永远为 false）。
               现在直接存真实元素，并打 __fivBg 标记。 */
          if (Config.get('strictFilter') && inAvatarEmojiZone(el)) continue;
          if (greyPlaceholderCandidate(el, src)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 120) continue;
          if (inAvatarEmojiZone(el) || inUserExcludeZone(el) || hitTextBlacklist(el, src)) continue;

          el.__fivBg = true;
          // judge() 读 naturalWidth/naturalHeight，背景图没有 → 用测得的显示尺寸补上
          const w = el.naturalWidth || Math.round(r.width);
          const h = el.naturalHeight || Math.round(r.height);
          const verdict = judgeBg(el, src, w, h);
          if (verdict !== 'ok') continue;
          if (addBg(el, src, w, h)) added++;
        } else {
          if (add(el, src)) added++;
        }
      }

      if (added) emitChange();
      return added;
    }

    /** 背景图专用的入池（judge 逻辑与 add 一致，但尺寸来自 getBoundingClientRect） */
    function judgeBg(el, src, w, h) {
      if (!src) return 'reject';
      if (inUserExcludeZone(el)) return 'reject';
      if (inAvatarEmojiZone(el)) return 'reject';
      if (hitTextBlacklist(el, src)) return 'reject';
      const minW = Number(Config.get('minWidth')) || 0;
      const minH = Number(Config.get('minHeight')) || 0;
      if (w < minW || h < minH) return 'reject';
      return 'ok';
    }

    function addBg(el, src, w, h) {
      const key = normalizeKey(src);
      if (!key || rejected.has(key)) return false;
      if (Config.get('dedupeByUrl') && keySet.has(key)) return false;
      if (byEl.has(el)) return false;
      const item = { src, key, name: guessName(src, '图片 ' + (items.length + 1)), w, h, el, isBg: true };
      items.push(item);
      byEl.set(el, item);
      keySet.add(key);
      emitChange();
      return true;
    }

    function greyPlaceholderCandidate(el, src) {
      // 常见 1x1 / 透明占位图
      if (/(^|\/)(blank|spacer|loading|placeholder|grey|gray)\.(gif|png|jpg|jpeg|webp)/i.test(src)) return true;
      return false;
    }

    /**
     * 剔除池内「已脱离文档」的条目（页面滚走了 / 楼层被回收）。
     *
     * 为什么需要：瀑布流/虚拟列表类站点会把滚出视口的楼层从 DOM 移除。
     * 若不清理，池里会堆一堆取不到的「幽灵图」——缩略图条越滚越长、
     * 分组计数虚高、浏览到它们必然加载失败。
     *
     * 判据用 isConnected（原生、O(1)），比 `document.contains(el)` 更直接；
     * 对老浏览器兜底用 documentElement.contains。
     */
    function pruneDetached() {
      const before = items.length;
      const kept = [];
      for (const it of items) {
        const el = it.el;
        const alive = !el
          ? true                                    // 无 el 的条目（理论上不存在）保留
          : (typeof el.isConnected === 'boolean'
              ? el.isConnected
              : (document.documentElement && document.documentElement.contains(el)));
        if (alive) { kept.push(it); continue; }
        if (el) { byEl.delete(el); el.__fivBg = false; }
        keySet.delete(it.key);
      }
      if (kept.length === before) return 0;
      items = kept;
      emitChange();
      return before - kept.length;
    }

    /**
     * 确定扫描根节点。
     *
     * ⚠️ 顺序正确性的关键：必须「一次性」用合并选择器查询，
     * 让 querySelectorAll 按**文档顺序**返回结果。
     * 若改成「逐个选择器查、再拼接」，结果会按选择器优先级分组，
     * 出现 1 楼的图排到 3 楼后面这种错乱（历史 bug）。
     */
    function collectRoots() {
      const include = (Config.get('includeSelector') || '').trim();
      if (include) {
        try {
          // closest+matches 的方式保证结果按文档顺序
          const list = Array.from(document.querySelectorAll(include));
          if (list.length) return list;
        } catch (e) { warn('自定义 includeSelector 无效：', e.message); }
      }

      // 合并成一条选择器，交由浏览器按文档顺序返回
      let all;
      try {
        all = Array.from(document.querySelectorAll(AUTO_CONTENT_SELECTORS.join(',')));
      } catch (e) {
        all = [];
      }

      const roots = all.filter((el) => !isHiddenEl(el));
      if (roots.length) {
        // 去掉被其它候选容器包含的嵌套项，保留最外层
        const top = roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)));
        // 候选容器里的图片太少，说明识别不准，退回全页扫描
        const cnt = top.reduce((n, r) => n + r.querySelectorAll('img').length, 0);
        if (cnt >= 3) return top;
      }
      return [document.body];
    }

    /**
     * 按「文档顺序」排序图片元素。
     * compareDocumentPosition 是浏览器原生实现，比手动算 offsetTop
     * 更可靠（不受定位方式、滚动容器影响）。
     */
    function sortByDocumentOrder(nodes) {
      return nodes.sort((a, b) => {
        if (a === b) return 0;
        const rel = a.compareDocumentPosition(b);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    }

    /* ------------------------- 动态增量 ------------------------- */

    /** 移除节点导致的「可能需要全量重扫」标记：等下次兜底扫描或手动刷新时执行 */
    let fullScanNeeded = false;
    function markFullScanNeeded() { fullScanNeeded = true; }

    function startObserve() {
      // 预先拼好选择器字符串：MutationObserver 回调里每条记录都会用到，
      // 放循环外避免反复 join 造成的无谓开销
      const CONTENT_SEL = AUTO_CONTENT_SELECTORS.join(',');
      try {
        const mo = new MutationObserver((records) => {
          const added = [];
          let needFull = false;
          for (const rec of records) {
            if (rec.type === 'attributes') {
              /* ⚠️ 属性变化（如懒加载站点把 data-tfsrc 从占位图换成真图）
                 必须**立即**重判，不能只置 needFull 等 15s 兜底 ——
                 否则用户滚到那儿要等十几秒才看到图出现。
                 做法：把该元素的**最近内容容器**（而非元素本身）送进增量扫描。
                 为什么不是直接送元素：scanNodes 的准入判定
                 isWithinCollectScope() 是按「顶层节点」判的，
                 单独一个 <img> 往往不匹配任何内容选择器 → 整批被拒。
                 而它所在的 .message / .post 容器才是判定的正确粒度。 */
              const el = rec.target;
              if (el && el.nodeType === 1 && !el.__fivDone) {
                added.push(el.closest && el.closest(CONTENT_SEL) || el);
              }
              continue;
            }
            /* 节点被移除 → 池内可能残留已不在 DOM 里的条目。
               不立刻全量重扫（代价高），标记为「需要一次全量」，
               由低频兜底扫描统一处理。 */
            if (rec.removedNodes && rec.removedNodes.length) needFull = true;
            if (rec.addedNodes && rec.addedNodes.length) {
              for (const n of rec.addedNodes) added.push(n);
            }
          }
          if (added.length) scanAddedDebounced(added);
          if (needFull) markFullScanNeeded();
        });
        mo.observe(document.body || document.documentElement, {
          childList: true, subtree: true,
          /* ⚠️ 不要监听 'style'！
             脚本自身的 HoverBadge/Viewer 会频繁改 el.style（跟随鼠标定位、
             缩放布局），一旦把 style 纳入监听，就形成
             「mousemove → 改 style → Observer 触发 → 全页 scanNow()」的
             自触发死循环，图片多的页面会明显吃 CPU。 */
          attributes: true,
          /* ⚠️ 监听哪些属性变化要跟 pickSrc 的采集面一致。
             pickSrc 已改为全量扫描 data-*（启发式），但若这里只监听 4 个名字，
             就会出现「扫描能看到、变化却收不到通知」的不对称 ——
             data-tfsrc 从无到有时我们完全不知情，等到 15s 兜底扫描才补上。
             ⚠️ 不能去掉 attributeFilter 改成监听全部属性：那会让站点给元素挂的
             任何属性（data-state / aria-* / 悬停态标记）都触发回调，
             图片多的页面会明显吃 CPU。这里按需列举已知高频命名，
             其余靠 15s 兜底扫描兜住。 */
          attributeFilter: [
            'src', 'srcset', 'data-src', 'data-original', 'data-lazy-src',
            'data-actualsrc', 'data-echo', 'data-url', 'data-image',
            'data-large', 'data-origin', 'data-tfsrc', 'data-original-src',
            'data-raw', 'data-ks-lazyload', 'data-originalurl', 'data-img',
            'data-imageurl', 'data-srcset', 'data-lazy'
          ]
        });
        observers.push(mo);
      } catch (e) { warn('MutationObserver 启动失败', e); }

      /* 兜底定时扫描：应对某些论坛延迟注入 / IntersectionObserver 懒加载。
         ⚠️ 频率权衡：这条是全量扫描，getComputedStyle 逐元素算 background-image
            相当贵。增量扫描已经覆盖了「addedNodes 注入新图」这个主要场景，
            所以这里只做低保真兜底 —— 15s 一次足矣，不必 2.5s。
            （需要即时刷新时，菜单里的「↻ 重新扫描页面图片」可手动触发。） */
      const timer = setInterval(() => {
        if (document.hidden) return;
        scanNow();
        fullScanNeeded = false;
      }, 15000);
      observers.push({ disconnect: () => clearInterval(timer) });
    }

    /** 移除节点导致的「可能需要全量重扫」标记：等到下次兜底扫描或手动刷新时执行 */

    /** 增量扫描（防抖合并同批 addedNodes） */
    const scanAddedDebounced = (() => {
      let timer = null;
      let pending = [];
      return (nodes) => {
        for (const n of nodes) pending.push(n);
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          const batch = pending;
          pending = [];
          if (document.hidden) return;
          try { scanNodes(batch); } catch (e) { warn('增量扫描失败，回退全量', e); scanNow(); }
        }, 300);
      };
    })();

    function destroy() {
      observers.forEach((o) => { try { o.disconnect(); } catch (e) {} });
      observers.length = 0;
    }

    /* ------------------------- 以图定域（图片分组） -------------------------
     * 由「用户触发的那张图」反推出它所属的图片组。
     *
     * 设计目标：不依赖特定站点语义类名，做成通用能力
     *   - 论坛：一层楼 / 一帖
     *   - 电商：一个商品图集
     *   - 图文：正文一段 / 一个 gallery
     *
     * ⚠️ v1.3 重写要点（旧算法的核心缺陷）
     *   旧代码里 `bestHint` 可以**跨越** `best`：只要祖先带 gallery/post/section
     *   之类的类名且含 ≥2 张图，就无条件压过「最近祖先」。于是
     *       post
     *       ├── gallery A (A1,A2)
     *       └── gallery B (B1,B2)
     *   点 A1 会得到整个 post（4 张），而不是 gallery A（2 张）。
     *   这类「保守估计」在泛化选择器（article/section/li/figure）加入后
     *   变成**主动扩大图片池**——越往选择器里塞站点特征，误合并越严重。
     *
     *   新原则：
     *     ① **最近祖先（含 ≥2 张）是默认答案，永不被跨越**；
     *     ② 语义提示只在两种情形介入：
     *          · best 自身就是语义容器 → 采用（本就是同一层）
     *          · best 内只有 1 张图     → 向外借显式图集语义作边界
     *     ③ 分组边界**不得跨越采集根**（collectRoots 的结果）——让
     *        「哪些图进池」与「哪些图同组」共用同一套框架，修复
     *        用户已用 includeSelector 划出独立内容块、却被外层 article
     *        重新合并的问题。
     * 兜底：结果等于全页图片数 → 返回 null（调用方回退全局浏览）。
     */

    /**
     * 「真实图集」语义：命中即大概率就是一组图（gallery / album / 轮播）。
     * 只用于给分组**定界/命名**，不再作为「扩大范围」的依据。
     */
    const GROUP_SEMANTIC_SELECTORS = [
      '[class*="gallery"]', '[id*="gallery"]',
      '[class*="image-list"]', '[class*="img-list"]', '[class*="imagelist"]',
      '[class*="album"]', '[id*="album"]',
      '[class*="photo-list"]', '[class*="pic-list"]', '[class*="pics"]',
      '[class*="swiper"]', '[class*="carousel"]', '[class*="slider"]',
      '[class*="lightbox"]', '[class*="pswp"]', '[class*="photoset"]'
    ];

    /**
     * 「内容框架」语义：一楼 / 一帖 / 一个正文块，与采集范围同源。
     * ⚠️ 这些在页面里极其常见，**只有在它恰好就是最近祖先时才认组**，
     *    绝不能让它们反向吞并内部的图集。
     */
    const CONTENT_ROOT_SELECTORS = [
      '[class*="post"]', '[class*="floor"]', '[class*="reply"]',
      '.message', '.postmessage', '.t_f', '.pcb',
      'article', 'section', 'li'
    ];

    /* 说明：figure 故意不在此列 —— <figure> 常与 <figcaption> 一对一，
       天然只含 1 张图，作「组边界」没有意义，它只在采集范围里出现。 */

    let semanticMatcher = null;
    let contentMatcher = null;
    function ensureMatchers() {
      if (semanticMatcher !== null && contentMatcher !== null) return;
      try { semanticMatcher = GROUP_SEMANTIC_SELECTORS.join(','); } catch (e) { semanticMatcher = ''; }
      try { contentMatcher = CONTENT_ROOT_SELECTORS.join(','); } catch (e) { contentMatcher = ''; }
    }

    function matchAny(el, sel) {
      if (!el || el.nodeType !== 1 || !sel) return false;
      try { return !!(el.matches && el.matches(sel)); } catch (e) { return false; }
    }

    /** 真实图集语义容器（gallery / album / 轮播） */
    function isSemanticGroup(el) {
      ensureMatchers();
      if (!el || el === document.body || el === document.documentElement) return false;
      return matchAny(el, semanticMatcher);
    }

    /** 内容框架容器（一楼 / 一帖 / 正文块） */
    function isContentRoot(el) {
      ensureMatchers();
      if (!el || el === document.body || el === document.documentElement) return false;
      return matchAny(el, contentMatcher);
    }

    /** 该元素自身是否具备「内容框架」语义（图集容器 或 内容根） */
    function looksLikeContentContainer(el) {
      if (!el || el.nodeType !== 1) return false;
      return isSemanticGroup(el) || isContentRoot(el);
    }

    /**
     * 该 el 内部「已在图片池里」的条目。
     * 用 byEl 索引 + contains 双通道：背景图容器（自身即入池元素）也能正确命中。
     * 复杂度由「每组都全池扫」降为「按索引遍历」，是分组性能的主要来源。
     */
    function poolItemsWithin(el) {
      if (!el || !el.contains) return [];
      const out = [];
      const self = byEl.get(el);            // 1) 自身即入池元素（背景图容器）
      if (self) out.push(self);
      for (const [node, item] of byEl) {    // 2) 内部的入池元素
        if (node === el) continue;
        if (el.contains(node)) out.push(item);
      }
      if (out.length > 1) {                 // 恢复池内顺序（= DOM 顺序）
        out.sort((a, b) => items.indexOf(a) - items.indexOf(b));
      }
      return out;
    }

    /**
     * 该元素是否落在「某个采集根之内」——用于**分组遍历的上界**。
     *
     * 语义：分组只在一个内容框架内部进行。从图片向上走时，
     *       一旦某个祖先已经不在任何采集根里（说明爬到了框架之外，
     *       如 body / 页面级 wrapper），就停止。
     *
     * ⚠️ 注意这里**不能**用于增量扫描的准入判定 ——
     *    增量场景下新注入的容器本身就是新的采集根，不在旧 rootsCache 里，
     *    用"是否被旧根包含"会把它误杀。增量准入另用 isWithinCollectScope()。
     */
    function withinAnyRoot(el) {
      if (!rootsCache.length) return true;
      if (!el || el.nodeType !== 1) return false;
      for (const r of rootsCache) {
        if (r === el) return true;
        if (r.contains && r.contains(el)) return true;   // el 在某个根之内
        if (el.contains && el.contains(r)) return true;  // el 是某个根的祖先（爬到根之上）
      }
      return false;
    }

    /**
     * 增量扫描的准入判定：新节点是否属于「内容区」。
     *
     * 与 withinAnyRoot 的区别：这里允许「新增的兄弟框架」。
     * 判据（任一满足即可）：
     *   a) 落在某个采集根之内 / 是某个根的祖先；
     *   a2) 被「两个及以上采集根」共同覆盖 —— 说明它和这些根处在同一个
     *       公共外壳之下（如 body）。这是排除侧边栏 / 广告栏的关键：
     *       这类容器从来不会被当作内容区。
     *   b) 自身命中内容容器选择器（如新追加的一个 .message 楼层）；
     *   c) 自身是「兄弟框架」——与某个采集根同级（且父级非 body/html），
     *       自身**也**具备图集 / 内容框架语义（looksLikeContentContainer）。
     *
     * ⚠️ 关键：c) 不能退化成「只是和某根共享父级」。
     *    否则 body 底下任意新增的侧边栏 / 广告容器都会被误收
     *    （它们在 DOM 里同样与 .message 共享 body 这个父级）。
     *    必须①要求候选自身具备内容容器语义，②排除 body/html 这一层公共外壳。
     *
     * 保守取向：宁可漏收（等下一次全量兜底扫描补上），也不误收侧边栏广告。
     *       毕竟兜底扫描每 15s 会跑一次全量。
     */
    function isWithinCollectScope(el) {
      if (!el || el.nodeType !== 1) return false;
      if (!rootsCache.length) return true;
      // 采集根退化为 body/html 时（内容容器识别失败或图片总数 < 3 的兜底路径），
      // 「在采集范围内」对任何 body 子树都恒为真 —— 此时准入只看内容语义，
      // 不能拿"是否在根之内"当判据，否则侧边栏广告会被无差别放行。
      const degenerate =
        rootsCache.length === 1 &&
        (rootsCache[0] === document.body || rootsCache[0] === document.documentElement);
      if (!degenerate && withinAnyRoot(el)) return true;
      // a2) 被多个采集根共同覆盖 → 与它们同处公共外壳，不是内容区
      let coveringRoots = 0;
      for (const r of rootsCache) {
        if (r.contains && r.contains(el)) coveringRoots++;
      }
      if (coveringRoots >= 2) return false;
      // b) 新增节点自身就是内容容器（如新追加的一个 .message 楼层）
      try {
        if (el.matches && el.matches(AUTO_CONTENT_SELECTORS.join(','))) return true;
      } catch (e) {}
      // c) 新增节点与某个采集根同级，且自身也具备内容框架语义
      if (!looksLikeContentContainer(el)) return false;
      if (degenerate) return true;   // 根就是 body → 同级即内容区，已被 c) 的语义约束过滤
      for (const r of rootsCache) {
        const p = r.parentElement;
        if (!p || p === document.body || p === document.documentElement) continue;
        if (p === el.parentElement) return true;
      }
      return false;
    }

    /** 该元素是否就是「页面级根」——只有这种容器覆盖全池才视为「没有局部组」 */
    function isPageLevelRoot(el) {
      if (!el) return true;
      if (el === document.body || el === document.documentElement) return true;
      // 采集根恰好只有一个、且它就是当前元素 → 也视为页面级（整页就这一个框架）
      if (rootsCache.length === 1 && rootsCache[0] === el) return true;
      return false;
    }

    /**
     * 该容器是否「横跨了多个同级的兄弟内容单元」。
     *
     * 这是区分两种「覆盖全池」的关键：
     *   · `.thread` 里装着 postA / postB / postC —— 它横跨多个楼层，
     *     对某一张图来说它只是「页面级的公共外壳」，不该当成这一张图的组；
     *   · `.floorBg` 里装着 1 张 img + 1 张背景图 —— 它们是同一个内容单元内的
     *     两张图，天然就该同组，即便这个容器恰好装下了全页所有图片。
     *
     * 判据：容器的直接子级里，含有池内图片的**兄弟元素**数量 ≥ 2，
     *       且这些兄弟各自只是局部（不互相包含）→ 说明容器是「并列单元的集合」。
     */
    function spansSiblingUnits(el) {
      if (!el || !el.children) return false;
      let units = 0;
      for (const child of el.children) {
        if (child.nodeType !== 1) continue;
        if (byEl.has(child)) { units++; continue; }     // 子级本身就是入池元素
        // 子级内部含图，且这个子级不是另一个「已入池容器」
        let has = false;
        for (const [node] of byEl) { if (child.contains(node)) { has = true; break; } }
        if (has) units++;
        if (units >= 2) return true;
      }
      return false;
    }

    /**
     * 解析分组。返回 { el, items:[...], reason } 或 null。
     */
    function resolveGroup(el) {
      if (!el || !el.closest) return null;
      const total = items.length;
      if (total < 2) return null;

      // 从图片本身起，逐级向上（含自身，以兼容 background 容器场景）
      let node = el;
      let best = null;        // 最近祖先：第一个「含 ≥2 张」的容器
      let outer = null;       // 最外层「仍未覆盖全页」的容器 → 收敛上界
      let depth = 0;

      while (node && node.nodeType === 1 && depth < 32) {
        if (node === document.body || node === document.documentElement) break;
        if (node.id === NS + '-root') break;
        // 采集根是分组上界：越过它就不再算同一个「框架」
        if (!withinAnyRoot(node)) break;

        const inGroup = poolItemsWithin(node);
        const n = inGroup.length;

        /* 注意判据是 n >= 2，**不再要求 n < total**。
           旧写法要求「小于全池」，导致一种典型误判：
             页面只有 2 张图且它们本就同属一个局部容器（如一个楼层内 1 张 img + 1 张背景图），
             此时 n === total，best 永远建不起来 → 分组失败、只能退回全局。
           「是否等于全页」这个判断改到**决议之后**，用 isPageLevelRoot() 
           区分「真正的页面级容器」与「恰好装下全部图片的局部容器」。 */
        if (n >= 2) {
          if (!best) best = { el: node, items: inGroup };
          outer = { el: node, items: inGroup };   // 持续覆盖 → 收敛到最外层
        }

        node = node.parentElement;
        depth++;
      }

      if (!best) return null;

      /* ---- 决议：默认采用最近祖先；只允许「向内收紧」，绝不向外扩张 ----
         这正是修复点：旧代码这里是 `bestHint && ... ? bestHint : best`，
         一个带 post/section 类名的外层祖先会越过 best，把多个 gallery 合并。 */
      let pick = best;

      if (outer && outer.items.length < best.items.length) {
        pick = outer;
      }

      /* best 自身命中语义容器（图集 / 楼层）→ 它就是最合适的「一组图」。
         注意仍不做任何向上扩张，所以两个并列 gallery 不会合并。 */
      if (best.el && (isSemanticGroup(best.el) || isContentRoot(best.el))) {
        pick = best;
      }

      /* 兜底：候选组覆盖了全池时，要区分两种情形——
           · 它是页面级/横跨多个兄弟单元的「公共外壳」→ 不算组，退回全局
           · 它本身就是一个内容单元（如一层楼里 1 张 img + 1 张背景图）
             → 是合法的组，即便恰好装下了全页所有图片 */
      if (pick.items.length >= total) {
        if (isPageLevelRoot(pick.el) || spansSiblingUnits(pick.el)) return null;
      }

      return { el: pick.el, items: pick.items, reason: pick === best ? 'ancestor' : 'tightest' };
    }

    /**
     * 对外：给一个元素，返回其所属图片组（数组）与描述，供「按组浏览」使用。
     * 组内 < 2 张时返回 null，调用方应回退全局。
     */
    function groupOf(el) {
      const g = resolveGroup(el);
      if (!g || g.items.length < 2) return null;
      const totalN = items.length;
      return {
        items: g.items,
        size: g.items.length,
        total: totalN,
        reason: g.reason,
        /** 组覆盖了整页（与全局一致） */
        isWholePage: g.items.length >= totalN
      };
    }

    /**
     * 枚举页面上的「所有图片组」，供树形目录使用。
     *
     * 做法：按池内顺序遍历每张图 → 用 resolveGroup() 求它的组 →
     *      用「组的首图 key」作为组身份去重，保持文档顺序。
     * 不额外引入新的分组判据 —— 树形目录展示的就是「以图定域」实际
     * 会给用户看到的分组，两处口径完全一致（否则侧栏与浏览会不一致）。
     *
     * @param {number} minSize 只收录 ≥ 该张数的组（默认 2，单图无浏览意义）
     * @returns {Array<{id:string,items:Array,size:number,el:Element|null,label:string,startIndex:number}>}
     */
    function groups(minSize) {
      const min = minSize == null ? 2 : minSize;
      const out = [];
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.el) continue;
        const g = resolveGroup(it.el);
        if (!g || !g.items || g.items.length < min) continue;
        const id = g.items[0].key;
        if (seen.has(id)) continue;
        seen.add(id);
        // 该组在池内的起始下标，供「跳到该组」用
        const startIndex = items.indexOf(g.items[0]);
        out.push({
          id,
          items: g.items,
          size: g.items.length,
          el: g.el || null,
          label: labelForGroup(g.el, out.length + 1),
          startIndex: startIndex < 0 ? 0 : startIndex
        });
      }
      return out;
    }

    /** 为分组生成可读标签：优先用容器的语义线索，退化到序号 */
    function labelForGroup(el, ordinal) {
      if (el && el.nodeType === 1) {
        // 1) data-* 标题类属性
        for (const a of ['data-title', 'data-name', 'data-label', 'aria-label', 'title']) {
          const v = el.getAttribute && el.getAttribute(a);
          if (v && v.trim()) return v.trim().slice(0, 40);
        }
        // 2) 楼层号 / 帖子号
        const idm = (el.id || '').match(/(?:post|floor|reply|p)?\s*(\d{1,4})/i);
        if (idm) return '第 ' + idm[1] + ' 组';
        // 3) 容器类名里挑一个最有信息量的词
        const cls = String(el.className || '').split(/\s+/)
          .filter((c) => c && !/^(fiv|post|thread|message|pcb|pct|t_f)$/i.test(c))
          .sort((a, b) => b.length - a.length)[0];
        if (cls && cls.length >= 3) {
          const clean = cls.replace(/[-_]+/g, ' ').trim();
          if (clean) return clean.slice(0, 40);
        }
      }
      return '第 ' + ordinal + ' 组';
    }

    return {
      get items() { return items; },
      get count() { return items.length; },
      scanNow, scanNodes, startObserve, destroy,
      onChange: ongChange,
      /** 清理已脱离文档的条目（返回清理数量） */
      prune: pruneDetached,
      /** 上一次全量扫描清理掉的数量 */
      get pruned() { return prunedCount; },
      /** 以图定域：解析某元素所属图片组 */
      groupOf,
      /** 枚举全部图片组（树形目录数据源） */
      groups,
      /** 判断某个元素是否属于图片池（用于右键命中测试） */
      itemOf(el) {
        return byEl.get(el) || null;
      },
      /** 采集根列表（分组边界，调试用） */
      get roots() { return rootsCache.slice(); },
      /** 重建索引（清池后调用） */
      reset() {
        items = [];
        byEl.clear();
        keySet.clear();
        rejected.clear();
        emitChange();
      },
      /** 手动尝试预加载后续图片，减少等待 */
      prefetch(from, n) {
        for (let i = from; i < Math.min(items.length, from + n); i++) {
          const it = items[i];
          if (!it) continue;
          const im = new Image();
          im.referrerPolicy = 'no-referrer';
          im.src = it.src;
        }
      }
    };
  })();

  /* =========================================================================
   * 2.5 ImageDownloader —— 批量打包下载（当前组 / 全部）
   *
   * 设计契约（源自 CHANGELOG「计划中功能：批量打包下载」的评审结论）：
   *   · **单向依赖**：只读 items（由调用方传入快照），不持有 ImagePool，
   *     不回写 seenKeys / current / scope —— 严禁污染图片池状态。
   *   · **不加新权限**：只用 fetch（同源 + 缓存 + 凭据正确）。跨域失败进失败清单，
   *     不做 GM_xmlhttpRequest 降级（二期再议）。
   *   · **STORE 模式 ZIP**（level:0）：图片本身已压缩，再 deflate 只会白耗 CPU
   *     且可能变大。同时避免引入第三方库。
   *   · **并发取 + 顺序写**：并发受限地取 Blob，但写入 ZIP 严格按 items 顺序。
   *   · **失败清单**：拿不到的图如实列出，绝不静默跳过。
   * ========================================================================= */

  const ImageDownloader = (function () {
    const CONCURRENCY = 4;          // 同时进行的请求数
    const TIMEOUT = 20000;          // 单张超时(ms)
    const MAX_NAME = 120;           // 文件名单段长度上限(字符)，留足余量

    /* ---------------- CRC32（ZIP 必需） ---------------- */
    let crcTable = null;
    function makeCrcTable() {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    }
    function crc32(u8) {
      if (!crcTable) crcTable = makeCrcTable();
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /* ---------------- 小端写入工具 ---------------- */
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

    /**
     * 生成 STORE 模式（无压缩）ZIP 的字节流。
     * @param {Array<{name:string, data:Uint8Array}>} files
     * @returns {Uint8Array}
     *
     * 说明：
     *  - 文件名统一按 UTF-8 编码，并置通用标志位 bit 11（0x0800），
     *    否则中文名在部分 Windows 解压工具下会乱码。
     *  - 时间戳使用 DOS 格式，取固定值（1980-01-01），避免引入时区差异。
     *  - 不生成 ZIP64（单文件 < 4GB、条目 < 65535 时不需要；超限时抛错由上层分卷）。
     */
    function buildZip(files) {
      if (files.length > 0xFFFF) throw new Error('条目过多，需要分卷');
      const enc = new TextEncoder();
      const locals = [];
      const centrals = [];
      let offset = 0;

      for (const f of files) {
        const nameBytes = enc.encode(f.name);
        const data = f.data;
        if (data.length > 0xFFFFFFFF) throw new Error('单文件过大，需要分卷');
        const crc = crc32(data);
        const size = data.length;

        // —— 本地文件头 ——
        const local = [].concat(
          u32(0x04034b50),          // 签名
          u16(20),                  // 版本(2.0)
          u16(0x0800),              // 标志位：UTF-8 文件名
          u16(0),                   // 压缩方法 0 = STORE
          u16(0), u16(0x0021),      // 修改时间 / 日期（1980-01-01）
          u32(crc),                 // CRC-32
          u32(size),                // 压缩后大小
          u32(size),                // 原始大小
          u16(nameBytes.length),    // 文件名长度
          u16(0)                    // 扩展区长度
        );
        const localHead = new Uint8Array(local);
        const localOffset = offset;
        offset += localHead.length + nameBytes.length + size;

        // —— 中央目录条目 ——
        const central = [].concat(
          u32(0x02014b50),          // 签名
          u16(20),                  // 创建版本
          u16(20),                  // 所需版本
          u16(0x0800),              // 标志位
          u16(0),                   // 压缩方法
          u16(0), u16(0x0021),      // 时间 / 日期
          u32(crc),
          u32(size),
          u32(size),
          u16(nameBytes.length),
          u16(0),                   // 扩展区
          u16(0),                   // 注释
          u16(0),                   // 磁盘号
          u16(0),                   // 内部属性
          u32(0),                   // 外部属性
          u32(localOffset)          // 本地头偏移
        );
        centrals.push({ head: new Uint8Array(central), name: nameBytes });
        locals.push({ head: localHead, name: nameBytes, data });
      }

      // 中央目录大小
      let centralSize = 0;
      for (const c of centrals) centralSize += c.head.length + c.name.length;

      // —— 中央目录结束记录 ——
      const end = new Uint8Array([].concat(
        u32(0x06054b50),
        u16(0), u16(0),
        u16(files.length), u16(files.length),
        u32(centralSize),
        u32(offset),
        u16(0)
      ));

      const total = offset + centralSize + end.length;
      const out = new Uint8Array(total);
      let p = 0;
      for (const l of locals) {
        out.set(l.head, p); p += l.head.length;
        out.set(l.name, p); p += l.name.length;
        out.set(l.data, p); p += l.data.length;
      }
      for (const c of centrals) {
        out.set(c.head, p); p += c.head.length;
        out.set(c.name, p); p += c.name.length;
      }
      out.set(end, p);
      return out;
    }

    /* ---------------- 文件名 ---------------- */

    // Windows 保留名（不区分大小写，含带扩展名形式）
    const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

    /** MIME → 扩展名（不信任 URL 后缀） */
    function extFromMime(mime) {
      if (!mime) return '';
      const m = mime.toLowerCase().split(';')[0].trim();
      const map = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
        'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
        'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/x-icon': 'ico',
        'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif'
      };
      return map[m] || '';
    }

    /** 从原始文件名里取扩展名（小写，去点） */
    function extFromName(name) {
      const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
      return m ? m[1].toLowerCase() : '';
    }

    /**
     * 清洗单个文件名（不含序号、不含目录）。
     * 处理：非法字符 / 控制字符 / Windows 保留名 / 尾随空格与点 / 长度上限 / 路径穿越。
     */
    function sanitizeName(raw) {
      let n = String(raw == null ? '' : raw);
      // 去掉路径分隔与穿越
      n = n.replace(/[\\/]/g, '_');
      // 去掉控制字符与 Windows 非法字符
      // eslint-disable-next-line no-control-regex
      n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
      // 去掉开头的点（避免隐藏文件 / ..）
      n = n.replace(/^\.+/, '');
      // 尾随空格与点（Windows 不允许）
      n = n.replace(/[ .]+$/, '');
      n = n.trim();
      if (!n) return 'image';
      // 保留名兜底
      if (WIN_RESERVED.test(n)) n = '_' + n;
      // 长度上限（保留扩展名）
      if (n.length > MAX_NAME) {
        const ext = extFromName(n);
        const stem = ext ? n.slice(0, n.length - ext.length - 1) : n;
        const keep = MAX_NAME - (ext ? ext.length + 1 : 0);
        n = stem.slice(0, Math.max(1, keep)) + (ext ? '.' + ext : '');
      }
      return n;
    }

    /**
     * 生成最终文件名：序号(3位) + 原名 + 扩展名（MIME 优先，其次原名，末位兜底 .jpg）。
     * @param {number} i   序号（从 0 起）
     * @param {string} rawName 池内记录的原始名
     * @param {string} mime    响应 Content-Type
     */
    function makeFilename(i, rawName, mime) {
      const seq = String(i + 1).padStart(3, '0');
      let base = sanitizeName(rawName || '');
      // 剥掉原扩展名，稍后统一决定
      const origExt = extFromName(base);
      let stem = origExt ? base.slice(0, base.length - origExt.length - 1) : base;
      stem = sanitizeName(stem) || 'image';
      const ext = extFromMime(mime) || origExt || 'jpg';
      // 序号已经在前面保证唯一，stem 也可能过长，再收一次
      let name = seq + '_' + stem + '.' + ext;
      if (name.length > MAX_NAME + 8) {
        name = seq + '_' + stem.slice(0, MAX_NAME - ext.length - 5) + '.' + ext;
      }
      return name;
    }

    /* ---------------- 取 Blob ---------------- */

    /** 跨域通道是否可用（油猴未提供 GM_xmlhttpRequest 时降级为纯 fetch）。 */
    function hasGmXhr() {
      // 用户可在设置里关闭跨域降级（隐私敏感站点）
      return typeof GM_xmlhttpRequest === 'function'
        && Config.get('crossOriginFallback') !== false;
    }

    /** 从 GM 返回的原始响应头字符串里取某个字段。 */
    function headerOf(raw, name) {
      if (!raw) return '';
      const re = new RegExp('^\\s*' + name + '\\s*:\\s*(.+)$', 'im');
      const m = String(raw).match(re);
      return m ? m[1].trim() : '';
    }

    /**
     * 跨域取图通道（GM_xmlhttpRequest）。
     *
     * 为什么需要它：论坛图床（23img / 66img / thumbsnap 等）几乎都不发
     * `Access-Control-Allow-Origin`，浏览器的 `fetch` 会被同源策略拦掉
     * ——<img> 能显示是因为图片加载本就不受同源策略约束，但 fetch 要读
     * 二进制就必须过 CORS。GM_xmlhttpRequest 由扩展层发请求，不受此限。
     *
     * 用 arraybuffer 而非 blob：blob 在部分 GM 实现里类型不稳定，
     * 而扩展名推断本来就依赖 Content-Type，从响应头取更可控。
     */
    function gmFetchOne(item, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new Error('已取消')); return; }
        let settled = false;
        let req = null;
        const finish = (fn, v) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          fn(v);
        };
        const onAbort = () => {
          try { if (req) req.abort(); } catch (e) { /* 已完成 */ }
          finish(reject, new Error('已取消'));
        };
        // GM 侧 ontimeout 在部分实现不触发，这里再加一道保险
        const timer = setTimeout(() => {
          try { if (req) req.abort(); } catch (e) { /* noop */ }
          finish(reject, new Error('超时'));
        }, TIMEOUT + 2000);

        try {
          req = GM_xmlhttpRequest({
            method: 'GET',
            url: item.src,
            responseType: 'arraybuffer',
            timeout: TIMEOUT,
            anonymous: false,        // 携带 Cookie，登录态图床必需
            onload(res) {
              const st = res ? res.status : 0;
              if (!res || st < 200 || st >= 300) { finish(reject, new Error('HTTP ' + (st || '?'))); return; }
              const mime = headerOf(res.responseHeaders, 'content-type');
              if (mime && !/^image\//i.test(mime) && !/octet-stream/i.test(mime)) {
                finish(reject, new Error('非图片响应(' + mime.split(';')[0].trim() + ')'));
                return;
              }
              if (!res.response) { finish(reject, new Error('响应为空')); return; }
              finish(resolve, { bytes: new Uint8Array(res.response), mime });
            },
            onerror() { finish(reject, new Error('跨域请求失败')); },
            ontimeout() { finish(reject, new Error('超时')); },
            onabort() { finish(reject, new Error('已取消')); }
          });
        } catch (e) {
          finish(reject, new Error('GM 通道异常: ' + ((e && e.message) || e)));
          return;
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    /**
     * 取单张图片的二进制。仅接受 http/https。
     *
     * 策略：先走 fetch（同源/允许 CORS 的图更快，且能复用 HTTP 缓存），
     * 失败后降级到 GM_xmlhttpRequest 绕过同源策略。
     * @returns {Promise<{bytes:Uint8Array, mime:string, via:string}>}
     */
    async function fetchOne(item, signal) {
      if (!isSafeExternalUrl(item.src)) throw new Error('地址不受支持');
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) {
        if (signal.aborted) throw new Error('已取消');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const resp = await fetch(item.src, {
          credentials: 'include',       // 带上同源凭据（跨域时浏览器会按 CORS 规则处理）
          referrerPolicy: 'no-referrer',
          signal: ctrl.signal,
          cache: 'force-cache'          // 优先用 `<img>` 已建立的 HTTP 缓存
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const mime = resp.headers.get('content-type') || '';
        if (mime && !/^image\//i.test(mime) && !/octet-stream/i.test(mime)) {
          throw new Error('非图片响应');
        }
        const buf = await resp.arrayBuffer();
        return { bytes: new Uint8Array(buf), mime, via: 'fetch' };
      } catch (e) {
        // 取消是用户意图，不降级重试
        if (signal && signal.aborted) throw new Error('已取消');
        if (!hasGmXhr()) throw e;
        // 跨域请求由扩展层发出，不受同源策略约束
        const r = await gmFetchOne(item, signal);
        return { bytes: r.bytes, mime: r.mime, via: 'gm' };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    /* ---------------- 主流程 ---------------- */

    /**
     * 打包下载。
     * @param {Array} items        图片条目快照（**拷贝**，不持有引用）
     * @param {Object} opts
     *   @param {string}   opts.zipName   产出文件名（不含 .zip）
     *   @param {Function} opts.onProgress (done, total, phase)
     *   @param {AbortSignal} opts.signal
     * @returns {Promise<{ok:number, failed:Array<{item,files,reason}>, bytes:number, cancelled:boolean}>}
     */
    async function download(items, opts) {
      const o = opts || {};
      const list = (items || []).slice();
      const total = list.length;
      const signal = o.signal;
      const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
      const results = new Array(total);
      let done = 0;
      let cancelled = false;

      const report = (phase) => { if (onProgress) onProgress(done, total, phase); };

      // 并发受限地取 Blob
      let cursor = 0;
      async function worker() {
        while (cursor < total) {
          if (signal && signal.aborted) { cancelled = true; return; }
          const i = cursor++;
          const it = list[i];
          try {
            const r = await fetchOne(it, signal);
            results[i] = { ok: true, item: it, bytes: r.bytes, mime: r.mime, via: r.via };
          } catch (e) {
            if (signal && signal.aborted) { cancelled = true; return; }
            results[i] = { ok: false, item: it, reason: (e && e.message) || String(e) };
          }
          done++;
          report('fetch');
        }
      }
      const workers = [];
      const n = Math.max(1, Math.min(CONCURRENCY, total));
      for (let k = 0; k < n; k++) workers.push(worker());
      await Promise.all(workers);

      if (cancelled || (signal && signal.aborted)) {
        return { ok: 0, failed: [], bytes: 0, cancelled: true };
      }

      // 按 items 顺序组装（成功项）
      const files = [];
      const failed = [];
      for (let i = 0; i < total; i++) {
        const r = results[i];
        if (!r) continue;
        if (r.ok) {
          files.push({ name: makeFilename(i, r.item.name, r.mime), data: r.bytes });
        } else {
          failed.push({ item: r.item, reason: r.reason });
        }
      }
      if (!files.length) {
        return { ok: 0, failed, bytes: 0, cancelled: false };
      }

      report('zip');
      const zipBytes = buildZip(files);
      const blob = new Blob([zipBytes], { type: 'application/zip' });

      // 触发保存
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (sanitizeName(o.zipName || 'images') || 'images') + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      // 统计各通道命中数：便于诊断"哪些图走了跨域降级"
      const viaCount = { fetch: 0, gm: 0 };
      for (let i = 0; i < total; i++) {
        const r = results[i];
        if (r && r.ok && viaCount[r.via] !== undefined) viaCount[r.via]++;
      }

      return { ok: files.length, failed, bytes: zipBytes.length, cancelled: false, via: viaCount };
    }

    return {
      download,
      hasGmXhr,
      /* 暴露纯函数便于测试 */
      _fetchOne: fetchOne,
      _gmFetchOne: gmFetchOne,
      _headerOf: headerOf,
      _buildZip: buildZip,
      _crc32: crc32,
      _makeFilename: makeFilename,
      _sanitizeName: sanitizeName,
      _extFromMime: extFromMime
    };
  })();

  /* =========================================================================
   * 3. ThemeProbe —— 主题探测（自适应论坛原生风格）
   * ========================================================================= */

  const ThemeProbe = (() => {
    const FALLBACK = {
      accent: '#3b82f6',
      accentText: '#ffffff',
      radius: '8px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      dark: false,
      pageBg: '#ffffff'
    };

    function parseColor(str) {
      if (!str) return null;
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(str);
      if (!m) return null;
      const [r, g, b] = [+m[1], +m[2], +m[3]];
      const a = m[4] === undefined ? 1 : +m[4];
      return { r, g, b, a };
    }

    function luminance(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

    function isColorful(c) {
      const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
      return (max - min) > 24 || max < 60 || max > 200; // 非灰
    }

    function toHex(c) {
      const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
      return '#' + h(c.r) + h(c.g) + h(c.b);
    }

    /** 找页面主色：从按钮、链接、CSS 变量里挑一个出现最多的「彩色」 */
    function probeAccent() {
      const counts = new Map();
      const consider = (raw) => {
        const c = parseColor(raw);
        if (!c || c.a < 0.5 || !isColorful(c)) return;
        const key = toHex(c);
        counts.set(key, (counts.get(key) || 0) + 1);
      };

      // 1) CSS 变量
      try {
        const rs = getComputedStyle(document.documentElement);
        ['--primary-color', '--theme-color', '--main-color', '--accent-color',
          '--color-primary', '--brand-color', '--link-color'].forEach((v) => {
            consider(rs.getPropertyValue(v));
          });
      } catch (e) {}

      // 2) meta theme-color
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) consider(meta.getAttribute('content'));

      // 3) 主要按钮与链接的实际颜色
      try {
        const nodes = document.querySelectorAll(
          'button, .btn, input[type="submit"], a, .button, [class*="btn-primary"], [class*="button-primary"]'
        );
        let budget = 300;
        for (const n of nodes) {
          if (budget-- <= 0) break;
          if (isHiddenEl(n)) continue;
          const cs = getComputedStyle(n);
          if (n.tagName === 'A') consider(cs.color);
          else { consider(cs.backgroundColor); consider(cs.color); }
        }
      } catch (e) {}

      let best = null, bestN = 0;
      counts.forEach((n, k) => { if (n > bestN) { bestN = n; best = k; } });
      return bestN >= 2 ? best : null;
    }

    function probeRadius() {
      const sels = ['.card', '.panel', '.btn', 'button', '.post', '.post-item', '.box', '[class*="card"]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el || isHiddenEl(el)) continue;
        const r = getComputedStyle(el).borderTopLeftRadius;
        if (r && r !== '0px' && parseFloat(r) <= 24) return r;
      }
      return null;
    }

    function probeDark() {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
          const c = parseColor(bg);
          if (!c || luminance(c) < 0.45) return true;
        }
      } catch (e) {}
      // 直接看 body 背景亮度
      try {
        const bg = getComputedStyle(document.body).backgroundColor;
        const c = parseColor(bg);
        if (c && c.a > 0.1 && luminance(c) < 0.3) return true;
      } catch (e) {}
      return false;
    }

    function probe() {
      const t = Object.assign({}, FALLBACK);
      if (!Config.get('adaptTheme')) return t;

      try {
        const accent = probeAccent();
        if (accent) {
          t.accent = accent;
          const c = parseColor(accent) || { r: 59, g: 130, b: 246 };
          t.accentText = luminance(c) > 0.6 ? '#111111' : '#ffffff';
        }
        const radius = probeRadius();
        if (radius) t.radius = radius;
        const ff = getComputedStyle(document.body).fontFamily;
        if (ff) t.fontFamily = ff;
        t.dark = probeDark();
        const bg = parseColor(getComputedStyle(document.body).backgroundColor);
        if (bg && bg.a > 0.1) t.pageBg = toHex(bg);
      } catch (e) { warn('主题探测异常，使用默认外观', e); }
      return t;
    }

    return { probe };
  })();

  /* =========================================================================
   * 4. CSS
   * ========================================================================= */

  const CSS = `
.${NS}-root, .${NS}-root *, .${NS}-root *::before, .${NS}-root *::after { box-sizing: border-box; }

/* ---------- 悬浮按钮 ---------- */
.${NS}-fab {
  position: fixed; right: 18px; bottom: 22px; z-index: ${Z_BASE};
  display: flex; align-items: center; gap: 7px;
  height: 40px; padding: 0 14px;
  border-radius: 999px; border: none;
  background: var(--fiv-accent, #2563eb); color: var(--fiv-accent-text, #fff);
  font: 600 13px/1 var(--fiv-font, system-ui, sans-serif);
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.28), 0 1px 0 rgba(255,255,255,.15) inset;
  opacity: 0; transform: translateY(8px) scale(.92);
  pointer-events: none;
  transition: opacity .22s ease, transform .22s ease, filter .15s ease;
}
.${NS}-fab.${NS}-on { opacity: 1; transform: none; pointer-events: auto; }
.${NS}-fab:hover { filter: brightness(1.08); }
.${NS}-fab:active { transform: scale(.96); }
.${NS}-fab svg { width: 17px; height: 17px; display: block; }
.${NS}-fab .${NS}-fab-count {
  font-variant-numeric: tabular-nums;
  padding: 1px 6px; border-radius: 999px;
  background: rgba(255,255,255,.22);
}

/* ---------- 图片悬停角标（以图定域入口） ----------
   单例浮动按钮：不往页面里插 N 个节点，只在鼠标悬停到内容图时
   定位到该图的一个角落显示。好处：
     · 不污染站点 DOM / 不触发站点样式重排
     · 动态加载的新图自动适用（无需逐图挂载）
     · 移开即隐藏，页面安静 */
.${NS}-badge {
  position: fixed; z-index: ${Z_BASE - 500};
  display: none;
  align-items: center; gap: 6px;
  height: 30px; padding: 0 11px;
  border: none; border-radius: 999px;
  background: var(--fiv-accent, #2563eb);
  color: var(--fiv-accent-text, #fff);
  font: 600 12px/1 var(--fiv-font, system-ui, sans-serif);
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,.32);
  opacity: 0; transform: translateY(4px) scale(.94);
  transition: opacity .16s ease, transform .16s ease, filter .15s ease;
  pointer-events: none;   /* 未显形时不拦截任何点击 */
}
.${NS}-badge.${NS}-on {
  display: inline-flex;
  opacity: var(--fiv-badge-op, .72);
  transform: none;
  pointer-events: auto;
}
.${NS}-badge:hover { opacity: 1; filter: brightness(1.08); }
.${NS}-badge:active { transform: scale(.95); }
.${NS}-badge svg { width: 15px; height: 15px; display: block; }
/* 角标显形时给原图描个细边，明确"我要框的是这张所属的这一组" */
img.${NS}-hot { outline: 2px solid var(--fiv-accent, #2563eb); outline-offset: 2px; }
/* 关闭动画时不做过渡 */
.${NS}-nofx .${NS}-badge { transition: none; }

/* ---------- 遮罩层 ---------- */
.${NS}-root {
  position: fixed; inset: 0; z-index: ${Z_BASE};
  display: none;
  font-family: var(--fiv-font);
  -webkit-font-smoothing: antialiased;
  --fiv-gap: 12px;
}
.${NS}-root.${NS}-open { display: block; }
.${NS}-backdrop {
  position: absolute; inset: 0;
  background: var(--fiv-backdrop);
  backdrop-filter: blur(var(--fiv-blur));
  -webkit-backdrop-filter: blur(var(--fiv-blur));
  opacity: 0; transition: opacity .2s ease;
}
.${NS}-root.${NS}-shown .${NS}-backdrop { opacity: 1; }

/* ---------- 顶栏 ---------- */
.${NS}-top {
  position: absolute; left: 0; right: 0; top: 0; height: 52px;
  display: flex; align-items: center; gap: 10px;
  padding: 0 14px;
  color: var(--fiv-fg);
  background: linear-gradient(to bottom, var(--fiv-topbg), transparent);
  opacity: 0; transition: opacity .22s ease;
  pointer-events: none;
}
.${NS}-root.${NS}-ui .${NS}-top { opacity: 1; pointer-events: auto; }
.${NS}-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px; opacity: .82;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${NS}-counter {
  font: 600 13px/1 var(--fiv-font, system-ui, sans-serif); font-variant-numeric: tabular-nums;
  padding: 6px 10px; border-radius: var(--fiv-radius, 8px);
  background: var(--fiv-chip, rgba(15,20,28,.07)); color: var(--fiv-fg, #1b1f24);
  white-space: nowrap;
}
.${NS}-scope {
  font: 600 11px/1 var(--fiv-font, system-ui, sans-serif); white-space: nowrap;
  padding: 5px 9px; border-radius: 999px;
  background: var(--fiv-accent, #2563eb); color: var(--fiv-accent-text, #fff);
  opacity: .92;
}
.${NS}-scope[hidden] { display: none; }
.${NS}-meta { font-size: 12px; opacity: .6; white-space: nowrap; }
.${NS}-tbtn {
  width: 34px; height: 34px; flex: 0 0 auto;
  display: grid; place-items: center;
  border: none; border-radius: var(--fiv-radius, 8px);
  background: var(--fiv-chip, rgba(15,20,28,.07));
  color: var(--fiv-fg, #1b1f24);
  cursor: pointer; transition: background .15s ease, transform .12s ease;
}
.${NS}-tbtn:hover { background: var(--fiv-chip-hover, rgba(15,20,28,.13)); }
.${NS}-tbtn:active { transform: scale(.93); }
.${NS}-tbtn svg { width: 17px; height: 17px; display: block; }
.${NS}-tbtn.${NS}-active { background: var(--fiv-accent); color: var(--fiv-accent-text); }

/* ---------- 舞台 ---------- */
.${NS}-stage {
  position: absolute; left: 0; right: 0; top: 0;
  bottom: var(--fiv-strip); /* 由缩略图条高度决定 */
  display: grid; place-items: center;
  overflow: hidden;
  cursor: default;
}
.${NS}-root:not(.${NS}-hasstrip) .${NS}-stage { bottom: 0; }
.${NS}-imgwrap {
  position: relative;
  transform-origin: center center;
  will-change: transform;
  transition: transform .12s ease-out;
  display: flex; align-items: center; justify-content: center;
  max-width: 100%; max-height: 100%;
}
.${NS}-imgwrap.${NS}-dragging { transition: none; cursor: grabbing; }
.${NS}-img {
  display: block;
  /* 由 JS 按可用区显式给出尺寸（见 fitImageEl），保证：
     - 宽图限宽、长图限高，永不裁剪
     - 小图不放大（JS 里取 min(1, ...)）
     - 不依赖 load 事件，首帧即正确 */
  width: auto; height: auto;
  user-select: none; -webkit-user-drag: none;
  border-radius: var(--fiv-imgradius);
  box-shadow: var(--fiv-imgshadow);
  background: var(--fiv-imgbg);
}
.${NS}-slide-out { opacity: 0; }
.${NS}-slide-in { animation: ${NS}-slidein .24s ease-out; }
@keyframes ${NS}-slidein {
  from { opacity: 0; }
  to { opacity: 1; }
}
.${NS}-root.${NS}-nofx .${NS}-imgwrap,
.${NS}-root.${NS}-nofx .${NS}-thumb { transition: none !important; }

/* 加载中 / 失败 */
.${NS}-loader {
  position: absolute; left: 50%; top: 50%; width: 34px; height: 34px;
  margin: -17px 0 0 -17px; border-radius: 50%;
  border: 3px solid var(--fiv-chip); border-top-color: var(--fiv-accent);
  animation: ${NS}-spin .8s linear infinite;
}
@keyframes ${NS}-spin { to { transform: rotate(360deg); } }
.${NS}-fail {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--fiv-fg); font-size: 13px; text-align: center;
  padding: 28px 34px; border-radius: var(--fiv-radius);
  background: var(--fiv-chip);
}
.${NS}-fail button {
  border: none; border-radius: var(--fiv-radius);
  background: var(--fiv-accent); color: var(--fiv-accent-text);
  padding: 8px 14px; font: 600 13px/1 var(--fiv-font); cursor: pointer;
}

/* ---------- 左右箭头 ---------- */
.${NS}-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 54px; height: 84px;
  display: grid; place-items: center;
  border: none; border-radius: var(--fiv-radius);
  background: var(--fiv-chip); color: var(--fiv-fg);
  cursor: pointer; opacity: 0; transition: opacity .2s ease, background .15s ease;
}
.${NS}-root.${NS}-ui .${NS}-nav { opacity: .55; }
.${NS}-nav:hover { opacity: 1 !important; background: var(--fiv-chip-hover); }
.${NS}-nav[disabled] { opacity: .12 !important; cursor: default; }
.${NS}-prev { left: var(--fiv-gap); }
.${NS}-next { right: var(--fiv-gap); }
.${NS}-nav svg { width: 26px; height: 26px; }

/* ---------- 缩略图条 ---------- */
.${NS}-strip {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: var(--fiv-strip);
  display: flex; flex-direction: column;
  padding: 0 10px;
  background: var(--fiv-stripbg);
  border-top: 1px solid var(--fiv-border);
  transform: translateY(100%); transition: transform .24s ease;
  cursor: grab;
}
/* 迷你进度条：缩略图虚拟化后（>120 张）缩略图只渲染局部窗口，
   单看缩略图无法判断"我在全图的什么位置"。
   这条按真实比例铺满整组，随当前图片移动，补回全局位置感。 */
.${NS}-minimap {
  position: relative; flex: 0 0 auto;
  height: 4px; margin: 3px 0 0;
  background: var(--fiv-border);
  border-radius: 2px; overflow: hidden;
  opacity: .55; transition: opacity .16s ease;
}
.${NS}-minimap.${NS}-on { opacity: 1; }
.${NS}-minimap-fill {
  position: absolute; top: 0; bottom: 0; left: 0;
  background: var(--fiv-accent); border-radius: 2px;
  transition: width .18s ease;
}
.${NS}-minimap-head {
  position: absolute; top: -2px; width: 2px; height: 8px;
  background: var(--fiv-accent); border-radius: 1px;
  transition: left .18s ease;
}
.${NS}-root.${NS}-hasstrip .${NS}-strip { transform: none; }
.${NS}-root.${NS}-hasstrip.${NS}-ui .${NS}-strip { transform: none; }
.${NS}-root.${NS}-hasstrip.${NS}-hidestrip .${NS}-strip { transform: translateY(100%); }
.${NS}-strip.${NS}-dragging { cursor: grabbing; }
.${NS}-track {
  display: flex; align-items: center; gap: 7px;
  overflow-x: auto; overflow-y: hidden;
  width: 100%; flex: 1 1 auto; min-height: 0;
  scrollbar-width: none; -ms-overflow-style: none;
  padding: 0 2px;
  /* ⚠️ 这里**不能**用 scroll-behavior: smooth。
     拖拽时每帧都在写 scrollLeft，平滑滚动会把每次赋值变成一次动画，
     连续 mousemove 会互相覆盖目标值，表现为「怎么拖都不动」。
     平滑只由 scrollStripTo() 在需要时临时开启。 */
  scroll-behavior: auto;
}
.${NS}-track::-webkit-scrollbar { display: none; }
/* 拖拽进行中：禁止缩略图抢占指针（否则会触发原生图片拖拽/文本选择） */
.${NS}-strip.${NS}-dragging .${NS}-thumb { pointer-events: none; }
.${NS}-strip.${NS}-dragging { cursor: grabbing; user-select: none; }
.${NS}-thumb {
  position: relative; flex: 0 0 auto;
  width: calc(var(--fiv-thumb) * 1.25);
  height: var(--fiv-thumb);
  border-radius: var(--fiv-radius);
  overflow: hidden;
  background: var(--fiv-imgbg);
  border: 2px solid transparent;
  opacity: .5;
  cursor: pointer;
  transition: opacity .16s ease, border-color .16s ease, transform .16s ease;
}
.${NS}-thumb img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  pointer-events: none; user-select: none; -webkit-user-drag: none;
}
.${NS}-thumb:hover { opacity: .92; transform: translateY(-2px); }
.${NS}-thumb.${NS}-seen { opacity: .34; }
.${NS}-thumb.${NS}-cur {
  opacity: 1; border-color: var(--fiv-accent);
  box-shadow: 0 0 0 2px var(--fiv-accent) inset;
}
.${NS}-thumb .${NS}-idx {
  position: absolute; left: 3px; top: 3px;
  min-width: 17px; height: 17px; padding: 0 4px;
  display: grid; place-items: center;
  font: 600 10px/1 var(--fiv-font); font-variant-numeric: tabular-nums;
  color: #fff; background: rgba(0,0,0,.62);
  border-radius: 5px; pointer-events: none;
}
.${NS}-thumb.${NS}-cur .${NS}-idx { background: var(--fiv-accent); color: var(--fiv-accent-text); }
.${NS}-thumb .${NS}-seen-dot {
  position: absolute; right: 3px; top: 3px; width: 6px; height: 6px;
  border-radius: 50%; background: rgba(0,0,0,.55); display: none;
}
.${NS}-thumb.${NS}-seen .${NS}-seen-dot { display: block; }
/* 悬停放大预览 */
.${NS}-peek {
  position: fixed; z-index: ${Z_BASE + 2};
  transform: translate(-50%, calc(-100% - 14px));
  padding: 5px 5px 4px;
  background: var(--fiv-chip); border: 1px solid var(--fiv-border);
  border-radius: var(--fiv-radius);
  box-shadow: 0 10px 30px rgba(0,0,0,.42);
  pointer-events: none; opacity: 0;
  transition: opacity .14s ease;
}
.${NS}-peek.${NS}-on { opacity: 1; }
.${NS}-peek img { display: block; max-width: 260px; max-height: 200px; border-radius: calc(var(--fiv-radius) * .6); }
.${NS}-peek .${NS}-peek-name {
  margin-top: 4px; max-width: 260px;
  font: 400 11px/1.3 var(--fiv-font); color: var(--fiv-fg);
  opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- 缩放指示 ---------- */
.${NS}-zoombadge {
  position: absolute; left: 50%; bottom: calc(var(--fiv-strip) + 14px);
  transform: translateX(-50%);
  padding: 5px 11px; border-radius: 999px;
  background: var(--fiv-chip); color: var(--fiv-fg);
  font: 600 12px/1 var(--fiv-font); font-variant-numeric: tabular-nums;
  opacity: 0; transition: opacity .2s ease; pointer-events: none;
}
.${NS}-zoombadge.${NS}-on { opacity: 1; }

/* ---------- Toast ---------- */
.${NS}-toast {
  position: fixed; left: 50%; top: 26px; transform: translate(-50%, -12px);
  z-index: ${Z_BASE + 5};
  padding: 9px 16px; border-radius: var(--fiv-radius);
  background: var(--fiv-chip); color: var(--fiv-fg);
  border: 1px solid var(--fiv-border);
  box-shadow: 0 8px 26px rgba(0,0,0,.35);
  font: 500 13px/1 var(--fiv-font);
  opacity: 0; transition: opacity .2s ease, transform .2s ease;
  pointer-events: none;
}
.${NS}-toast.${NS}-on { opacity: 1; transform: translate(-50%, 0); }

/* ---------- 打包下载进度 ---------- */
.${NS}-pack {
  position: fixed; left: 50%; top: 26px; transform: translate(-50%, -12px);
  z-index: ${Z_BASE + 6};
  min-width: 280px; max-width: min(520px, 88vw);
  padding: 11px 14px 12px;
  border-radius: var(--fiv-radius);
  background: var(--fiv-chip); color: var(--fiv-fg);
  border: 1px solid var(--fiv-border);
  box-shadow: 0 8px 26px rgba(0,0,0,.35);
  font: 500 13px/1.4 var(--fiv-font);
  opacity: 0; transition: opacity .2s ease, transform .2s ease;
  pointer-events: none;
}
.${NS}-pack.${NS}-on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.${NS}-pack-row { display: flex; align-items: center; gap: 10px; }
.${NS}-pack-txt {
  flex: 1 1 auto; min-width: 0;
  white-space: pre-line;      /* 支持多行提示（跨域原因说明用） */
  overflow: hidden; text-overflow: ellipsis;
}
.${NS}-pack-cancel {
  flex: 0 0 auto; cursor: pointer;
  padding: 4px 10px; border-radius: 6px;
  background: transparent; color: var(--fiv-fg);
  border: 1px solid var(--fiv-border);
  font: inherit; font-size: 12px;
}
.${NS}-pack-cancel:hover { background: var(--fiv-chip-hover); }
.${NS}-pack-bar {
  margin-top: 8px; height: 4px; border-radius: 2px;
  background: var(--fiv-border); overflow: hidden;
}
.${NS}-pack-fill {
  height: 100%; width: 0; background: var(--fiv-accent);
  transition: width .18s ease;
}
.${NS}-pack-detail {
  margin-top: 7px; max-height: 120px; overflow-y: auto;
  font-size: 12px; line-height: 1.5; opacity: .8;
  white-space: pre-wrap; word-break: break-all;
}

/* ---------- 配置面板 ---------- */
.${NS}-panel-mask {
  position: fixed; inset: 0; z-index: ${Z_BASE + 10};
  background: rgba(0,0,0,.5); display: none;
}
.${NS}-panel-mask.${NS}-open { display: block; }
.${NS}-panel {
  position: fixed; right: 0; top: 0; bottom: 0;
  width: min(440px, 94vw);
  z-index: ${Z_BASE + 11};
  display: flex; flex-direction: column;
  /* 变量兜底：万一主题变量未就绪，也不能变成透明/看不见 */
  background: var(--fiv-panelbg, #ffffff);
  color: var(--fiv-fg, #1b1f24);
  font: 13px/1.5 var(--fiv-font, system-ui, sans-serif);
  box-shadow: -14px 0 40px rgba(0,0,0,.45);
  transform: translateX(100%); transition: transform .26s ease;
}
/* 亮暗由 <html data-fiv-theme> 标记兜底，不依赖变量是否注入成功 */
html[data-${NS}-theme="dark"] .${NS}-panel { background: #161a20; color: #f2f4f8; }
html[data-${NS}-theme="dark"] .${NS}-panel-mask { background: rgba(0,0,0,.62); }
.${NS}-panel.${NS}-open { transform: none; }
.${NS}-panel-head {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid var(--fiv-border, rgba(15,20,28,.12));
}
.${NS}-panel-head h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1 1 auto; }
.${NS}-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 6px 16px 20px; }
.${NS}-panel-foot {
  flex: 0 0 auto; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 12px 16px; border-top: 1px solid var(--fiv-border, rgba(15,20,28,.12));
}
.${NS}-group { margin: 14px 0 6px; }
.${NS}-group > h4 {
  margin: 0 0 8px; font-size: 12px; font-weight: 700;
  letter-spacing: .04em; text-transform: uppercase;
  color: var(--fiv-accent, #2563eb);
}
.${NS}-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 0; border-bottom: 1px dashed var(--fiv-border, rgba(15,20,28,.12));
}
.${NS}-row:last-child { border-bottom: none; }
.${NS}-row > label { flex: 1 1 auto; min-width: 0; }
.${NS}-row .${NS}-hint { display: block; font-size: 11px; opacity: .58; margin-top: 2px; }
.${NS}-row input[type="text"], .${NS}-row input[type="number"], .${NS}-row textarea, .${NS}-row select {
  flex: 0 0 auto;
  width: 150px; padding: 6px 8px;
  border: 1px solid var(--fiv-border, rgba(15,20,28,.12));
  border-radius: calc(var(--fiv-radius, 8px) * .7);
  background: var(--fiv-input, rgba(15,20,28,.045));
  color: var(--fiv-fg, #1b1f24);
  font: 12px/1.4 var(--fiv-font, system-ui, sans-serif);
}
.${NS}-row textarea { width: 100%; min-height: 58px; resize: vertical; font-family: ui-monospace, Menlo, Consolas, monospace; }
.${NS}-row-col { flex-direction: column; align-items: stretch; }
.${NS}-row-col > label { flex: none; }
.${NS}-switch { position: relative; width: 40px; height: 22px; flex: 0 0 auto; }
.${NS}-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.${NS}-switch span {
  position: absolute; inset: 0; border-radius: 999px;
  background: var(--fiv-border, rgba(15,20,28,.12)); cursor: pointer; transition: background .18s ease;
}
.${NS}-switch span::after {
  content: ''; position: absolute; left: 2px; top: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: #fff; transition: transform .18s ease;
}
.${NS}-switch input:checked + span { background: var(--fiv-accent, #2563eb); }
.${NS}-switch input:checked + span::after { transform: translateX(18px); }
.${NS}-kbd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.${NS}-kbd-table td { padding: 4px 6px; border-bottom: 1px dashed var(--fiv-border, rgba(15,20,28,.12)); }
.${NS}-kbd-table tr:last-child td { border-bottom: none; }
.${NS}-kbd-table td:first-child { width: 42%; }
kbd.${NS}-kbd {
  display: inline-block; min-width: 20px; text-align: center;
  padding: 2px 6px; margin: 1px;
  border: 1px solid var(--fiv-border, rgba(15,20,28,.12)); border-bottom-width: 2px;
  border-radius: 5px; background: var(--fiv-input, rgba(15,20,28,.045));
  color: var(--fiv-fg, #1b1f24);
  font: 600 11px/1.3 ui-monospace, Menlo, Consolas, monospace;
}
.${NS}-btn {
  flex: 0 0 auto; padding: 8px 13px;
  border: 1px solid var(--fiv-border, rgba(15,20,28,.12));
  border-radius: calc(var(--fiv-radius, 8px) * .8);
  background: var(--fiv-input, rgba(15,20,28,.045));
  color: var(--fiv-fg, #1b1f24);
  font: 600 12px/1 var(--fiv-font, system-ui, sans-serif); cursor: pointer;
  transition: filter .15s ease;
}
.${NS}-btn:hover { filter: brightness(1.12); }
.${NS}-btn.${NS}-primary { background: var(--fiv-accent, #2563eb); color: var(--fiv-accent-text, #fff); border-color: transparent; }
.${NS}-btn.${NS}-danger { color: #ef4444; }
.${NS}-statusbar { font-size: 11px; opacity: .6; padding: 0 16px 12px; }

/* ---------- 页面调暗层 ----------
   贴在原网页之上、浏览器视图之内；压暗但保留可见度，不进全黑。
   z-index 低于浏览层(--fiv-z)，所以浏览界面永远在它之上。
   pointer-events:none 保证不挡网页交互（缩略图/拖动等照样能点）。 */
.${NS}-dim {
  position: fixed; inset: 0;
  z-index: var(--fiv-zdim, 2147482000);
  /* 暗色偏纯黑、亮色偏冷灰，避免亮底下「糊一层死黑」显得脏 */
  background: var(--fiv-dim-color, #000);
  opacity: 0;
  pointer-events: none;
  transition: opacity .22s ease;
  will-change: opacity;
}
.${NS}-dim.${NS}-on { opacity: var(--fiv-dim, .62); }
.${NS}-root.${NS}-nofx ~ .${NS}-dim,
.${NS}-dim.${NS}-nofx { transition: none; }

/* ---------- 页面同步滚动的定位标记 ----------
   浏览某张图时，把对应原图滚到视口中央并高亮，退出后停在原处。 */
.${NS}-anchor {
  outline: 2px solid var(--fiv-accent);
  outline-offset: 3px;
  border-radius: 3px;
  transition: outline-color .2s ease;
}
`;

  /**
   * 计算完整的主题变量表（唯一的「变量真相源」）。
   *
   * ⚠️ 历史 bug：变量曾被拆成两处、且全量那份只写在「浏览层」根节点上，
   * 而浏览层是懒构建的。于是「首次通过 Shift+/ 打开设置面板」时，
   * 面板拿不到 --fiv-fg / --fiv-panelbg / --fiv-border / --fiv-input，
   * 全部 var() 解析失败 → 背景变透明、文字继承站点色 → 看不清，
   * 且透明面板盖不住下面的网页 → 点不动。
   *
   * 现在统一：启动即把全量变量写到 :root（style 节点），任何 UI 都能用。
   */
  function themeVars(theme) {
    const dark = theme.dark;
    return {
      '--fiv-accent': theme.accent,
      '--fiv-accent-text': theme.accentText,
      '--fiv-radius': theme.radius || '8px',
      '--fiv-font': theme.fontFamily || 'system-ui, sans-serif',
      /* 调暗层略低于浏览层，保证浏览界面始终压在调暗层之上 */
      '--fiv-zdim': String(Z_BASE - 1000),
      '--fiv-z': String(Z_BASE),
      '--fiv-dim': String(Config.get('dimLevel') || 0.62),
      '--fiv-dim-color': dark ? '#000' : '#0b0d10',
      '--fiv-thumb': (Config.get('thumbSize') || 64) + 'px',
      '--fiv-strip': (Config.get('thumbSize') || 64) + 'px',
      '--fiv-imgradius': '6px',
      '--fiv-topbg': dark ? 'rgba(12,14,18,.86)' : 'rgba(255,255,255,.86)',
      '--fiv-backdrop': dark ? 'rgba(8,9,12,.93)' : 'rgba(245,246,248,.94)',
      /* 毛玻璃放在「近实色遮罩」之上才自然，且模糊半径越小越省性能 */
      '--fiv-blur': '3px',
      '--fiv-fg': dark ? '#f2f4f8' : '#1b1f24',
      '--fiv-chip': dark ? 'rgba(255,255,255,.10)' : 'rgba(15,20,28,.07)',
      '--fiv-chip-hover': dark ? 'rgba(255,255,255,.18)' : 'rgba(15,20,28,.13)',
      '--fiv-border': dark ? 'rgba(255,255,255,.14)' : 'rgba(15,20,28,.12)',
      '--fiv-stripbg': dark ? 'rgba(14,16,20,.90)' : 'rgba(255,255,255,.90)',
      '--fiv-panelbg': dark ? '#161a20' : '#ffffff',
      '--fiv-input': dark ? 'rgba(255,255,255,.07)' : 'rgba(15,20,28,.045)',
      '--fiv-imgbg': dark ? 'rgba(255,255,255,.05)' : 'rgba(15,20,28,.04)',
      '--fiv-imgshadow': dark ? '0 18px 50px rgba(0,0,0,.6)' : '0 18px 50px rgba(15,20,28,.24)'
    };
  }

  /** 兼容旧调用：把全量变量写到指定节点（一般用不到，保留给浏览层根节点覆盖） */
  function applyThemeVars(theme, root) {
    const vars = themeVars(theme);
    let css = '';
    for (const k in vars) css += k + ':' + vars[k] + ';';
    root.setAttribute('style', css);
  }

  const ICONS = {
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4L10 14"/><path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 011-1h4"/><path d="M20 9V5a1 1 0 00-1-1h-4"/><path d="M4 15v4a1 1 0 001 1h4"/><path d="M20 15v4a1 1 0 01-1 1h-4"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2 2 2 0 11-4 0 1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15a2 2 0 010-4 1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 4.6a2 2 0 014 0 1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 11a2 2 0 010 4z"/></svg>',
    package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>'
  };

  /* =========================================================================
   * 5. Viewer + ThumbBar —— 浏览器主体
   * ========================================================================= */

  const Viewer = (() => {
    let root, backdrop, stage, imgWrap, imgEl, topBar, titleEl, counterEl, metaEl, scopeEl,
      btnClose, btnDownload, btnCopy, btnOpen, btnFit, btnPlay,
      prevBtn, nextBtn, strip, track, zoomBadge, loaderEl, peekEl,
      minimapEl, minimapFill, minimapHead;

    let open = false;
    let index = 0;
    let items = [];
    /**
     * 当前浏览「范围」。
     *   null   → 全局（整页所有图片）
     *   {el, keys:Set, label} → 限定在某个分组容器内
     * 观察器后续发现的新图，会按此范围决定是否并入当前浏览列表。
     */
    let scope = null;
    /** 看过哪些（用 key 集合，图片池变动后仍有效） */
    const seenKeys = new Set();
    let scale = 1;            // 当前缩放倍率（相对原始像素）
    let panX = 0, panY = 0;   // 平移偏移
    let dragging = false, dragMoved = false;
    let uiTimer = null;
    let autoplayTimer = null;
    /**
     * 渲染令牌：每次 show() 自增。
     * 图片的 load 回调捕获当次令牌，回调时若与当前不符即丢弃——
     * 防止快速滚轮切图时，上一张的 load 晚到并污染新图的布局/计数器。
     */
    let renderToken = 0;

    /* ---------------- DOM 构建 ---------------- */

    function build() {
      root = document.createElement('div');
      root.id = NS + '-root';
      root.className = NS + '-root';
      root.innerHTML = `
        <div class="${NS}-backdrop"></div>
        <div class="${NS}-top">
          <span class="${NS}-counter"></span>
          <span class="${NS}-scope" hidden></span>
          <span class="${NS}-title"></span>
          <span class="${NS}-meta"></span>
          <button class="${NS}-tbtn" data-act="hide-strip" title="显示/隐藏缩略图条 (T)">${ICONS.fit}</button>
          <button class="${NS}-tbtn" data-act="play" title="自动播放 (Space)">${ICONS.play}</button>
          <button class="${NS}-tbtn" data-act="download" title="下载当前图片 (D)">${ICONS.download}</button>
          <button class="${NS}-tbtn" data-act="pack-group" title="打包下载本组 (Shift+D)">${ICONS.package}</button>
          <button class="${NS}-tbtn" data-act="copy" title="复制图片链接 (C)">${ICONS.link}</button>
          <button class="${NS}-tbtn" data-act="open" title="新标签打开原图 (O)">${ICONS.external}</button>
          <button class="${NS}-tbtn" data-act="settings" title="设置 (Shift+/)">${ICONS.settings}</button>
          <button class="${NS}-tbtn" data-act="close" title="关闭 (Esc)">${ICONS.close}</button>
        </div>
        <div class="${NS}-stage"></div>
        <button class="${NS}-nav ${NS}-prev" title="上一张 (←)">${ICONS.left}</button>
        <button class="${NS}-nav ${NS}-next" title="下一张 (→)">${ICONS.right}</button>
        <div class="${NS}-zoombadge"></div>
        <div class="${NS}-strip">
          <div class="${NS}-minimap"><div class="${NS}-minimap-fill"></div><div class="${NS}-minimap-head"></div></div>
          <div class="${NS}-track"></div>
        </div>
      `;
      document.documentElement.appendChild(root);

      backdrop = root.querySelector('.' + NS + '-backdrop');
      stage = root.querySelector('.' + NS + '-stage');
      topBar = root.querySelector('.' + NS + '-top');
      counterEl = root.querySelector('.' + NS + '-counter');
      scopeEl = root.querySelector('.' + NS + '-scope');
      titleEl = root.querySelector('.' + NS + '-title');
      metaEl = root.querySelector('.' + NS + '-meta');
      strip = root.querySelector('.' + NS + '-strip');
      track = root.querySelector('.' + NS + '-track');
      minimapEl = root.querySelector('.' + NS + '-minimap');
      minimapFill = root.querySelector('.' + NS + '-minimap-fill');
      minimapHead = root.querySelector('.' + NS + '-minimap-head');
      zoomBadge = root.querySelector('.' + NS + '-zoombadge');
      prevBtn = root.querySelector('.' + NS + '-prev');
      nextBtn = root.querySelector('.' + NS + '-next');
      btnPlay = root.querySelector('[data-act="play"]');

      if (!Config.get('thumbnailBar')) root.classList.add(NS + '-hasstrip-off');
      if (!Config.get('animation')) root.classList.add(NS + '-nofx');

      /* 舞台结构 */
      imgWrap = document.createElement('div');
      imgWrap.className = NS + '-imgwrap';
      stage.appendChild(imgWrap);

      /* 事件绑定 */
      bindEvents();
    }

    function buildPeek() {
      if (peekEl) return;
      peekEl = document.createElement('div');
      peekEl.className = NS + '-peek';
      peekEl.innerHTML = '<img alt=""><div class="' + NS + '-peek-name"></div>';
      document.documentElement.appendChild(peekEl);
    }

    /* ---------------- Toast ---------------- */

    let toastEl = null, toastTimer = null;
    function toast(msg) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = NS + '-toast';
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      // 立即重排，保证重复调用有动画
      void toastEl.offsetWidth;
      toastEl.classList.add(NS + '-on');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove(NS + '-on'), 1600);
    }

    /* ---------------- 打开 / 关闭 ---------------- */

    function setItems(newItems) {
      // 处于「分组浏览」时，只接纳仍属于该组的图片（新加载的图也自动并入）
      if (scope && scope.el) {
        newItems = newItems.filter((it) => it.el && scope.el.contains(it.el));
        // 组已从 DOM 移除或失效 → 自动退回全局，避免卡在空组
        if (!newItems.length && ImagePool && ImagePool.items.length) {
          scope = null;
          newItems = ImagePool.items;
        }
      }
      const prevKey = items[index] ? items[index].key : null;
      items = newItems;
      if (prevKey) {
        const ni = items.findIndex((it) => it.key === prevKey);
        if (ni >= 0) index = ni;
        else index = clamp(index, 0, Math.max(0, items.length - 1));
      }
      if (open) {
        renderStrip();
        syncCounter();
        updateNavDisabled();
      }
    }

    /**
     * 按「某张图所属的那一组」打开浏览。
     *
     * 这是「以图定域」的入口：用户在某张图上触发 → 只浏览该组。
     *   - 组内 < 2 张 / 解析失败 → 自动回退全局，并提示
     *   - 组 == 全页 → 等价于全局浏览
     * 返回 true 表示成功按组打开。
     */
    function openGroup(el, opts) {
      const o = opts || {};
      const g = ImagePool.groupOf(el);
      if (!g || g.size < 2) {
        // 没有可用的分组：退回全局
        scope = null;
        setItems(ImagePool.items);
        const idx = el ? ImagePool.items.findIndex((it) => it.el === el) : -1;
        openAt(idx >= 0 ? idx : 0);
        if (!o.silent) toast('这组只有 1 张图，已切换为浏览全部');
        return false;
      }
      scope = { el: resolveScopeEl(el, g), keys: new Set(g.items.map((it) => it.key)), label: o.label || '' };
      // 记录源图 key，便于「进入后定位到用户点的那张」
      const srcKey = el ? (ImagePool.itemOf(el) || {}).key : null;
      setItems(g.items.slice());
      const si = g.items.findIndex((it) => it.key === srcKey);
      index = si >= 0 ? si : 0;
      if (g.isWholePage && !o.silent) toast('本组即全部图片');
      else if (!o.silent) toast('浏览本组 · 共 ' + g.size + ' 张');
      openAt(index);
      return true;
    }

    /** 从分组结果里取出「承载该组」的容器元素（用于后续增量判定） */
    function resolveScopeEl(el, g) {
      // g.items 里任意一张的 el 的共同祖先即为组容器：直接复用 resolveGroup 的判定
      // 这里简单用「第一个条目的 el 的、能包含组内全部 el 的最近祖先」
      const els = g.items.map((it) => it.el).filter(Boolean);
      if (!els.length) return null;
      let node = els[0];
      while (node && node.nodeType === 1) {
        if (els.every((e) => node.contains(e))) return node;
        node = node.parentElement;
      }
      return null;
    }

    /** 退出分组，回到全局浏览范围 */
    function clearScope() {
      scope = null;
      setItems(ImagePool.items);
    }

    function openAt(itemOrIndex) {
      if (!items.length) { toast('没有可浏览的图片'); return; }
      if (typeof itemOrIndex === 'number') index = clamp(itemOrIndex, 0, items.length - 1);
      else {
        const i = items.findIndex((it) => it.key === itemOrIndex.key);
        index = i >= 0 ? i : 0;
      }
      if (!root) build();
      if (!open) {
        rememberScroll();            // 记录进入前的位置（退出兜底还原）
        Dimmer.on();                 // 页面调暗（不完全黑）
        root.classList.add(NS + '-open');
        requestAnimationFrame(() => {
          root.classList.add(NS + '-shown');
          showUI(true);
        });
        open = true;
      }
      applyStripLayout();
      renderStrip();
      show(index, 0);
      // 首张立刻对齐，避免开局还要等一次平滑滚动
      syncPageToCurrent(true);
      bindLightboxGuard();
    }

    function close() {
      if (!open) return;
      stopAutoplay();
      open = false;
      root.classList.remove(NS + '-shown');
      hidePeek();
      hideUI();
      // 释放图片引用，避免内存占用
      if (imgEl) { imgEl.src = ''; imgEl = null; }
      imgWrap.innerHTML = '';
      // 退出时把页面停在「当前浏览的那张图」上，再撤掉调暗
      restoreScroll();
      Dimmer.off();
      setTimeout(() => {
        if (!open) root.classList.remove(NS + '-open');
      }, 200);
    }

    /**
     * 从「上次退出时停留的那张图」继续浏览。
     *
     * ⚠️ 关键点：绝不能写死 openAt(0)。
     * 页面未刷新时，index 是模块级变量、close() 并不会重置它，
     * 因此直接 openAt(index) 即可续读；若图片池在退出期间有增删，
     * setItems() 会按 key 重新定位 index，仍然能对上同一张图。
     * 另外做个兜底：index 越界/为负时回落到 0。
     */
    function resume() {
      if (!items.length) { toast('没有可浏览的图片'); return; }
      const i = (typeof index === 'number' && index >= 0 && index < items.length) ? index : 0;
      openAt(i);
    }

    function toggle() { open ? close() : resume(); }

    /* ---------------- 页面滚动联动 ----------------
     * 浏览图片时把原页面滚到该图片位置，好处：
     *   ① 退出浏览模式后，页面正好停在刚看过的那张图上
     *   ② 调暗层之后能透出「图片在原帖里的上下文」
     *
     * 实现要点：
     *   - 不锁 body 的 overflow（否则页面根本滚不动，功能无法成立）
     *   - 改为记录进入前的滚动位置，退出时「精确还原」+
     *     并把当前图再对齐一次，两者都是为了「退出即停在当前图」
     *   - 用 scrollIntoView(block:'center') 让目标图居中
     * ------------------------------------------------------------------ */
    let savedScroll = null;         // { x, y } 进入浏览模式前的页面滚动位置
    let anchorEl = null;            // 当前被高亮/对齐的原图元素

    /** 该图在页面里对应的原始 DOM 元素（背景图可能没有） */
    function elementOf(it) {
      if (!it) return null;
      const el = it.el;
      if (!el || el.nodeType !== 1 || !el.isConnected) return null;
      // 背景图情况：it.el 是承载元素本身，同样可滚
      return el;
    }

    function clearAnchor() {
      if (anchorEl) {
        try { anchorEl.classList.remove(NS + '-anchor'); } catch (e) {}
        anchorEl = null;
      }
    }

    /** 把当前浏览的图片在原页面中滚动到视口中央 */
    function syncPageToCurrent(instant) {
      if (!Config.get('syncPageScroll')) return;
      const it = current();
      const el = elementOf(it);
      if (!el) return;

      clearAnchor();
      anchorEl = el;
      try { el.classList.add(NS + '-anchor'); } catch (e) {}

      const behavior = instant ? 'auto' : (Config.get('syncScrollBehavior') || 'smooth');
      try {
        el.scrollIntoView({ behavior: behavior, block: 'center', inline: 'nearest' });
      } catch (e) {
        // 老浏览器不支持 options：退化为直接定位
        try { el.scrollIntoView(); } catch (e2) {}
      }
    }

    /**
     * 进入浏览模式：记录当前滚动位置。
     * 调暗层是 fixed 的，本身不影响页面滚动，因此这里无需任何锁定；
     * 只保存位置，供退出时兜底还原。
     */
    function rememberScroll() {
      if (savedScroll !== null) return;
      savedScroll = {
        x: window.pageXOffset || document.documentElement.scrollLeft || 0,
        y: window.pageYOffset || document.documentElement.scrollTop || 0
      };
    }

    /**
     * 退出浏览模式：把页面精确还原到「当前浏览图片」的位置。
     * 优先用 scrollIntoView 对齐目标图（体验更自然），
     * 若目标图已从页面移除，则退回进入前的滚动位置。
     */
    function restoreScroll() {
      const it = current();
      const el = elementOf(it);
      clearAnchor();

      if (el && Config.get('syncPageScroll')) {
        try {
          el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
        } catch (e) {
          try { el.scrollIntoView(); } catch (e2) {}
        }
      } else if (savedScroll) {
        try { window.scrollTo(savedScroll.x, savedScroll.y); } catch (e) {}
      }
      savedScroll = null;
    }

    /* ---------------- 显示某一张 ---------------- */

    function current() { return items[index] || null; }

    function show(i, dir) {
      if (!items.length) return;
      index = clamp(i, 0, items.length - 1);
      const it = items[index];
      if (!it) return;

      // 本次渲染的令牌（见 renderToken 声明处注释）
      const token = ++renderToken;

      // 重置缩放平移
      scale = 1; panX = 0; panY = 0;
      hidePeek();

      imgWrap.innerHTML = '';
      const img = document.createElement('img');
      img.className = NS + '-img';
      img.alt = it.name || '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.draggable = false;

      // 加载指示
      loaderEl = document.createElement('div');
      loaderEl.className = NS + '-loader';
      imgWrap.appendChild(loaderEl);
      imgWrap.appendChild(img);
      imgEl = img;

      if (Config.get('animation') && dir) img.classList.add(NS + '-slide-in');

      /* 计数、标题、箭头「立刻」同步，不等图片加载完成 ——
         缓存命中、load 事件丢失、网络挂起时界面依然正确 */
      syncCounter();
      updateMeta();
      updateNavDisabled();
      markSeen(it);
      // ⚠️ 顺序有讲究：先补渲染（虚拟化窗口可能不含当前图），再高亮 + 滚动。
      //    少了 scrollStripTo() 就会出现「高亮跑到缩略图条的显示范围之外」。
      ensureThumbVisible();
      updateStripCurrent();
      updateMinimap();

      const finish = () => {
        /* 令牌校验：快速切图时，上一张的 load 可能晚于新图到达。
           若不加这道闸，晚到的回调会把新图的布局按旧图尺寸重算、并把计数器改回去。 */
        if (token !== renderToken) return;
        if (loaderEl && loaderEl.parentNode) loaderEl.remove();
        loaderEl = null;
        it.w = img.naturalWidth || it.w;
        it.h = img.naturalHeight || it.h;
        fitImageEl();          // 基准尺寸 = 适应屏幕
        scale = 1; resetPan();
        applyTransform();
        syncCounter();
        updateMeta();
        updateStripCurrent();
        updateMinimap();
      };

      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', () => {
        if (token !== renderToken) return;
        if (loaderEl && loaderEl.parentNode) loaderEl.remove();
        loaderEl = null;
        renderFailure(it);
      }, { once: true });

      img.src = it.src;

      /* 关键：先用图片池已知的尺寸完成一次布局，不等 load。
         这样即使 load 事件丢失 / 图片来自缓存 / 网络挂起，
         首帧也已经按「适应屏幕」正确显示。
         load 触发后再用真实 naturalWidth 校准一次。 */
      fitImageEl();
      scale = 1; resetPan();
      applyTransform();
      if ((img.complete && img.naturalWidth) || (it.w && it.h)) finish();

      // 预取相邻
      ImagePool.prefetch(index + 1, 3);

      // 页面同步滚到这张图的位置（退出浏览模式时即停在此处）
      syncPageToCurrent(!dir);
    }

    function renderFailure(it) {
      imgWrap.innerHTML = '';
      const box = document.createElement('div');
      box.className = NS + '-fail';
      box.innerHTML = '<div>图片加载失败</div>';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '在新标签页打开原图';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isSafeExternalUrl(it.src)) { toast('该图片地址不受支持，已阻止打开'); return; }
        window.open(it.src, '_blank', 'noopener');
      });
      box.appendChild(b);
      imgWrap.appendChild(box);
      imgEl = null;
      syncCounter();
      updateMeta(true);
    }

    /** 可用区域尺寸（排除顶栏与缩略图条） */
    function stageSize() {
      const r = stage.getBoundingClientRect();
      const padTop = 58, padBottom = Config.get('thumbnailBar') && !root.classList.contains(NS + '-hidestrip') ? 18 : 18;
      const padX = 76;
      return {
        w: Math.max(80, r.width - padX * 2),
        h: Math.max(80, r.height - padTop - padBottom)
      };
    }

    /** 计算某张图「适应可用区」的显示尺寸（小图不放大，宽图限宽、长图限高） */
    function fitDims(nw, nh) {
      const s = stageSize();
      const k = Math.min(1, s.w / nw, s.h / nh);
      return { w: Math.max(1, Math.round(nw * k)), h: Math.max(1, Math.round(nh * k)), k };
    }

    /**
     * 把 <img> 的基准尺寸固定成「适应屏幕」尺寸。
     * 之后所有缩放平移都交给 imgWrap 的 transform，
     * 这样既不依赖 load 事件，也不会与 CSS max-width 重复叠加。
     */
    function fitImageEl() {
      if (!imgEl) return;
      const it = current();
      const nw = imgEl.naturalWidth || (it && it.w) || 0;
      const nh = imgEl.naturalHeight || (it && it.h) || 0;
      if (!nw || !nh) return;                 // 尺寸未知时先保持原样，load 后会再调
      const d = fitDims(nw, nh);
      imgEl.style.width = d.w + 'px';
      imgEl.style.height = d.h + 'px';
      return d;
    }

    function applyTransform() {
      if (!imgWrap) return;
      const it = current();
      if (!it) return;
      const nw = (imgEl && imgEl.naturalWidth) || it.w || 1;
      const nh = (imgEl && imgEl.naturalHeight) || it.h || 1;
      const s = stageSize();
      const base = fitDims(nw, nh);           // 基准显示尺寸
      const dispW = base.w * scale;          // 当前实际显示尺寸
      const dispH = base.h * scale;

      // 缩放范围：1 = 适应屏幕；上限「图片原始像素」(1/base.k) 与 maxZoom 取小
      const maxByPixel = base.k > 0 ? (1 / base.k) : 1;
      const maxScale = Math.max(1.01, Math.min(Number(Config.get('maxZoom')) || 8, maxByPixel * 4));
      scale = clamp(scale, 1, maxScale);

      // 平移只在图片超出可用区时生效
      const maxPanX = Math.max(0, (dispW - s.w) / 2);
      const maxPanY = Math.max(0, (dispH - s.h) / 2);
      panX = clamp(panX, -maxPanX, maxPanX);
      panY = clamp(panY, -maxPanY, maxPanY);

      imgWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      imgWrap.style.cursor = (maxPanX > 0 || maxPanY > 0) ? 'grab' : 'default';
      updateZoomBadge(scale);
      return { maxScale, maxPanX, maxPanY };
    }

    function resetPan() { panX = 0; panY = 0; }

    function zoomBy(factor, anchor) {
      const before = scale;
      let next = before * factor;
      if (Math.abs(next - before) < 0.001) return;
      // 以鼠标位置为锚点缩放（先算出目标倍率再平移补偿）
      if (anchor && imgWrap) {
        const rect = imgWrap.getBoundingClientRect();
        const cx = anchor.x - (rect.left + rect.width / 2);
        const cy = anchor.y - (rect.top + rect.height / 2);
        scale = next;
        applyTransform();               // 内部会夹紧 scale
        panX -= cx * (scale / before - 1);
        panY -= cy * (scale / before - 1);
        applyTransform();
        return;
      }
      scale = next;
      applyTransform();
    }

    /** 适应屏幕：基准倍率 1（applyTransform 会夹紧到合法区间） */
    function fitToScreen() {
      if (!imgEl) { flashZoom('适应屏幕'); return; }
      scale = 1;
      resetPan();
      applyTransform();
      flashZoom('适应屏幕');
    }

    /** 原始大小：倍率 = 1 / 基准缩放比，即 1 个原始像素 : 1 个屏幕像素 */
    function actualSize() {
      if (!imgEl) return;
      const it = current();
      const nw = imgEl.naturalWidth || (it && it.w) || 1;
      const nh = imgEl.naturalHeight || (it && it.h) || 1;
      const base = fitDims(nw, nh);
      scale = base.k > 0 ? (1 / base.k) : 1;
      resetPan();
      applyTransform();
      flashZoom('原始大小 100%');
    }

    /* ---------------- 顶栏信息 ---------------- */

    function syncCounter() {
      if (!counterEl) return;
      counterEl.textContent = (index + 1) + ' / ' + items.length;
      // 分组浏览时给个明确标识，避免误以为在翻全页
      if (scopeEl) {
        if (scope) {
          const t = scope.label || '本组';
          scopeEl.textContent = t + ' · ' + items.length + ' 张';
          scopeEl.hidden = false;
        } else {
          scopeEl.hidden = true;
          scopeEl.textContent = '';
        }
      }
    }

    function updateMeta(failed) {
      if (!metaEl) return;
      const it = current();
      if (!it) { metaEl.textContent = ''; return; }
      const w = it.w || 0, h = it.h || 0;
      metaEl.textContent = failed ? '加载失败' : (w && h ? w + ' × ' + h : '');
      if (titleEl) titleEl.textContent = it.name || '';
    }

    function updateNavDisabled() {
      if (prevBtn) prevBtn.disabled = index <= 0;
      if (nextBtn) nextBtn.disabled = index >= items.length - 1;
    }

    /* ---------------- 组间连续浏览 ----------------
     * 需求：一个组看完了，应该能顺畅地接着看下一个组，而不是被卡住。
     *
     * 设计取舍：**不把跨组做成默认行为**（那会让「只看这组」的语义失效，
     * 用户以为在组内翻阅却悄悄串到别的帖子），而是：
     *   · 组内到达边界时，若开启了「组间续览」则自动切到相邻组；
     *   · 未开启时，在边界处给出明确提示（toast），并支持一键跳转。
     * 这样默认行为可预期，主动开启的用户也能连贯浏览。
     * -------------------------------------------------- */
    let lastEdgeToastAt = 0;

    /** 当前组在 groups() 列表中的位置；不在分组浏览时返回 -1 */
    function scopeGroupIndex(list) {
      const gs = list || ImagePool.groups(2);
      if (!scope) return -1;
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i];
        if (g.items.length && scope.keys.has(g.items[0].key)) return i;
      }
      return -1;
    }

    function gotoAdjacentGroup(delta) {
      const gs = ImagePool.groups(2);
      if (gs.length < 2) return false;
      const cur = scopeGroupIndex(gs);
      // 未在分组内：按当前图片所属组定位，否则从头/尾开始
      let target;
      if (cur < 0) {
        const it = items[index];
        const own = it && it.el ? ImagePool.groupOf(it.el) : null;
        const ownId = own && own.items.length ? own.items[0].key : null;
        let pos = ownId ? gs.findIndex((g) => g.items[0].key === ownId) : -1;
        if (pos < 0) pos = delta > 0 ? -1 : gs.length;
        target = gs[pos + delta];
      } else {
        target = gs[cur + delta];
      }
      if (!target || !target.items.length) return false;
      const first = target.items[0];
      if (!first || !first.el) return false;
      const okOpen = openGroup(first.el, { label: target.label });
      if (okOpen) { index = 0; show(0, 0); }
      return okOpen;
    }

    /** 向后翻页（含组间续览） */
    function navNext() {
      if (index < items.length - 1) { show(index + 1, 1); return; }
      if (scope && Config.get('groupChaining')) {
        if (gotoAdjacentGroup(1)) return;
      }
      edgeToast('已是本组最后一张', 1);
    }

    /** 向前翻页（含组间续览） */
    function navPrev() {
      if (index > 0) { show(index - 1, -1); return; }
      if (scope && Config.get('groupChaining')) {
        if (gotoAdjacentGroup(-1)) return;
      }
      edgeToast('已是本组第一张', -1);
    }

    /** 边界提示：节流 + 有相邻组时提示可用 L 打开目录 */
    function edgeToast(msg, dir) {
      const now = Date.now();
      if (now - lastEdgeToastAt < 1200) return;   // 连按不刷屏
      lastEdgeToastAt = now;
      const neighbor = scope ? gotoAdjacentGroupPeek(dir) : null;
      if (neighbor) {
        toast(msg + ' · 可在设置中开启「组间续览」自动继续');
      } else {
        toast(msg);
      }
    }

    /** 探测相邻组是否存在（不产生副作用） */
    function gotoAdjacentGroupPeek(delta) {
      const gs = ImagePool.groups(2);
      const cur = scopeGroupIndex(gs);
      if (cur < 0) return null;
      return gs[cur + delta] || null;
    }

    /* ---------------- UI 自动隐藏 ---------------- */

    function showUI(keep) {
      if (!root) return;
      root.classList.add(NS + '-ui');
      if (uiTimer) clearTimeout(uiTimer);
      if (!keep) {
        uiTimer = setTimeout(() => {
          if (root.classList.contains(NS + '-dragging')) return;
          hideUI();
        }, 2400);
      }
    }

    function hideUI() {
      if (!root) return;
      root.classList.remove(NS + '-ui');
      // 隐藏箭头之外的 UI 时，让 strip 也收回（若用户没锁住）
    }

    function maybeShowUI(e) {
      showUI(false);
    }

    /**
     * 确保当前图对应的缩略图在视野内。**每次切图都要调**。
     *
     * 两种情况要分别处理：
     *  1. **虚拟化窗口不含当前下标**（>120 张且跳得较远）。
     *     此时 track 里根本没有那个 thumb，必须按新下标重算窗口并重渲染，
     *     否则会出现「条里根本没有当前图」= 数量与实际浏览数对不上。
     *  2. **窗口含但不在视野内**。滚过去即可。
     *
     * 只滚动不定居中：若当前图已经可见则不动，避免每翻一张都甩一下镜头。
     */
    function ensureThumbVisible() {
      if (!track || !Config.get('thumbnailBar')) return;
      const i = index;
      let el = track.querySelector('.' + NS + '-thumb[data-i="' + i + '"]');
      if (!el) {
        // 情况 1：虚拟窗口没覆盖当前图 → 重算窗口并重渲染
        renderStrip();
        el = track.querySelector('.' + NS + '-thumb[data-i="' + i + '"]');
        if (!el) return;   // 兜底：仍找不到就放弃滚动，不阻断切图
        scrollStripTo(i, false);
        return;
      }
      // 情况 2：已渲染但可能不可见 → 判断后滚动
      const viewL = track.scrollLeft;
      const viewR = viewL + track.clientWidth;
      const left = el.offsetLeft;
      const right = left + el.offsetWidth;
      if (left < viewL || right > viewR) scrollStripTo(i, false);
    }

    /* ---------------- 缩略图条 ---------------- */

    function applyStripLayout() {
      if (!root) return;
      const on = !!Config.get('thumbnailBar');
      root.classList.toggle(NS + '-hasstrip', on);
      root.style.setProperty('--fiv-strip', (Config.get('thumbSize') || 64) + 'px');
      root.style.setProperty('--fiv-thumb', (Config.get('thumbSize') || 64) + 'px');
    }

    function renderStrip() {
      if (!root) return;
      applyStripLayout();
      if (!Config.get('thumbnailBar')) { track.innerHTML = ''; updateMinimap(); return; }

      const thumbH = Config.get('thumbSize') || 64;
      const need = items.length;
      // 虚拟化：当数量很大时只渲染窗口内 + 缓冲
      const VIRTUAL_THRESHOLD = 120;
      track.innerHTML = '';
      const frag = document.createDocumentFragment();

      if (need <= VIRTUAL_THRESHOLD) {
        for (let i = 0; i < need; i++) frag.appendChild(makeThumb(i, thumbH));
      } else {
        const win = computeVirtualWindow(need);
        for (let i = win.from; i < win.to; i++) frag.appendChild(makeThumb(i, thumbH));
      }
      track.appendChild(frag);
      updateStripCurrent();
      updateMinimap();
      // 注意：这里**不**调 scrollStripTo。滚动统一由 ensureThumbVisible() 负责，
      // 它会先判断「是否真的不可见」，只有需要时才滚。渲染时无条件滚动
      // 会导致每次重建缩略条都甩一下镜头（虚拟化下翻图会频繁重建）。
    }

    /** 构建单个缩略图（序号角标 + 已看小点 + 悬停预览） */
    function makeThumb(i, thumbH) {
      const it = items[i];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = NS + '-thumb';
      el.dataset.i = String(i);
      el.style.width = (thumbH * 1.25) + 'px';
      el.style.height = thumbH + 'px';
      el.title = it.name || '';
      if (seenKeys.has(it.key)) el.classList.add(NS + '-seen');
      el.innerHTML =
        '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">' +
        '<span class="' + NS + '-idx">' + (i + 1) + '</span>' +
        '<span class="' + NS + '-seen-dot"></span>';
      const im = el.querySelector('img');
      im.src = it.src;
      im.addEventListener('error', () => { im.style.visibility = 'hidden'; }, { once: true });
      el.addEventListener('click', (e) => {
        // 拖动条横向拖动后产生的 click 已由 bindStripDrag 的 swallow 拦掉；
        // 能走到这里的就是真实点选，直接切图。
        e.stopPropagation();
        show(i, i > index ? 1 : -1);
      });
      el.addEventListener('mouseenter', (e) => showPeek(el, it));
      el.addEventListener('mouseleave', hidePeek);
      return el;
    }

    /** 高亮当前缩略图 */
    function updateStripCurrent() {
      if (!track) return;
      const cur = track.querySelector('.' + NS + '-thumb.' + NS + '-cur');
      if (cur) cur.classList.remove(NS + '-cur');
      const el = track.querySelector('.' + NS + '-thumb[data-i="' + index + '"]');
      if (el) el.classList.add(NS + '-cur');
    }

    /**
     * 滚动缩略图条，让第 i 张进入视野。
     * smooth=true 时临时开启平滑（平时 track 用 auto，见 CSS 注释）。
     */
    function scrollStripTo(i, smooth) {
      if (!track || !Config.get('thumbnailBar')) return;
      const el = track.querySelector('.' + NS + '-thumb[data-i="' + i + '"]');
      if (!el) return;   // 虚拟化窗口外：不强行渲染，交由 renderStrip 决定
      const target = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
      const left = Math.max(0, target);
      if (smooth) {
        track.style.scrollBehavior = 'smooth';
        track.scrollLeft = left;
        setTimeout(() => { if (track) track.style.scrollBehavior = ''; }, 320);
      } else {
        track.scrollLeft = left;
      }
    }

    /** 迷你进度条：按全局位置补回「我在哪」 */
    function updateMinimap() {
      if (!minimapEl) return;
      const on = !!Config.get('thumbnailBar') && items.length > 1;
      minimapEl.classList.toggle(NS + '-on', on);
      const total = items.length;
      if (!total) { minimapFill.style.width = '0%'; minimapHead.style.left = '0%'; return; }
      const pct = ((index + 1) / total) * 100;
      minimapFill.style.width = pct.toFixed(2) + '%';
      minimapHead.style.left = (total > 1 ? (index / (total - 1)) * 100 : 0).toFixed(2) + '%';
    }

    /** 悬停缩略图时的放大预览 */
    function showPeek(el, it) {
      if (!peekEl) return;
      const r = el.getBoundingClientRect();
      peekEl.dataset.src = it.src;
      const im = peekEl.querySelector('img');
      if (im) im.src = it.src;
      const nameEl = peekEl.querySelector('.' + NS + '-peek-name');
      if (nameEl) nameEl.textContent = it.name || '';
      peekEl.style.left = (r.left + r.width / 2) + 'px';
      peekEl.style.top = r.top + 'px';
      peekEl.classList.add(NS + '-on');
      // 贴边收正，避免跑出视口
      const pr = peekEl.getBoundingClientRect();
      if (pr.left < 6) peekEl.style.left = (r.left + r.width / 2 - pr.left + 6) + 'px';
      if (pr.right > window.innerWidth - 6) peekEl.style.left = (r.left + r.width / 2 - (pr.right - window.innerWidth + 6)) + 'px';
    }

    function hidePeek() {
      if (peekEl) peekEl.classList.remove(NS + '-on');
    }

    /** 记录「已看过」 */
    function markSeen(it) {
      if (!it) return;
      if (!seenKeys.has(it.key)) {
        seenKeys.add(it.key);
        // 同步已渲染的缩略图角标
        if (track) {
          const el = track.querySelector('.' + NS + '-thumb[data-i="' + index + '"]');
          if (el) el.classList.add(NS + '-seen');
        }
      }
    }

    function computeVirtualWindow(total) {
      const thumbW = (Config.get('thumbSize') || 64) * 1.25 + 7;
      const perScreen = Math.ceil(window.innerWidth / thumbW) + 1;
      const center = index;
      const half = Math.ceil(perScreen / 2) + 12;
      return { from: Math.max(0, center - half), to: Math.min(total, center + half + 1) };
    }

    /* ---------------- 缩放徽标 ---------------- */

    let zoomBadgeTimer = null;
    /** 徽标显示相对于「适应屏幕」的百分比：100% 即刚好铺满可用区 */
    function updateZoomBadge(cur) {
      if (!zoomBadge) return;
      zoomBadge.textContent = Math.round((cur || 1) * 100) + '%';
    }
    function flashZoom(text) {
      if (!zoomBadge) return;
      const old = zoomBadge.textContent;
      zoomBadge.textContent = text;
      zoomBadge.classList.add(NS + '-on');
      if (zoomBadgeTimer) clearTimeout(zoomBadgeTimer);
      zoomBadgeTimer = setTimeout(() => {
        zoomBadge.classList.remove(NS + '-on');
        zoomBadge.textContent = old;
      }, 900);
    }

    /* ---------------- 自动播放 ---------------- */

    function toggleAutoplay() {
      if (autoplayTimer) { stopAutoplay(); toast('已停止自动播放'); return; }
      const ms = Math.max(600, Number(Config.get('autoplayInterval')) || 3000);
      autoplayTimer = setInterval(() => {
        if (!open) { stopAutoplay(); return; }
        const next = (index + 1) % items.length;
        show(next, 1);
      }, ms);
      if (btnPlay) btnPlay.innerHTML = ICONS.pause;
      toast('自动播放：每 ' + (ms / 1000).toFixed(1) + ' 秒一张');
    }
    function stopAutoplay() {
      if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
      if (btnPlay) btnPlay.innerHTML = ICONS.play;
    }

    /* ---------------- 附加操作 ---------------- */

    function downloadCurrent() {
      const it = current(); if (!it) return;
      // 安全：下载属于「外部动作」，只放行 http/https
      if (!isSafeExternalUrl(it.src)) { toast('该图片地址不受支持，已阻止下载'); return; }
      const a = document.createElement('a');
      a.href = it.src;
      a.download = it.name || 'image';
      a.referrerPolicy = 'no-referrer';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已开始下载：' + (it.name || ''));
    }

    /* ---------------- 批量打包下载 ---------------- */

    let packEl = null, packTxt = null, packFill = null, packDetail = null, packCtrl = null;
    let packAbort = null;

    function ensurePackUI() {
      if (packEl) return;
      packEl = document.createElement('div');
      packEl.className = NS + '-pack';
      packEl.innerHTML =
        '<div class="' + NS + '-pack-row">' +
        '<span class="' + NS + '-pack-txt"></span>' +
        '<button class="' + NS + '-pack-cancel" type="button">取消</button>' +
        '</div>' +
        '<div class="' + NS + '-pack-bar"><div class="' + NS + '-pack-fill"></div></div>' +
        '<div class="' + NS + '-pack-detail"></div>';
      document.documentElement.appendChild(packEl);
      packTxt = packEl.querySelector('.' + NS + '-pack-txt');
      packFill = packEl.querySelector('.' + NS + '-pack-fill');
      packDetail = packEl.querySelector('.' + NS + '-pack-detail');
      packCtrl = packEl.querySelector('.' + NS + '-pack-cancel');
      packCtrl.addEventListener('click', () => {
        if (packAbort) { packAbort.abort(); packAbort = null; }
      });
    }

    function packShow(msg, ratio) {
      ensurePackUI();
      packEl.classList.add(NS + '-on');
      packTxt.textContent = msg;
      packDetail.textContent = '';
      if (typeof ratio === 'number') packFill.style.width = Math.round(ratio * 100) + '%';
    }
    function packDetailSet(lines) {
      if (!packDetail) return;
      packDetail.textContent = lines.join('\n');
    }
    function packFinishDelay(ms) {
      setTimeout(() => {
        if (packEl) packEl.classList.remove(NS + '-on');
        packAbort = null;
      }, ms || 4000);
    }

    /**
     * 打包下载。
     * @param {'group'|'all'} mode
     */
    async function packDownload(mode) {
      if (packAbort) { toast('已有打包任务在进行'); return; }
      // 取快照：组模式只取当前组，全部模式取整池。
      // ⚠️ 必须 slice()：打包期间用户可能切图/换组，不能让下载过程读可变状态。
      const list = mode === 'group' ? items.slice() : ImagePool.items.slice();
      if (!list.length) { toast('没有可下载的图片'); return; }

      const label = mode === 'group' ? '本组' : '全部';
      const ctrl = new AbortController();
      packAbort = ctrl;
      packShow('准备打包' + label + ' · 共 ' + list.length + ' 张', 0);

      let res;
      try {
        res = await ImageDownloader.download(list, {
          zipName: (document.title || 'images').slice(0, 60) + '_' + label,
          signal: ctrl.signal,
          onProgress: (done, total, phase) => {
            if (phase === 'zip') {
              packShow('正在打包 ' + total + ' 张…', 1);
            } else {
              packShow('正在获取 ' + done + '/' + total + ' 张…',
                total ? (done / total) * 0.95 : 0);
            }
          }
        });
      } catch (e) {
        packAbort = null;
        packShow('打包失败：' + ((e && e.message) || e), 0);
        packFinishDelay(5000);
        return;
      }
      packAbort = null;

      if (res.cancelled) {
        packShow('已取消', 0);
        packFinishDelay(2600);
        return;
      }

      if (!res.ok) {
        // 全部失败是最需要说清楚的一种情况：用户点了按钮却什么都没拿到。
        // 必须把「为什么」直接摆在界面上，否则等同于没反应。
        const first = res.failed[0];
        let hint = '';
        if (first) {
          const r = first.reason || '';
          if (!ImageDownloader.hasGmXhr()) {
            hint = '\n可能原因：油猴未授予 GM_xmlhttpRequest 权限，跨域图无法绕过浏览器同源策略。';
          } else if (/Failed to fetch|NetworkError|load failed|跨域请求失败/i.test(r)) {
            hint = '\n可能原因：图床校验 Referer、要求登录 Cookie，或该图已被删除。';
          } else if (/^HTTP 4/.test(r)) {
            hint = '\n可能原因：图片需要登录态或已失效（404/403）。';
          } else if (/超时|abort/i.test(r)) {
            hint = '\n可能原因：网络过慢，单张超过 20 秒未响应。';
          }
        }
        packShow('全部 ' + res.failed.length + ' 张都获取失败' + hint, 0);
        packDetailSet(res.failed.slice(0, 20).map((f) => '× ' + shortSrc(f.item) + ' — ' + f.reason));
        packFinishDelay(10000);
        return;
      }

      const sizeMb = (res.bytes / 1048576).toFixed(1);
      const viaNote = (res.via && res.via.gm)
        ? '（' + res.via.fetch + ' 直连 + ' + res.via.gm + ' 跨域通道）'
        : '';
      // ⚠️ 主文案必须同时报成功与失败数：只写「已打包 2 张」会让用户以为另外 2 张
      //    根本不存在，误以为功能有问题。失败明细在下方，但主文案要给出全貌。
      packShow(res.failed.length
        ? '✅ 已打包 ' + res.ok + ' 张 · ' + sizeMb + ' MB（' + res.failed.length + ' 张失败，见下方）' + viaNote
        : '✅ 已打包 ' + res.ok + ' 张 · ' + sizeMb + ' MB' + viaNote, 1);
      if (res.failed.length) {
        packDetailSet(
          ['⚠️ 有 ' + res.failed.length + ' 张未能获取：']
            .concat(res.failed.slice(0, 20).map((f) => '× ' + shortSrc(f.item) + ' — ' + f.reason))
            .concat(res.failed.length > 20 ? ['… 其余 ' + (res.failed.length - 20) + ' 张略'] : [])
        );
      }
      packFinishDelay(res.failed.length ? 9000 : 4000);
    }

    /** 失败清单里展示用的精简地址 */
    function shortSrc(it) {
      const s = (it && it.src) || '';
      return s.length > 70 ? s.slice(0, 67) + '…' : s;
    }

    async function copyCurrentLink() {
      const it = current(); if (!it) return;
      try {
        await navigator.clipboard.writeText(it.src);
        toast('已复制图片链接');
      } catch (e) {
        // 降级：临时 textarea
        const ta = document.createElement('textarea');
        ta.value = it.src;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制图片链接'); }
        catch (e2) { toast('复制失败，请手动复制'); }
        ta.remove();
      }
    }

    function openCurrentInTab() {
      const it = current(); if (!it) return;
      // 安全：外部导航只放行 http/https，避免 javascript:/data: 等脏 scheme
      if (!isSafeExternalUrl(it.src)) { toast('该图片地址不受支持，已阻止打开'); return; }
      window.open(it.src, '_blank', 'noopener');
    }

    /* ---------------- 站点灯箱禁用 ----------------
     * 论坛常把「点击图片放大」绑定在文档级（事件委托）。
     * 激活期间于「捕获阶段」截住落在图片上的 click，
     * 高优先级（window + capture）先于站点监听执行，从而吞掉灯箱触发。
     * 仅拦截图片本体，不影响页面其它点击；关闭后立即失效。
     * ------------------------------------------------------------------ */
    let lightboxGuardBound = false;
    function lightboxGuard(e) {
      if (!open) return;
      if (!Config.get('disableSiteLightbox')) return;
      const t = e.target;
      if (!t || t.nodeType !== 1) return;
      // 我方 UI 内部不拦
      if (root && root.contains(t)) return;
      const hit = t.tagName === 'IMG' ? t : (t.closest ? t.closest('img') : null);
      if (!hit) return;
      // 图片上的点击 → 阻止站点灯箱
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    }

    function bindLightboxGuard() {
      if (lightboxGuardBound) return;
      lightboxGuardBound = true;
      // capture + window 最外层：跑在站点任何委托监听之前
      ['click', 'mousedown', 'dblclick'].forEach((ev) => {
        window.addEventListener(ev, lightboxGuard, true);
      });
    }

    /* ---------------- 事件 ---------------- */

    function bindEvents() {
      /* 顶部按钮 */
      topBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'close') close();
        else if (act === 'download') downloadCurrent();
        else if (act === 'pack-group') {
          // 「本组」只在分组浏览态下有意义；全局浏览时降级为「全部」并明确告知
          if (!scope) { toast('当前未进入分组，改为打包全部图片'); packDownload('all'); }
          else packDownload('group');
        }
        else if (act === 'copy') copyCurrentLink();
        else if (act === 'open') openCurrentInTab();
        else if (act === 'play') toggleAutoplay();
        else if (act === 'settings') { if (window.__fivOpenSettings) window.__fivOpenSettings(); }
        else if (act === 'hide-strip') {
          root.classList.toggle(NS + '-hidestrip');
          flashZoom(root.classList.contains(NS + '-hidestrip') ? '缩略图条已隐藏' : '缩略图条已显示');
        }
      });

      /* 左右箭头 */
      prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navPrev(); });
      nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navNext(); });

      /* 舞台：滚轮导航 / 缩放 */
      stage.addEventListener('wheel', onWheel, { passive: false });

      /* 舞台：拖动平移 */
      stage.addEventListener('mousedown', onDragStart);
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);

      /* 双击：适应屏幕 ⇄ 原始大小 */
      stage.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (scale <= 1.005) actualSize(); else fitToScreen();
      });

      /* 鼠标移动 → 显示 UI */
      root.addEventListener('mousemove', (e) => {
        maybeShowUI(e);
        const r = stage.getBoundingClientRect();
        if (e.clientY > r.bottom - 30) showUI(true);
      });
      root.addEventListener('mouseenter', () => showUI(false));

      /* 点击空白关闭 */
      backdrop.addEventListener('click', () => close());
      stage.addEventListener('click', (e) => {
        if (e.target === stage || e.target === imgWrap) close();
      });
      /* 阻止遮罩层内的事件冒泡到论坛页面 */
      ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'keypress']
        .forEach((ev) => root.addEventListener(ev, (e) => {
          e.stopPropagation();
        }, false));

      /* 缩略图条拖拽 */
      bindStripDrag();

      /* 窗口尺寸变化：重新适应屏幕（窗口变了，基准尺寸也要跟着变） */
      window.addEventListener('resize', debounce(() => {
        if (!open) return;
        const it = current(); if (!it) return;
        fitImageEl();
        applyTransform();
        scrollStripTo(index, true);
      }, 150));
    }

    function onWheel(e) {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();

      // Ctrl+滚轮 始终缩放；开启「滚轮缩放」后悬停图片时滚轮也缩放
      const wantZoom = e.ctrlKey || (Config.get('wheelZoom') && overImage(e));
      if (wantZoom) {
        const factor = e.deltaY < 0 ? 1 + (Config.get('zoomStep') || 0.25) : 1 / (1 + (Config.get('zoomStep') || 0.25));
        zoomBy(factor, { x: e.clientX, y: e.clientY });
        return;
      }

      if (!Config.get('wheelNavigate')) return;
      // 节流累计，避免一次滚动条事件跳多张
      if (Date.now() - (onWheel._t || 0) < 220) return;
      const dy = e.deltaY;
      if (Math.abs(dy) < 2) return;
      onWheel._t = Date.now();
      if (dy > 0) navNext();
      else navPrev();
    }

    function overImage(e) {
      if (!imgEl) return false;
      const r = imgEl.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    function onDragStart(e) {
      if (e.button !== 0) return;
      const it = current(); if (!it) return;
      const s = stageSize();
      const nw = (imgEl && imgEl.naturalWidth) || it.w || 1;
      const nh = (imgEl && imgEl.naturalHeight) || it.h || 1;
      const base = fitDims(nw, nh);
      // 只有「实际显示尺寸超过可用区」时才可拖动
      const canPan = (base.w * scale > s.w + 1) || (base.h * scale > s.h + 1);
      if (!canPan) return;
      dragging = true; dragMoved = false;
      imgWrap.classList.add(NS + '-dragging');
      root.classList.add(NS + '-dragging');
      startX = e.clientX; startY = e.clientY;
      startPanX = panX; startPanY = panY;
      e.preventDefault();
    }
    let startX = 0, startY = 0, startPanX = 0, startPanY = 0;

    function onDragMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
      panX = startPanX + dx;
      panY = startPanY + dy;
      applyTransform();
    }

    function onDragEnd() {
      if (!dragging) return;
      dragging = false;
      if (imgWrap) imgWrap.classList.remove(NS + '-dragging');
      if (root) root.classList.remove(NS + '-dragging');
      setTimeout(() => { dragMoved = false; }, 60);
    }

    /**
     * 缩略图条拖拽快速翻阅。
     *
     * 每次踩坑都值得记下来 —— 这个函数已经被指针语义坑了三次：
     *
     *  1. **允许在缩略图上直接起拖**（v1.5）。旧逻辑遇到 .fiv-thumb 就 return，
     *     而缩略图几乎铺满整条，实际只剩几像素的间隙能拖 → 「拖不动」。
     *     现在任意位置按下都可拖，靠位移阈值区分「点击」与「拖动」。
     *
     *  2. **指针捕获必须推迟到越过阈值**（v1.5.1）。若在 pointerdown 就
     *     setPointerCapture，浏览器会把 pointerup 与 click 一并重定向到 strip，
     *     缩略图的 click 监听器收不到 → 「能滚但点不动」。
     *
     *  3. **.fiv-dragging 也必须推迟到越过阈值**（v1.5.2）。
     *     该类的 CSS 会把 .fiv-thumb 设成 pointer-events:none。
     *     若按下就加：浏览器做按下命中测试时跳过缩略图、命中落到 strip；
     *     松手时类已移除、命中恢复为缩略图。click 的 target = 两次命中的
     *     最近公共祖先 = strip → 缩略图 click 依旧收不到 → 「还是点不动」。
     *
     * 教训：**凡是会改变命中测试（pointer-events / 捕获）的状态，
     * 都不能在 pointerdown 里设置**，必须等拖动意图确认后再设。
     * 而 jsdom 不模拟命中测试，所以这些 bug 只能靠手工模拟 + 真机验证兜住。
     */
    function bindStripDrag() {
      if (!strip || !track) return;
      let down = false, moved = false, sx = 0, sl = 0, pid = null;
      const THRESHOLD = 3;

      const finish = (e) => {
        if (!down) return;
        down = false;
        if (pid != null) {
          try { strip.releasePointerCapture(pid); } catch (err) {}
          pid = null;
        }
        strip.classList.remove(NS + '-dragging');
        // 拖动过 → 抑制随后那次 click，避免误切图
        if (moved) {
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          strip.addEventListener('click', swallow, { capture: true, once: true });
          setTimeout(() => strip.removeEventListener('click', swallow, true), 320);
        }
      };

      strip.addEventListener('pointerdown', (e) => {
        // 只响应主键 / 触摸
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        down = true; moved = false;
        sx = e.clientX; sl = track.scrollLeft;
        pid = e.pointerId;
        // ⚠️ 这里**不加** .fiv-dragging，也**不** setPointerCapture。
        //    两者的原因都是「不能破坏随后的 click」：
        //
        //    (1) .fiv-dragging 的 CSS 会把 .fiv-thumb 设为 pointer-events:none。
        //        若在按下时就加，浏览器做**按下命中测试**时会跳过缩略图、
        //        把命中落到 strip 上；而松手时 finish() 已移除该类、命中恢复为缩略图。
        //        浏览器 click 的 target = 按下命中 ∩ 松手命中的最近公共祖先
        //        = strip → 缩略图自身的 click 监听器**永不触发** = 「点不动」。
        //        （这正是 v1.5.1 漏掉的第二根因，jsdom 不模拟命中测试所以测试全绿。）
        //    (2) setPointerCapture 会把 pointerup 与 click 一并重定向到 strip，
        //        同样让缩略图收不到 click。
        //    → 二者都推迟到「真正越过拖动阈值」时再做。
      });

      strip.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dx = e.clientX - sx;
        if (!moved && Math.abs(dx) > THRESHOLD) {
          moved = true;
          // 确认为拖动：此刻才加拖拽态（关闭缩略图指针响应，防原生图片拖拽）
          strip.classList.add(NS + '-dragging');
          // 并捕获指针，保证拖出 strip 外也能持续滚动
          try { strip.setPointerCapture(pid); } catch (err) {}
        }
        if (moved) track.scrollLeft = sl - dx;
      });

      strip.addEventListener('pointerup', finish);
      strip.addEventListener('pointercancel', finish);

      /* 滚轮：横向滚动缩略图条（不调用 scrollStripTo，避免把刚滚到的位置又拉回当前图） */
      strip.addEventListener('wheel', (e) => {
        if (e.target.closest && e.target.closest('.' + NS + '-minimap')) return; // 留给进度条
        e.preventDefault(); e.stopPropagation();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        track.scrollLeft += d;
      }, { passive: false });
    }

    /* 全局键盘 */
    function onKey(e) {
      if (!open) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      const k = e.key;
      let handled = true;
      // ⚠️ 打包下载用 Shift+D，必须在 switch 之前拦截：
      //    单独按 D 已被「下一张」占用（case 'd'），走到那里就轮不到 Shift 组合了。
      if (e.shiftKey && (k === 'D' || k === 'd')) {
        if (scope) packDownload('group');
        else { toast('当前未进入分组，改为打包全部图片'); packDownload('all'); }
        e.preventDefault(); e.stopPropagation();
        return;
      }
      switch (k) {
        case 'Escape':
          // 分组浏览时：第一下 Esc 退出分组回到全部，第二下才关闭浏览器。
          // 这样「以图定域」的进入有对应的、不丢当前图位置的退路。
          if (scope) { const k0 = items[index] && items[index].key; clearScope(); if (k0) index = Math.max(0, items.findIndex((it) => it.key === k0)); show(index, 0); toast('已切回浏览全部'); }
          else close();
          break;
        case 'g': case 'G':
          // 显式：在当前图片所在的组 / 全部 之间切换
          if (scope) { clearScope(); toast('已切回浏览全部'); }
          else { const it = current(); if (it && it.el) openGroup(it.el, { silent: true }); else toast('当前图片无法分组'); }
          if (open) show(Math.min(index, items.length - 1), 0);
          break;
        case 'ArrowRight': case 'ArrowDown': case 'd': case 'D':
          navNext(); break;
        case 'ArrowLeft': case 'ArrowUp': case 'a': case 'A':
          navPrev(); break;
        case 'Home': show(0, 1); break;
        case 'End': show(items.length - 1, -1); break;
        case ' ':
          toggleAutoplay(); break;
        case '+': case '=': zoomBy(1 + (Config.get('zoomStep') || 0.25), null); break;
        case '-': case '_': zoomBy(1 / (1 + (Config.get('zoomStep') || 0.25)), null); break;
        case 'f': case 'F': fitToScreen(); break;
        case '1': actualSize(); break;
        case 't': case 'T': root.classList.toggle(NS + '-hidestrip'); break;
        case 'c': case 'C': copyCurrentLink(); break;
        case 'o': case 'O': openCurrentInTab(); break;
        case '?':
          if (e.shiftKey) { if (window.__fivOpenSettings) window.__fivOpenSettings(); }
          else handled = false;
          break;
        default:
          if (k === '/' && e.shiftKey) { if (window.__fivOpenSettings) window.__fivOpenSettings(); }
          else handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
    window.addEventListener('keydown', onKey, true);

    return {
      openAt, resume, close, toggle,
      openGroup, clearScope,
      get isOpen() { return open; },
      get index() { return index; },
      get inGroup() { return !!scope; },
      setItems, show,
      refreshTheme() {
        if (root) applyThemeVars(ThemeProbe.probe(), root);
      },
      rebuildStrip() { if (root) { applyStripLayout(); renderStrip(); } },
      /** 供外部（配置变更时）触发一次页面同步滚动 */
      syncPageNow() { if (open) syncPageToCurrent(false); },
      get trackEl() { return track; },
      get itemCount() { return items.length; },
      /* —— 组间导航 —— */
      navNext, navPrev, gotoAdjacentGroup,
      /* —— 批量打包下载 —— */
      packDownload,
      get groupCount() { return ImagePool.groups(2).length; }
    };
  })();

  /* =========================================================================
   * 5.5 HoverBadge —— 图片悬停角标（「以图定域」的默认入口）
   *
   * 设计取舍：**单例浮动按钮**，而不是给每张图都注入一个节点。
   *   · 不污染站点 DOM，不触发站点样式重排（论坛页面动辄几百张图）
   *   · 动态加载的新图天然适用：只需在 mousemove 时判断命中即可
   *   · 移开即隐，页面保持安静
   *
   * 命中判定：鼠标下的元素（或最近祖先）是「已入池的内容图」才显示。
   *   —— 复用图片池的过滤结果，头像/表情/小图不会冒出角标。
   * 点击行为：进入「该图所属那一组」的浏览（退化到全局时自动回退）。
   * ========================================================================= */

  const HoverBadge = (() => {
    let el = null;
    let curImg = null;       // 当前悬停的图片元素
    let hideTimer = null;
    let bound = false;

    function build() {
      if (el && el.isConnected) return el;
      el = document.createElement('button');
      el.type = 'button';
      el.className = NS + '-badge';
      el.innerHTML = ICONS.photo + '<span></span>';
      el.setAttribute('aria-label', '浏览这一组图片');
      // 按钮自身也参与"悬停保持"，避免鼠标从图移到按钮途中角标闪没
      el.addEventListener('mouseenter', () => { if (hideTimer) clearTimeout(hideTimer); });
      el.addEventListener('mouseleave', scheduleHide);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      el.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const img = curImg;
        if (!img) return;
        hide(true);
        Viewer.openGroup(img);
      });
      document.documentElement.appendChild(el);
      return el;
    }

    /**
     * 角标是否应处理该元素：必须是已入池的内容图。
     *
     * 论坛常见结构是 <a class="zoom"><img></a>，鼠标经常落在包裹层 <a>
     * 上（图片间距、行内元素的首尾空隙、padding），而不是 <img> 本身。
     * 这里必须**向下**找图，而不是向上：
     *   · target 自身是 <img>          → 直接用它
     *   · target 是包裹层且内含单张图  → 用那张图
     * 向上找永远找不到「祖先 img」（img 不会嵌套 img），
     * 会导致鼠标一落到 <a> 上角标就闪没 —— 这正是「时有时无」的根因。
     */
    function imageIn(target) {
      if (!target || target.nodeType !== 1) return null;
      // 1) 自身是图片
      if (target.tagName === 'IMG') {
        return ImagePool.itemOf(target) ? target : null;
      }
      // 2) 包裹层：优先取「直接子 img」，再退化到「内部唯一 img」
      let inner = null;
      for (const c of target.children) {
        if (c.tagName === 'IMG') { inner = c; break; }
      }
      if (!inner && target.querySelector) {
        const list = target.querySelectorAll('img');
        if (list.length === 1) inner = list[0];
      }
      if (inner && ImagePool.itemOf(inner)) return inner;
      return null;
    }
    // 兼容旧调用名
    const hitImage = imageIn;

    function positionFor(img) {
      const c = Config.get('hoverBadgeCorner') || 'tr';
      const r = img.getBoundingClientRect();
      const gap = 8, bw = 118, bh = 30; // 预估尺寸，够用
      let left, top;
      if (c === 'tl') { left = r.left + gap; top = r.top + gap; }
      else if (c === 'bl') { left = r.left + gap; top = r.bottom - bh - gap; }
      else if (c === 'br') { left = r.right - bw - gap; top = r.bottom - bh - gap; }
      else { left = r.right - bw - gap; top = r.top + gap; } // tr

      // 视口内收敛，避免跑出屏幕
      const vw = window.innerWidth, vh = window.innerHeight;
      left = Math.max(6, Math.min(left, vw - bw - 6));
      top = Math.max(6, Math.min(top, vh - bh - 6));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    function show(img, count, inGroup) {
      if (!el && !build()) return;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      // ⚠️ 关键：hide(true) 会写入内联 display:none，内联样式优先级高于类，
      //    若不清除，角标此后将**永久无法再次显示**（"时有时无"的另一半根因）。
      if (el.style.display === 'none') el.style.display = '';
      // 文案：有组 → "看这组 N"；单图回退 → "浏览全部"
      const label = el.querySelector('span');
      if (label) label.textContent = inGroup ? ('看这组 · ' + count) : '浏览全部';
      el.style.setProperty('--fiv-badge-op', String(clamp(Number(Config.get('hoverBadgeOpacity')) || 0.72, 0.3, 1)));
      positionFor(img);
      el.classList.add(NS + '-on');
      if (curImg && curImg !== img) curImg.classList.remove(NS + '-hot');
      curImg = img;
      img.classList.add(NS + '-hot');
    }

    function hide(instant) {
      if (curImg) { curImg.classList.remove(NS + '-hot'); curImg = null; }
      if (!el) return;
      el.classList.remove(NS + '-on');
      if (instant) el.style.display = 'none';
    }

    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => hide(false), 140);
    }

    /** 评估某个 img 是否值得显示角标；返回 {show, count, inGroup} */
    function evaluate(img) {
      if (!img) return null;
      // 浏览模式下不再显示角标（以免与浏览界面打架）
      if (Viewer.isOpen) return null;
      // 图已不在视口/被隐藏
      if (isHiddenEl(img)) return null;
      const g = ImagePool.groupOf(img);
      const onlyGroup = Config.get('hoverBadgeGroupOnly') !== false;
      if (g && g.size >= 2 && !g.isWholePage) {
        return { show: true, count: g.size, inGroup: true };
      }
      // 单图 / 组==全页：可选是否仍提供"浏览全部"入口
      if (onlyGroup) return null;
      return { show: true, count: ImagePool.count, inGroup: false };
    }

    function onMove(e) {
      if (!Config.get('hoverBadge')) { if (el && el.classList.contains(NS + '-on')) hide(true); return; }
      const img = hitImage(e.target);
      if (!img) { scheduleHide(); return; }
      if (img === curImg && el && el.classList.contains(NS + '-on')) {
        // ⚠️ 必须取消 pending 的隐藏：
        //    鼠标移到图外会 scheduleHide()，若在 140ms 内移回同一张图，
        //    这里会因「同一张图且已显示」提前 return，导致那个 hide 定时器
        //    未被取消、到点仍执行 —— 表现为"移回后又自己消失了"。
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        positionFor(img);   // 页面滚动/元素移动时跟随
        return;
      }
      const verdict = evaluate(img);
      if (!verdict || !verdict.show) { scheduleHide(); return; }
      show(img, verdict.count, verdict.inGroup);
    }

    /** 页面滚动/尺寸变化：让角标跟随当前图，或直接收起 */
    function sync() {
      if (!curImg || !el || !el.classList.contains(NS + '-on')) return;
      const r = curImg.getBoundingClientRect();
      const out = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      if (out) hide(true);
      else positionFor(curImg);
    }

    function bind() {
      if (bound) return;
      bound = true;
      document.addEventListener('mousemove', onMove, { passive: true, capture: true });
      window.addEventListener('scroll', sync, { passive: true, capture: true });
      window.addEventListener('resize', sync, { passive: true });
      // 页面失焦/鼠标离开文档 → 收起
      document.addEventListener('mouseleave', () => hide(true));
      window.addEventListener('blur', () => hide(true));
    }

    function refresh() {
      if (!Config.get('hoverBadge')) hide(true);
      else if (curImg) { positionFor(curImg); el.style.setProperty('--fiv-badge-op', String(clamp(Number(Config.get('hoverBadgeOpacity')) || 0.72, 0.3, 1))); }
    }

    function destroy() {
      hide(true);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null; bound = false;
    }

    return { bind, refresh, destroy, hide, get active() { return !!curImg; } };
  })();

  /* =========================================================================
   * 6. Dimmer —— 页面调暗层
   *    - 压暗原网页但保留可见度（默认 62% 黑，可通过配置调整）
   *    - 固定定位、不参与布局、不挡交互
   *    - 关闭浏览模式时平滑淡出并彻底移除，页面 100% 还原
   * ========================================================================= */

  const Dimmer = (() => {
    let el = null;

    function ensure() {
      if (el && el.isConnected) return el;
      el = document.createElement('div');
      el.className = NS + '-dim';
      el.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(el);
      return el;
    }

    /** 亮度 0~0.95，越大越暗；0 视为关闭 */
    function applyLevel(level) {
      const v = clamp(Number(level) || 0, 0, 0.95);
      document.documentElement.style.setProperty('--fiv-dim', String(v));
      document.documentElement.style.setProperty('--fiv-zdim', String(Z_BASE - 1000));
      return v;
    }

    /** 打开调暗（进浏览模式时调用） */
    function on() {
      if (!Config.get('dimPage')) return;
      applyLevel(Config.get('dimLevel'));
      const node = ensure();
      if (!Config.get('animation')) node.classList.add(NS + '-nofx');
      else node.classList.remove(NS + '-nofx');
      // 先入 DOM 再加类，保证过渡动画生效
      requestAnimationFrame(() => node.classList.add(NS + '-on'));
    }

    /** 关闭调暗（退出浏览模式时调用）：淡出后移除节点 */
    function off() {
      if (!el) return;
      el.classList.remove(NS + '-on');
      const node = el;
      const done = () => {
        if (node && node.parentNode) node.remove();
        if (el === node) el = null;
      };
      if (Config.get('animation')) setTimeout(done, 240);
      else done();
      // 兜底：即使过渡事件丢失也确保移除
      setTimeout(done, 600);
    }

    /** 配置在浏览过程中被改动时，实时更新亮度 */
    function refresh() {
      if (!el || !el.classList.contains(NS + '-on')) return;
      if (!Config.get('dimPage')) { off(); return; }
      applyLevel(Config.get('dimLevel'));
    }

    return { on, off, refresh, applyLevel };
  })();

  /* =========================================================================
   * 7. Settings —— 配置面板
   * ========================================================================= */

  const Settings = (() => {
    let mask, panel, body, statusEl;
    /** 上次保存时的配置快照：用于识别「采集范围类字段」是否发生变化 */
    let lastSaved = null;

    const TOGGLES = [
      ['showFloatingButton', '显示悬浮按钮', '仅在页面图片数量达标时出现'],
      ['hoverBadge', '图片悬停角标', '鼠标移到图片上时，角落浮出「看这组」按钮'],
      ['hoverBadgeGroupOnly', '角标仅在成组时显示', '该图所在组不足 2 张时不显示角标（推荐开启）'],
      ['thumbnailBar', '显示缩略图条', '底部缩略图进度条'],
      ['wheelNavigate', '滚轮翻图', '在图片上滚动鼠标滚轮切换上一张/下一张'],
      ['wheelZoom', '滚轮缩放', '开启后悬停图片时滚轮改为缩放；Ctrl+滚轮始终缩放'],
      ['adaptTheme', '自适应论坛配色', '读取站点主色、圆角、字体'],
      ['animation', '过渡动画', '切换图片与打开关闭的动效'],
      ['syncPageScroll', '页面跟随滚动', '浏览时页面滚到当前图位置，退出后正好停在这张图上'],
      ['dimPage', '浏览时调暗网页', '压暗背景但保留可见度，退出自动还原'],
      ['disableSiteLightbox', '禁用论坛自带图片放大', '避免与本站灯箱冲突'],
      ['strictFilter', '严格过滤小图', '同时排除装饰性背景图'],
      ['dedupeByUrl', '按 URL 去重', '同一图片地址全页只浏览一次。关闭时按页面节点收录（推荐关闭，否则同图出现在两个帖子会让其中一个分组失败）'],
      ['whitelistOnly', '仅在白名单站点启用', '开启后，只有下方列表命中的站点才加载悬浮按钮与角标'],
      ['groupChaining', '组间连续浏览', '分组内翻到第一张/最后一张时，自动续到相邻组。关闭则停留在组内并提示'],
      ['crossOriginFallback', '打包下载跨域降级', 'fetch 被 CORS 拦截时改由 GM_xmlhttpRequest 取图。关闭则仅能下载同源图片，但不会向图床发起扩展层请求']
    ];

    const NUMBERS = [
      ['minWidth', '最小图片宽度(px)', '原始像素，低于该值视为小图忽略'],
      ['minHeight', '最小图片高度(px)', '原始像素，低于该值视为小图忽略'],
      ['minImagesForButton', '显示按钮所需最少图片数', '页面图片数不足时不打扰'],
      ['thumbSize', '缩略图高度(px)', '缩略图进度条的高度'],
      ['zoomStep', '缩放步进', '每次缩放的倍率增量，如 0.25'],
      ['maxZoom', '最大放大倍数', '相对图片原始像素的最大倍率'],
      ['autoplayInterval', '自动播放间隔(ms)', 'Space 启动自动播放'],
      ['dimLevel', '调暗程度', '0~0.95，越大越暗（推荐 0.5~0.75，别调到 1）'],
      ['hoverBadgeOpacity', '角标不透明度', '0.3~1，越大越明显（推荐 0.6~0.8）']
    ];

    /** 文本域型字段：多行输入，保存时按空行/逗号切分（如白名单列表） */
    const TEXTAREAS = [
      ['whitelist', '白名单站点', '每行一个 hostname 片段，如 bbs.example.com。仅在开启「仅白名单站点启用」时生效']
        // 数组型字段：空列表时不写 key，避免 withDefaults 把 [] 当无效值
    ];

    /** 下拉型字段（角标位置 / 页面滚动方式） */
    const SELECTS = [
      ['hoverBadgeCorner', '角标位置', '贴在图片的哪个角', [
        ['tr', '右上角'], ['tl', '左上角'], ['br', '右下角'], ['bl', '左下角']
      ]],
      ['syncScrollBehavior', '页面跟随方式', '同步滚动当前图片位置时的动效', [
        ['smooth', '平滑滚动'], ['instant', '瞬时定位']
      ]]
    ];

    function build() {
      mask = document.createElement('div');
      mask.className = NS + '-panel-mask';
      panel = document.createElement('aside');
      panel.className = NS + '-panel';
      panel.innerHTML = `
        <div class="${NS}-panel-head">
          <h3>图片浏览器设置</h3>
          <button class="${NS}-tbtn" data-close>${ICONS.close}</button>
        </div>
        <div class="${NS}-panel-body"></div>
        <div class="${NS}-panel-foot">
          <button class="${NS}-btn ${NS}-primary" data-save>保存并应用</button>
          <button class="${NS}-btn" data-export>导出配置</button>
          <button class="${NS}-btn" data-import>导入配置</button>
          <button class="${NS}-btn ${NS}-danger" data-reset>恢复默认</button>
          <button class="${NS}-btn" data-close>关闭</button>
        </div>
        <div class="${NS}-statusbar"></div>
      `;
      document.documentElement.appendChild(mask);
      document.documentElement.appendChild(panel);
      body = panel.querySelector('.' + NS + '-panel-body');
      statusEl = panel.querySelector('.' + NS + '-statusbar');

      mask.addEventListener('click', hide);
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.hasAttribute('data-close')) hide();
        else if (btn.hasAttribute('data-save')) { save(); hide(); toastFromSettings('配置已保存'); }
        else if (btn.hasAttribute('data-export')) doExport();
        else if (btn.hasAttribute('data-import')) doImport();
        else if (btn.hasAttribute('data-reset')) doReset();
      });

      render();
    }

    function render() {
      const c = Config.all;
      let html = '';

      html += '<div class="' + NS + '-group"><h4>过滤与识别</h4>';
      for (const [k, label, hint] of NUMBERS.slice(0, 3)) html += numRow(k, label, hint);
      html += '<div class="' + NS + '-row ' + NS + '-row-col"><label>只在这些容器内取图<span class="' + NS + '-hint">CSS 选择器，逗号分隔。留空则自动识别帖子正文容器</span></label>' +
        '<textarea data-field="includeSelector" placeholder="例：.post-content, #thread-posts .message">' + esc(c.includeSelector) + '</textarea></div>';
      html += '<div class="' + NS + '-row ' + NS + '-row-col"><label>额外排除的容器<span class="' + NS + '-hint">CSS 选择器，这些区域里的图片不会被收录</span></label>' +
        '<textarea data-field="excludeSelector" placeholder="例：#sidebar, .ad-banner, .signature">' + esc(c.excludeSelector) + '</textarea></div>';
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>浏览</h4>';
      html += toggleRow('wheelNavigate') + toggleRow('wheelZoom');
      for (const [k, label, hint] of NUMBERS.slice(4, 7)) html += numRow(k, label, hint);
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>页面联动</h4>';
      html += toggleRow('syncPageScroll') + toggleRow('dimPage');
      html += selectRow('syncScrollBehavior');
      html += numRow('dimLevel', '调暗程度', '0~0.95，越大越暗（推荐 0.5~0.75，别调到 1）');
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>外观</h4>';
      html += toggleRow('adaptTheme') + toggleRow('animation') + toggleRow('thumbnailBar');
      html += numRow('thumbSize', '缩略图高度(px)', '缩略图进度条的高度');
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>触发方式</h4>';
      html += toggleRow('showFloatingButton');
      html += numRow('minImagesForButton', '显示按钮所需最少图片数', '页面图片数不足时不打扰');
      html += toggleRow('disableSiteLightbox') + toggleRow('strictFilter') + toggleRow('dedupeByUrl');
      html += toggleRow('whitelistOnly');
      for (const [k, label, hint] of TEXTAREAS) html += textareaRow(k, label, hint);
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>分组浏览</h4>';
      html += '<div class="' + NS + '-row ' + NS + '-row-col"><label>说明<span class="' + NS + '-hint">' +
        '自动把页面图片按「一层楼 / 一个图集 / 一段配图」分组。在某张图上用悬停角标「看这组」即可只浏览该组，' +
        '按 <kbd class="' + NS + '-kbd">G</kbd> 可在「本组 / 全部」之间切换。</span></label></div>';
      html += toggleRow('groupChaining');
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>批量打包下载</h4>';
      html += '<div class="' + NS + '-row ' + NS + '-row-col"><label>说明<span class="' + NS + '-hint">' +
        '工具条 <kbd class="' + NS + '-kbd">📦</kbd> 按钮或 <kbd class="' + NS + '-kbd">Shift+D</kbd> 可把图片打包成 ZIP。' +
        '图片浏览页几乎总是跨域的，浏览器不允许 fetch 读取内容，因此默认会改用 GM_xmlhttpRequest 绕过；' +
        '若你在敏感站点上不希望脚本向图床发起请求，可关闭下方开关（代价是跨域图下不了）。' +
        '</span></label></div>';
      html += toggleRow('crossOriginFallback');
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>图片悬停角标</h4>';
      html += '<div class="' + NS + '-row ' + NS + '-row-col"><label>说明<span class="' + NS + '-hint">' +
        '鼠标移到图片上时，角落浮出「看这组」，点它只浏览该图所属的那一组（论坛一层楼 / 商品图集 / 配图段）。' +
        '移开自动隐藏，不影响原图点击。</span></label></div>';
      html += toggleRow('hoverBadge') + toggleRow('hoverBadgeGroupOnly');
      html += selectRow('hoverBadgeCorner');
      html += numRow('hoverBadgeOpacity', '角标不透明度', '0.3~1，越大越明显（推荐 0.6~0.8）');
      html += '</div>';

      html += '<div class="' + NS + '-group"><h4>快捷键</h4>' + kbdTable() + '</div>';

      html += '<div class="' + NS + '-group"><h4>站点信息</h4>' +
        '<div class="' + NS + '-row"><label>当前站点<span class="' + NS + '-hint">规则按站点分别记忆</span></label>' +
        '<code style="font-size:12px;opacity:.7">' + esc(location.hostname) + '</code></div></div>';

      body.innerHTML = html;
    }

    /** 小数型字段：步进与取值范围各不相同，集中在一处便于维护 */
    const FLOAT_FIELDS = {
      zoomStep: { step: '0.05', min: '0.05', max: '2' },
      dimLevel: { step: '0.05', min: '0', max: '0.95' },
      hoverBadgeOpacity: { step: '0.05', min: '0.3', max: '1' }
    };

    function numRow(key, label, hint) {
      const f = FLOAT_FIELDS[key];
      const step = f ? f.step : '1';
      const min = f ? f.min : '0';
      const max = f ? ' max="' + f.max + '"' : '';
      // 小数字段按原值输出，避免 0.62 被显示成 0.6200000001 之类
      const val = f ? Number(Config.get(key)) : Config.get(key);
      return '<div class="' + NS + '-row"><label>' + label + '<span class="' + NS + '-hint">' + hint + '</span></label>' +
        '<input type="number" data-field="' + key + '" value="' + val + '" min="' + min + '"' + max + ' step="' + step + '"></div>';
    }

    /**
     * 文本域行。数组型字段（如 whitelist）以「每行一项」呈现，
     * 保存时再切回数组 —— 比让用户手写 JSON 友好得多。
     */
    function textareaRow(key, label, hint) {
      const cur = Config.get(key);
      const text = Array.isArray(cur) ? cur.join('\n') : (cur == null ? '' : String(cur));
      return '<div class="' + NS + '-row ' + NS + '-row-col"><label>' + label +
        '<span class="' + NS + '-hint">' + hint + '</span></label>' +
        '<textarea data-field="' + key + '" data-array="1" placeholder="例：bbs.example.com">' +
        esc(text) + '</textarea></div>';
    }

    function selectRow(key) {
      const meta = SELECTS.find((s) => s[0] === key);
      if (!meta) return '';
      const cur = Config.get(key);
      const opts = meta[3].map(([v, t]) =>
        '<option value="' + v + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + t + '</option>').join('');
      return '<div class="' + NS + '-row"><label>' + meta[1] + '<span class="' + NS + '-hint">' + meta[2] + '</span></label>' +
        '<select data-field="' + key + '">' + opts + '</select></div>';
    }

    function toggleRow(key) {
      const meta = TOGGLES.find((t) => t[0] === key);
      if (!meta) return '';
      const on = !!Config.get(key);
      return '<div class="' + NS + '-row"><label>' + meta[1] + '<span class="' + NS + '-hint">' + meta[2] + '</span></label>' +
        '<span class="' + NS + '-switch"><input type="checkbox" data-field="' + key + '"' + (on ? ' checked' : '') + '><span></span></span></div>';
    }

    function kbdTable() {
      const rows = [
        ['上一张 / 下一张', '<kbd class="' + NS + '-kbd">←</kbd><kbd class="' + NS + '-kbd">→</kbd> 或 <kbd class="' + NS + '-kbd">↑</kbd><kbd class="' + NS + '-kbd">↓</kbd>'],
        ['滚轮翻图', '鼠标滚轮（图片上）'],
        ['缩放', '<kbd class="' + NS + '-kbd">Ctrl</kbd>+滚轮 / <kbd class="' + NS + '-kbd">+</kbd> <kbd class="' + NS + '-kbd">-</kbd>'],
        ['适应屏幕', '<kbd class="' + NS + '-kbd">F</kbd> 或 双击图片'],
        ['原始大小', '<kbd class="' + NS + '-kbd">1</kbd>'],
        ['首张 / 末张', '<kbd class="' + NS + '-kbd">Home</kbd><kbd class="' + NS + '-kbd">End</kbd>'],
        ['自动播放', '<kbd class="' + NS + '-kbd">Space</kbd>'],
        ['显示/隐藏缩略图条', '<kbd class="' + NS + '-kbd">T</kbd>'],
        ['组间切换', '组内翻到边界自动续（可在「分组浏览」关闭）'],
        ['下载 / 复制链接 / 打开原图', '<kbd class="' + NS + '-kbd">D</kbd> <kbd class="' + NS + '-kbd">C</kbd> <kbd class="' + NS + '-kbd">O</kbd>'],
        ['关闭', '<kbd class="' + NS + '-kbd">Esc</kbd>'],
        ['打开本设置', '<kbd class="' + NS + '-kbd">Shift</kbd>+<kbd class="' + NS + '-kbd">/</kbd>']
      ];
      return '<table class="' + NS + '-kbd-table">' + rows.map((r) =>
        '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>';
    }

    function collect() {
      const out = {};
      body.querySelectorAll('[data-field]').forEach((el) => {
        const key = el.dataset.field;
        if (el.type === 'checkbox') out[key] = el.checked;
        else if (el.type === 'number') out[key] = Number(el.value) || 0;
        else if (el.dataset.array === '1') {
          // 文本域数组字段：按行/逗号切分，去空去重保序
          const parts = String(el.value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
          out[key] = Array.from(new Set(parts));
        } else out[key] = el.value;
      });
      return out;
    }

    function save() {
      const v = collect();
      Config.merge(v);
      const rebuilt = applyAfterChange();
      lastSaved = Object.assign({}, Config.all);
      statusEl.textContent = '已保存 · ' + new Date().toLocaleTimeString()
        + (rebuilt ? ' · 已重新识别图片' : '');
    }

    /** 影响「采集范围/过滤判定」的字段：改动后必须重建图片池 */
    const RANGE_FIELDS = ['includeSelector', 'excludeSelector', 'minWidth', 'minHeight',
      'strictFilter', 'dedupeByUrl'];

    function applyAfterChange() {
      /* 采集范围类字段改动 → 图片池需要重扫。
         旧行为只改配置不重建，用户得手动刷新页面才生效（历史遗漏）。
         重建时清空索引，并把浏览层切回全局（分组依据已变，原 scope 不再可靠）。 */
      let rebuilt = false;
      try {
        const needRebuild = RANGE_FIELDS.some((k) => lastSaved && lastSaved[k] !== Config.get(k));
        if (needRebuild) {
          Viewer.clearScope();
          ImagePool.reset();
          ImagePool.scanNow();
          Viewer.setItems(ImagePool.items);
          rebuilt = true;
        }
      } catch (e) {}

      Viewer.rebuildStrip();
      Viewer.refreshTheme();
      Dimmer.refresh();               // 调暗程度/开关改动后立即生效
      Dimmer.applyLevel(Config.get('dimLevel'));  // 保证 CSS 变量已更新
      if (window.__fivRefreshFab) window.__fivRefreshFab();
      return rebuilt;
    }

    function doExport() {
      const text = Config.export();
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'image-viewer-config-' + location.hostname + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      statusEl.textContent = '已导出配置文件';
    }

    function doImport() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            Config.import(String(rd.result));
            render();
            lastSaved = null;          // 强制下次保存时按全字段比对 → 触发重建
            applyAfterChange();
            lastSaved = Object.assign({}, Config.all);
            statusEl.textContent = '导入成功';
            toastFromSettings('配置已导入');
          } catch (e) {
            statusEl.textContent = '导入失败：' + e.message;
          }
        };
        rd.readAsText(f);
      });
      inp.click();
    }

    function doReset() {
      if (!confirm('恢复默认配置？本站在此面板的自定义规则（含选择器）将被清除。')) return;
      Config.reset();
      render();
      lastSaved = null;
      applyAfterChange();
      lastSaved = Object.assign({}, Config.all);
      statusEl.textContent = '已恢复默认';
      toastFromSettings('已恢复默认配置');
    }

    function show() {
      // 面板可能先于「浏览层」被打开（Shift+/）。此时必须确保主题变量已就绪，
      // 否则 var(--fiv-panelbg) 等解析失败 → 背景透明、文字看不清、点击穿透。
      try { applyRootTheme(); } catch (e) {}
      if (!panel) build();
      render();
      lastSaved = Object.assign({}, Config.all);   // 打开时快照，用于保存时比对
      mask.classList.add(NS + '-open');
      panel.classList.add(NS + '-open');
    }
    function hide() {
      if (!panel) return;
      mask.classList.remove(NS + '-open');
      panel.classList.remove(NS + '-open');
    }

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function toastFromSettings(msg) {
      if (window.__fivToast) window.__fivToast(msg);
    }

    return { show, hide, build };
  })();

  /* =========================================================================
   * 7. FloatingButton —— 悬浮按钮
   * ========================================================================= */

  const Floating = (() => {
    let fab = null, countEl = null;

    function build() {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = NS + '-fab';
      fab.title = '浏览本帖图片（点击打开 · 右键设置）';
      fab.innerHTML = ICONS.photo + '<span>浏览图片</span><span class="' + NS + '-fab-count">0</span>';
      fab.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!ImagePool.count) { if (window.__fivToast) window.__fivToast('没有可浏览的图片'); return; }
        Viewer.resume();
      });
      fab.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        Settings.show();
      });
      fab.addEventListener('mousedown', (e) => e.stopPropagation());
      document.documentElement.appendChild(fab);
      countEl = fab.querySelector('.' + NS + '-fab-count');
    }

    function refresh() {
      if (!fab) build();
      const on = Config.get('showFloatingButton') && enabledOnThisSite();
      const enough = ImagePool.count >= (Number(Config.get('minImagesForButton')) || 0);
      fab.classList.toggle(NS + '-on', !!(on && enough));
      if (countEl) countEl.textContent = String(ImagePool.count);
    }

    function enabledOnThisSite() {
      if (!Config.get('whitelistOnly')) return true;
      const wl = Config.get('whitelist') || [];
      // ⚠️ 白名单模式但列表为空 → 视为「无站点被允许」，返回 false。
      // 之前这里 return true，与「仅在白名单站点启用」的语义正好相反。
      if (!wl.length) return false;
      return wl.some((h) => location.hostname.includes(h));
    }

    return { refresh, build };
  })();

  /* =========================================================================
   * 8. 启动
   * ========================================================================= */

  function injectStyles() {
    if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; }
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('⚙ 图片浏览器设置', () => Settings.show());
      GM_registerMenuCommand('🖼 立即浏览图片', () => {
        if (!ImagePool.count) { if (window.__fivToast) window.__fivToast('没有可浏览的图片'); return; }
        Viewer.resume();
      });
      GM_registerMenuCommand('↻ 重新扫描页面图片', () => {
        const n = ImagePool.scanNow();
        Floating.refresh();
        if (window.__fivToast) window.__fivToast('本次新增 ' + n + ' 张，共 ' + ImagePool.count + ' 张');
      });
      // 打包下载：浏览层未打开时也能用（此时「本组」无从谈起，一律打包全部）
      GM_registerMenuCommand('📦 打包下载全部图片', () => {
        if (!ImagePool.count) { if (window.__fivToast) window.__fivToast('没有可下载的图片'); return; }
        if (window.__fivPack) window.__fivPack('all');
      });
      GM_registerMenuCommand('📦 打包下载当前组', () => {
        if (!ImagePool.count) { if (window.__fivToast) window.__fivToast('没有可下载的图片'); return; }
        if (window.__fivPack) window.__fivPack('group');
      });
    } catch (e) {}
  }

  /** 复用同一个 <style> 节点写入主题变量，避免重复调用堆积 DOM */
  let themeStyleEl = null;
  function applyRootTheme() {
    const theme = ThemeProbe.probe();
    document.documentElement.setAttribute('data-' + NS + '-theme', theme.dark ? 'dark' : 'light');
    // 写入「全量」变量到 :root —— 这样在任何 UI（含尚未构建浏览层时的设置面板）
    // 出现之前，--fiv-fg / --fiv-panelbg 等就已经就绪。
    const vars = themeVars(theme);
    let css = ':root{';
    for (const k in vars) css += k + ':' + vars[k] + ';';
    css += '}';
    if (!themeStyleEl || !themeStyleEl.parentNode) {
      themeStyleEl = document.createElement('style');
      themeStyleEl.id = NS + '-theme-vars';
      (document.head || document.documentElement).appendChild(themeStyleEl);
    }
    themeStyleEl.textContent = css;
    return theme;
  }

  function boot() {
    injectStyles();
    applyRootTheme();

    // 全局回调（供内部模块互通）
    window.__fivOpenSettings = () => Settings.show();
    window.__fivRefreshFab = () => Floating.refresh();
    // 供油猴菜单命令调用（菜单注册在 boot 层，拿不到 Viewer IIFE 内部的 packDownload）
    // ⚠️ 必须走 Viewer.packDownload —— packDownload 本身定义在 Viewer 的闭包里，
    //    在此直接引用会抛 ReferenceError: packDownload is not defined。
    window.__fivPack = (mode) => Viewer.packDownload(mode === 'group' ? 'group' : 'all');
    /**
     * 调试/扩展入口：把内部模块挂到 window.__fiv。
     * 方便在控制台排查站点适配问题（如 __fiv.ImagePool.groupOf(img) 看分组结果），
     * 也便于自动化测试直接驱动。
     * 线上若不需要，可直接注释本段（其余逻辑不依赖 window.__fiv）。
     */
    window.__fiv = window.__fiv || {};
    window.__fiv.version = VERSION;
    window.__fiv.ImagePool = ImagePool;
    window.__fiv.Viewer = Viewer;
    window.__fiv.Config = Config;
    window.__fiv.Settings = Settings;
    window.__fiv.HoverBadge = HoverBadge;
    window.__fiv.ImageDownloader = ImageDownloader;
    /**
     * 打包下载诊断（排障用）。
     * 在控制台执行 `__fiv.diagPack()`，会**逐张**真实 fetch 当前组图片，
     * 把每一步的成败与原因打到 console，并返回一个汇总 Promise。
     *
     * 存在的意义：批量下载在 jsdom 里无法验证真实网络行为（尤其是 CORS），
     * 有了它，「点了没反应」就能立刻定位到具体是哪一张、什么原因。
     */
    window.__fiv.diagPack = async function (mode) {
      const items = (mode === 'group' && Viewer.inGroup)
        ? null   // 分组快照在 Viewer 内部，这里用全部即可，诊断目的相同
        : ImagePool.items.slice();
      const list = items || ImagePool.items.slice();
      const group = LOG_PREFIX + ' [打包诊断] 共 ' + list.length + ' 张';
      console.log(group);
      console.log('[打包诊断] GM_xmlhttpRequest 跨域通道：' + (ImageDownloader.hasGmXhr() ? '可用' : '不可用（权限未授予）'));
      if (!list.length) { console.warn(group, '图片池为空'); return; }
      const rows = [];
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const line = { i: i + 1, src: it.src };
        try {
          // 走真实取数链路（含 GM 降级），而不是裸 fetch ——
          // 裸 fetch 只会重现 CORS 报错，无法验证降级通道是否真的work。
          const r = await ImageDownloader._fetchOne(it, null);
          line.ok = true;
          line.via = r.via;
          line.mime = r.mime;
          line.bytes = r.bytes.length;
          console.log('✅', line.i, '[' + r.via + ']', line.mime, line.bytes + 'B', it.src);
        } catch (e) {
          line.ok = false;
          line.error = (e && e.message) || String(e);
          console.warn('❌', line.i, line.error, it.src);
        }
        rows.push(line);
      }
      const bad = rows.filter((r) => !r.ok);
      const byGm = rows.filter((r) => r.via === 'gm').length;
      console.log('%c[打包诊断] 完成：成功 %d / 失败 %d（其中 %d 张走了跨域降级通道）',
        'color:' + (bad.length ? '#c00' : '#0a0'), rows.length - bad.length, bad.length, byGm);
      if (bad.length) {
        console.warn('[打包诊断] 仍有失败。若通道显示"可用"却依旧失败，'
          + '通常是图床需要 Referer 校验、需要登录 Cookie，或该图已被删除。');
      }
      return rows;
    };
    /** 分组枚举（调试用） */
    window.__fiv.groups = () => ImagePool.groups(2);
    // URL 安全判定（排查站点适配问题时可即时验证某个地址是否被允许）
    window.__fiv.isSafeImageSrc = isSafeImageSrc;
    window.__fiv.isSafeExternalUrl = isSafeExternalUrl;
    window.__fivToast = (m) => {
      // 复用 Viewer 的 toast（通过临时构造）
      const el = document.createElement('div');
      el.className = NS + '-toast';
      el.textContent = m;
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => el.classList.add(NS + '-on'));
      setTimeout(() => {
        el.classList.remove(NS + '-on');
        setTimeout(() => el.remove(), 260);
      }, 1700);
    };

    // 首轮扫描 + 观察
    ImagePool.scanNow();
    Floating.build();
    Floating.refresh();
    ImagePool.startObserve();
    HoverBadge.bind();

    // 图片池变化 → 同步 UI
    ImagePool.onChange(() => {
      Floating.refresh();
      Viewer.setItems(ImagePool.items);
      HoverBadge.refresh();
    });

    // 配置变化 → 应用
    Config.onChange((k) => {
      if (k === 'adaptTheme' || k === '*') applyRootTheme();
      Floating.refresh();
      Viewer.refreshTheme();
      // 浏览过程中改动「页面联动」相关项，实时生效
      if (k === 'dimPage' || k === 'dimLevel' || k === '*') Dimmer.refresh();
      if ((k === 'syncPageScroll' || k === '*') && Viewer.isOpen) Viewer.syncPageNow();
      if (k === 'hoverBadge' || k === 'hoverBadgeOpacity' || k === 'hoverBadgeCorner' ||
          k === 'hoverBadgeGroupOnly' || k === '*') HoverBadge.refresh();
      // 采集范围/过滤判定变化 → 重建图片池（面板保存路径也会调，这里覆盖外部直接改配置的场景）
      if (k === 'includeSelector' || k === 'excludeSelector' || k === 'minWidth' ||
          k === 'minHeight' || k === 'strictFilter' || k === 'dedupeByUrl') {
        Viewer.clearScope();
        ImagePool.reset();
        ImagePool.scanNow();
        Viewer.setItems(ImagePool.items);
      }
    });

    // 快捷键：打开设置 / 全局打开浏览器
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      // Shift + / → 设置
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        Settings.show();
      }
    }, true);

    /* 站点灯箱拦截**不在这里**注册。
       之前此处有一份空实现（监听体只有 return，从不阻止任何事件），属于
       早期草稿遗留 + 与 bindEvents() 里 lightboxGuard 功能重复。
       真正的拦截在 Viewer.bindLightboxGuard()：window + 捕获阶段，
       跑在站点任何委托监听之前，且仅在浏览层打开时生效。 */

    registerMenu();
    log('已就绪 · 当前识别到 ' + ImagePool.count + ' 张图片');
  }

  // 启动时机
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
