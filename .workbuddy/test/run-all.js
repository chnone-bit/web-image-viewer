/**
 * 回归测试汇总器
 * 逐个跑测试套件，解析各自的统计行，输出汇总表。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FILES = fs.readdirSync(DIR)
  .filter(f => /^verify.*\.js$/.test(f))
  .sort();

let totalPass = 0, totalFail = 0, badSuites = [];

for (const f of FILES) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(DIR, f)], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  // 兼容两种统计格式：「通过 N 项 · 失败 M 项」与「N passed / M failed」
  let p = null, fl = null;
  let m = out.match(/通过\s*(\d+)\s*项\s*·\s*失败\s*(\d+)\s*项/);
  if (m) { p = +m[1]; fl = +m[2]; }
  else {
    m = out.match(/(\d+)\s*passed[^\d]*(\d+)\s*failed/i);
    if (m) { p = +m[1]; fl = +m[2]; }
    else {
      /* 真机套件（verify-lazy-live.js）走断言制，输出「PASS name / FAIL name」。
         ⚠️ 用 ASCII 而非 emoji —— emoji 经管道重定向会被按控制台代码页
            编码破坏，导致统计解析不到。 */
      const passed = (out.match(/^\s*PASS\s/gm) || []).length;
      const failed = (out.match(/^\s*FAIL\s/gm) || []).length;
      if (passed + failed > 0) { p = passed; fl = failed; }
    }
  }
  if (p === null) {
    console.log(f.padEnd(24) + ' (无法解析统计)');
    badSuites.push(f + ' : 无统计输出');
    continue;
  }
  totalPass += p; totalFail += fl;
  const mark = fl > 0 ? '❌' : '✅';
  console.log(f.padEnd(24) + String(p).padStart(4) + ' 通过  ' + mark + (fl > 0 ? (' ' + fl + ' 失败') : ''));
  if (fl > 0) badSuites.push(f + ' : ' + fl + ' 项失败');
}

console.log('-'.repeat(52));
console.log('合计：' + totalPass + ' 项通过，' + totalFail + ' 项失败');
if (badSuites.length) {
  console.log('\n问题套件：');
  badSuites.forEach(s => console.log('  ' + s));
}
process.exit(totalFail ? 1 : 0);
