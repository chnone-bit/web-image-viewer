/**
 * 图片悬停角标（「以图定域」入口）回归测试
 * 断言：
 *   - 悬停内容图 → 角标显形，文案为「看这组 · N」
 *   - 悬停非池内图 / 空白处 → 角标隐藏
 *   - 单图（不成组）默认不显形（hoverBadgeGroupOnly）
 *   - 点击角标 → 只浏览该组，且定位到源图
 *   - 关闭开关 hoverBadge 后完全不显形
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="post" id="pA"><div class="message">
    <img id="A1" src="https://x.com/a1.jpg"><img id="A2" src="https://x.com/a2.jpg">
  </div></div>
  <div class="post" id="pB"><div class="message">
    <img id="B1" src="https://x.com/b1.jpg"><img id="B2" src="https://x.com/b2.jpg">
  </div></div>
  <div class="lonely"><img id="L1" src="https://x.com/l1.jpg"><img id="L2" src="https://x.com/l2.jpg"></div>
  <p id="plain">一段没有图片的文字</p>
</body></html>`, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
w.Element.prototype.getBoundingClientRect = function () {
  return { left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100 };
};
w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.Element.prototype.scrollIntoView = function () {};
w.scrollTo = () => {};
w.console.error = () => {};

w.eval(CODE);

const q = (s) => w.document.querySelector(s);
const badge = () => q('.fiv-badge');
const badgeOn = () => { const b = badge(); return !!b && b.classList.contains('fiv-on'); };
const badgeLabel = () => { const b = badge(); const s = b && b.querySelector('span'); return s ? s.textContent : ''; };
const curAlt = () => { const a = q('.fiv-anchor'); return a ? (a.id || a.alt) : 'none'; };

/** 在某个元素上触发 mousemove（模拟悬停） */
function hover(el) {
  const ev = new w.MouseEvent('mousemove', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'target', { value: el, configurable: true });
  w.document.dispatchEvent(ev);
}

setTimeout(() => {
  console.log('\n【显形】悬停内容图');
  hover(w.document.getElementById('A2'));
  setTimeout(() => {
    ok('角标已显形 (.fiv-on)', badgeOn());
    ok('文案为「看这组 · 2」', /看这组.*2/.test(badgeLabel()), badgeLabel());
    ok('源图被高亮 (.fiv-hot)', w.document.getElementById('A2').classList.contains('fiv-hot'));
    ok('角标为半透明（0<op<1）', (() => {
      const op = badge().style.getPropertyValue('--fiv-badge-op');
      const v = parseFloat(op);
      return v > 0 && v < 1;
    })(), badge().style.getPropertyValue('--fiv-badge-op'));

    console.log('\n【切换组】悬停另一个组的图 → 文案跟随');
    hover(w.document.getElementById('B1'));
    setTimeout(() => {
      ok('仍显形', badgeOn());
      ok('旧图高亮已移除', !w.document.getElementById('A2').classList.contains('fiv-hot'));
      ok('新图已高亮 (B1)', w.document.getElementById('B1').classList.contains('fiv-hot'));

      console.log('\n【隐藏】悬停非图片区域');
      hover(w.document.getElementById('plain'));
      setTimeout(() => {
        ok('角标已隐藏', !badgeOn(), badge() ? badge().className : 'null');
        ok('高亮已清除', !w.document.getElementById('B1').classList.contains('fiv-hot'));

        console.log('\n【点击】角标 → 只浏览本组');
        hover(w.document.getElementById('A2'));
        setTimeout(() => {
          badge().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            ok('浏览器已打开', w.document.getElementById('fiv-root').classList.contains('fiv-open'));
            ok('计数器为 1 / 2（仅 A 组）', /\/ 2/.test(q('.fiv-counter').textContent), q('.fiv-counter').textContent);
            ok('定位到源图 A2', curAlt() === 'A2', '实际 ' + curAlt());
            ok('角标已隐藏（进入浏览后）', !badgeOn());

            // 退出浏览
            w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            setTimeout(() => {
              w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              setTimeout(() => {
                console.log('\n【配置】关闭角标开关');
                w.__fiv.Config.set('hoverBadge', false);
                hover(w.document.getElementById('A1'));
                setTimeout(() => {
                  ok('关闭后悬停不再显形', !badgeOn(), badge() ? badge().className : 'null');

                  console.log('\n【配置】打开角标 + 单图也显示');
                  w.__fiv.Config.set('hoverBadge', true);
                  w.__fiv.Config.set('hoverBadgeGroupOnly', false);
                  hover(w.document.getElementById('A1'));
                  setTimeout(() => {
                    ok('重新开启后显形', badgeOn());
                    finish();
                  }, 200);
                }, 200);
              }, 260);
            }, 320);
          }, 400);
        }, 200);
      }, 220);
    }, 220);
  }, 220);
}, 700);

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
