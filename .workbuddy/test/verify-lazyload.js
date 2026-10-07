/**
 * 懒加载图片地址采集测试（v1.8.0「解法 1：全量 data-* 扫描」）
 *
 * 背景：论坛/图集的懒加载属性名没有社区规范，data-tfsrc / data-original-src /
 * data-raw / data-ks-lazyload… 几十种写法。原实现只枚举 9 个已知名字，
 * 漏掉的站只能拿到站点预设的占位图。本测试锁定「启发式全量扫描」的行为。
 *
 * 断言分组：
 *   A. 奇葩属性名能被识别（核心收益）
 *   B. 占位图特征值必须被跳过
 *   C. 非图片值不得误判（data-page="2" 之类）
 *   D. 安全过滤不得被绕过（javascript: / file:）
 *   E. 优先级不得被破坏（已知名 > 启发式 > srcset > src）
 *   F. 原始行为不回退
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建一个页面并加载脚本。
 * @param {string} body  页面主体 HTML
 * @returns {Promise<{w:Window, pool:Array}>}
 */
async function withPage(body) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + body + '</body></html>',
    { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
  w.Element.prototype.getBoundingClientRect = function () {
    return { left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100 };
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
  w.GM_setValue = () => {};
  w.GM_getValue = () => undefined;
  w.GM_deleteValue = () => {};
  w.GM_addStyle = () => {};
  w.GM_registerMenuCommand = () => {};
  w.eval(CODE);
  await sleep(400);
  return { w, pool: w.__fiv.ImagePool.items };
}

(async () => {
  console.log('\n【A】全量data-* 扫描能识别社区奇葩属性名');
  {
    // 每种都是真实存在的社区写法，都不在原来的 9 个白名单里
    const cases = [
      ['data-tfsrc', 'data-tfsrc="https://img.cdn/a/tfs.jpg"'],
      ['data-original-src', 'data-original-src="https://img.cdn/a/origsrc.jpg"'],
      ['data-raw', 'data-raw="https://img.cdn/a/rawvalue.jpg"'],
      ['data-ks-lazyload', 'data-ks-lazyload="https://img.cdn/a/kslazy.jpg"'],
      ['data-originalUrl', 'data-originalUrl="https://img.cdn/a/origurl.jpg"'],
      ['data-img', 'data-img="https://img.cdn/a/dataimg.jpg"'],
      ['data-imageurl', 'data-imageurl="https://img.cdn/a/imageurl.jpg"'],
      ['data-srcset', 'data-srcset="https://img.cdn/a/srcset.jpg"'],
      ['data-lazy', 'data-lazy="https://img.cdn/a/lazyattr.jpg"']
    ];
    for (const [attrName, attrText] of cases) {
      const { pool } = await withPage(
        '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/placeholder.gif" ' + attrText + '></div></div>'
      );
      const got = pool.length ? pool[0].src : '(空池)';
      ok('识别 ' + attrName, got === 'https://img.cdn/a/' + attrText.match(/a\/([^"]+)/)[1],
        '拿到 ' + got);
    }
  }

  console.log('\n【A2】无扩展名时靠图床参数特征兜底');
  {
    const cases = [
      ['imageView 参数', 'data-tfsrc="https://img.cdn/a?imageView2/1/w/800"'],
      ['thumb 路径', 'data-tfsrc="https://img.cdn/thumb/big.jpg"'],
      ['resize 参数', 'data-raw="https://img.cdn/x?w=1200&amp;type=webp"']
    ];
    for (const [name, attr] of cases) {
      const { pool } = await withPage(
        '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/ph.gif" ' + attr + '></div></div>'
      );
      ok('兜底识别 · ' + name, pool.length === 1 && !/ph\.gif/.test(pool[0].src),
        pool.length ? '拿到 ' + pool[0].src : '(空池)');
    }
  }

  console.log('\n【B】占位图特征值必须跳过，不能被当成真图');
  {
    const cases = [
      ['loading.gif', 'data-tfsrc="https://img.cdn/loading.gif"'],
      ['placeholder.png', 'data-raw="https://img.cdn/static/placeholder.png"'],
      ['spacer.gif', 'data-img="https://img.cdn/assets/spacer.gif"'],
      ['blank.svg', 'data-lazy="https://img.cdn/blank.svg"']
    ];
    for (const [name, attr] of cases) {
      const { pool } = await withPage(
        '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/other.jpg" ' + attr + '></div></div>'
      );
      const got = pool.length ? pool[0].src : '(空池)';
      // 应该回落到 src（other.jpg），而不是收下占位图
      ok('跳过 ' + name, !/loading\.gif|placeholder\.png|spacer\.gif|blank\.svg/.test(got), '拿到 ' + got);
    }
  }

  console.log('\n【C】非图片语义值不得误判为图片地址');
  {
    // 这些都是 data-* 但不是图片地址，靠启发式应该被排除
    const cases = [
      ['页码', 'data-page="2"'],
      ['计数', 'data-index="12"'],
      ['标题', 'data-title="hello world"'],
      ['JSON 串', 'data-info=\'{"a":1}\''],
      ['空值', 'data-src=""'],
      ['纯数字带单位', 'data-size="100kb"'],
      ['相对路径无扩展名', 'data-x="some/path"']
    ];
    for (const [name, attr] of cases) {
      const { pool } = await withPage(
        '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/real.jpg" ' + attr + '></div></div>'
      );
      const got = pool.length ? pool[0].src : '(空池)';
      ok('不误判 · ' + name, got === 'https://img.cdn/real.jpg', '拿到 ' + got);
    }
  }

  console.log('\n【D】安全过滤不得被启发式绕过');
  {
    const cases = [
      ['javascript:', 'data-tfsrc="javascript:alert(1)"'],
      ['file:', 'data-raw="file:///C:/Windows/win.ini"'],
      ['vbscript:', 'data-img="vbscript:msgbox(1)"'],
      ['data: URI', 'data-lazy="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="']
    ];
    for (const [name, attr] of cases) {
      const { pool } = await withPage(
        '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/safe.jpg" ' + attr + '></div></div>'
      );
      const got = pool.length ? pool[0].src : '(空池)';
      ok('拦下 ' + name, !/javascript:|file:\/\/|vbscript:|data:image/.test(got), '拿到 ' + got);
    }
  }

  console.log('\n【E】优先级不被破坏');
  {
    // 已知属性名 > 启发式扫描（两者都在时取已知名）
    const { pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ph.gif" data-src="https://img.cdn/known.jpg" data-tfsrc="https://img.cdn/scanned.jpg">' +
      '</div></div>'
    );
    ok('已知属性名优先于启发式扫描', pool.length === 1 && pool[0].src === 'https://img.cdn/known.jpg',
      pool.length ? '拿到 ' + pool[0].src : '(空池)');
  }
  {
    // 启发式扫描 > srcset（srcset 是最弱的兜底）
    const { pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ph.gif" srcset="https://img.cdn/from-ss.jpg 2x" data-tfsrc="https://img.cdn/scanned.jpg">' +
      '</div></div>'
    );
    ok('启发式扫描优先于 srcset', pool.length === 1 && pool[0].src === 'https://img.cdn/scanned.jpg',
      pool.length ? '拿到 ' + pool[0].src : '(空池)');
  }
  {
    // 无 data-* 时仍走 srcset，且取最大的一档
    const { pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ph.gif" srcset="https://img.cdn/small.jpg 400w, https://img.cdn/big.jpg 1600w">' +
      '</div></div>'
    );
    ok('srcset 取最大档', pool.length === 1 && pool[0].src === 'https://img.cdn/big.jpg',
      pool.length ? '拿到 ' + pool[0].src : '(空池)');
  }
  {
    // 纯 src 站点不能被搞坏
    const { pool } = await withPage(
      '<div class="post"><div class="message"><img id="t1" src="https://img.cdn/plain.jpg"><img id="t2" src="https://img.cdn/plain2.jpg"></div></div>'
    );
    ok('普通 src 站点不受影响', pool.length === 2 &&
      pool.every((p) => /plain\d?\.jpg/.test(p.src)), 'count=' + pool.length);
  }

  console.log('\n【F】base64占位与脏值不进入池');
  {
    const { pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ok.jpg" data-tfsrc="https://img.cdn/found.jpg" data-bg="data:image/png;base64,iVBORw0KGgo=">' +
      '</div></div>'
    );
    ok('base64 data URI 不被采纳', pool.length === 1 && pool[0].src === 'https://img.cdn/found.jpg',
      pool.length ? '拿到 ' + pool[0].src : '(空池)');
  }

  console.log('\n【G】属性顺序无关（DOM 顺序不同也应拿到同一个）');
  {
    const a = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ph.gif" data-id="9" data-tfsrc="https://img.cdn/same.jpg" data-type="photo">' +
      '</div></div>'
    );
    const b = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/ph.gif" data-type="photo" data-tfsrc="https://img.cdn/same.jpg" data-id="9">' +
      '</div></div>'
    );
    const ua = a.pool.length ? a.pool[0].src : '(空池)';
    const ub = b.pool.length ? b.pool[0].src : '(空池)';
    ok('属性顺序不影响结果', ua === ub && ua === 'https://img.cdn/same.jpg', ua + ' vs ' + ub);
  }

  console.log('\n【H】占位图 →真图 的属性替换（占位图已加载完，load 不再触发）');
  {
    //真实时序：站点先塞1×1 占位图（已加载完，naturalWidth 有值但远小于阈值），
    // 滚动到视口时才把 data-tfsrc 换成真图地址。
    // ⚠️ 这里 src 始终不变，**load 事件不会再来第二次** ——
    //    所以只能靠属性观察捕获。若只挂 load，真图会被永久错过。
    const { w, pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/loading.gif" data-tfsrc="https://img.cdn/placeholder.png">' +
      '</div></div>'
    );
    const el = w.document.getElementById('t1');

    // 首扫：当前 src 是占位图 loading.gif → 不应入池
    const before = pool.length;
    ok('占位图状态不误入池', before === 0, 'count=' + before);

    // 模拟站点替换：属性换成真图
    el.setAttribute('data-tfsrc', 'https://img.cdn/real-photo.jpg');
    // ⚠️ 必须等> 300ms：scanAddedDebounced 有 300ms 防抖，
    // 增量扫描在防抖窗口之后才真正执行。等于 300 会卡在边界上导致假失败。
    await sleep(700);

    const pool2 = w.__fiv.ImagePool.items;
    ok('属性替换后真图被收录', pool2.length === 1 && /real-photo\.jpg/.test(pool2[0].src),
      'count=' + pool2.length + ' → ' + (pool2[0] ? pool2[0].src : '(空)'));
  }

  console.log('\n【H2】真图定案后停止观察（不应反复重判）');
  {
    const { w, pool } = await withPage(
      '<div class="post"><div class="message">' +
      '<img id="t1" src="https://img.cdn/loading.gif" data-tfsrc="https://img.cdn/placeholder.png">' +
      '</div></div>'
    );
    const el = w.document.getElementById('t1');
    el.setAttribute('data-tfsrc', 'https://img.cdn/real-photo.jpg');
    await sleep(700);
    const n1 = w.__fiv.ImagePool.items.length;
    ok('真图已收录一条', n1 === 1, 'count=' + n1);

    // 再改属性：不应重复入池
    el.setAttribute('data-tfsrc', 'https://img.cdn/another.jpg');
    await sleep(700);
    const n2 = w.__fiv.ImagePool.items.length;
    ok('定案后改属性不重复入池', n2 === 1, 'count=' + n2 + '（不该为 2）');
  }

  console.log('\n【H3】MutationObserver 监听属性名须覆盖采集面');
  {
    // 若 attributeFilter 不含 data-tfsrc，则该属性从无到有时我们收不到通知
    const code = CODE;
    const m = code.match(/attributeFilter:\s*\[([^\]]*)\][\s\S]{0,80}?\]\s*\)/);
    const filters = code.match(/attributeFilter:\s*\[([^\]]+)\]/g) || [];
    const all = filters.join(',');
    const mustHave = ['data-tfsrc', 'data-original-src', 'data-raw', 'data-ks-lazyload',
      'data-img', 'data-imageurl', 'data-srcset', 'data-lazy', 'data-originalUrl'.toLowerCase()];
    for (const name of mustHave) {
      ok('监听面覆盖 ' + name, all.indexOf("'" + name + "'") >= 0, 'attributeFilter 未含');
    }
    ok('监听面仍包含 src/srcset', /'src'/.test(all) && /'srcset'/.test(all));
    void m;
  }

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();