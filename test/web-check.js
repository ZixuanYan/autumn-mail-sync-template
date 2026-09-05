'use strict';
// ============================================================================
// test/web-check.js — 网页端（autumn-recruitment-tracker/index.html）本地校验：
//   1) 内联 <script> 用 vm.Script 做语法校验（只编译不执行，无需 DOM）；
//   2) 抽取 /*__MAIL_PURE_START__*/…/*__MAIL_PURE_END__*/ 纯函数块，跑单测：
//      normalizeCompanySlug / diceCoefficient / matchRecordsByCompany / filterMailSuggestions
//      （0/1/多命中、后缀剥离、全半角）。
// 运行：node test/web-check.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.resolve(__dirname, '../../autumn-recruitment-tracker/index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ---- 1) 内联脚本语法校验 ----
console.log('内联 <script> 语法校验（vm.Script 只编译不执行）');
const inlineScripts = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) inlineScripts.push(m[1]);
check(`提取到 ${inlineScripts.length} 个内联脚本（≥1）`, () => assert.ok(inlineScripts.length >= 1));
inlineScripts.forEach((code, i) => {
  check(`内联脚本 #${i + 1} 语法通过（${code.length} 字符）`, () => { new vm.Script(code, { filename: `inline-${i + 1}.js` }); });
});

// ---- 2) 抽取纯函数块并单测 ----
console.log('邮件匹配纯函数单测');
const startMark = '/*__MAIL_PURE_START__*/';
const endMark = '/*__MAIL_PURE_END__*/';
const si = html.indexOf(startMark);
const ei = html.indexOf(endMark);
check('找到纯函数块标记', () => { assert.ok(si !== -1 && ei !== -1 && ei > si, '未找到 __MAIL_PURE_START__/__END__ 标记'); });
const pureSrc = html.slice(si + startMark.length, ei);
const helpers = new Function(`${pureSrc}; return { normalizeCompanySlug, diceCoefficient, companyMatchScore, matchRecordsByCompany, filterMailSuggestions };`)();

check('normalizeCompanySlug 剥离后缀 + 全角转半角 + 小写', () => {
  const { normalizeCompanySlug, companyMatchScore } = helpers;
  assert.strictEqual(normalizeCompanySlug('腾讯科技有限公司'), '腾讯'); // 末尾后缀循环剥离
  assert.strictEqual(normalizeCompanySlug('Ｔｅｎｃｅｎｔ'), 'tencent'); // 全角拉丁→半角小写
  assert.strictEqual(normalizeCompanySlug('北京字节跳动科技有限公司'), '北京字节跳动');
  assert.strictEqual(normalizeCompanySlug('腾讯科技（深圳）有限公司'), '腾讯科技深圳'); // 全角括号去除、城市中缀保留
  assert.ok(companyMatchScore('腾讯科技（深圳）有限公司', '腾讯') >= 0.6); // 仍能经「互相包含」命中
  assert.strictEqual(normalizeCompanySlug(''), '');
});

check('diceCoefficient 相同=1、无关≈0', () => {
  const { diceCoefficient } = helpers;
  assert.strictEqual(diceCoefficient('abc', 'abc'), 1);
  assert.ok(diceCoefficient('腾讯', '阿里巴巴') < 0.2);
  assert.strictEqual(diceCoefficient('', 'x'), 0);
});

check('matchRecordsByCompany 单一命中（后缀差异）', () => {
  const { matchRecordsByCompany } = helpers;
  const records = [
    { id: 'r1', company: '腾讯', position: '后端' },
    { id: 'r2', company: '阿里巴巴', position: '前端' }
  ];
  const hits = matchRecordsByCompany('腾讯科技（深圳）有限公司', '后端', records);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, 'r1');
});

check('matchRecordsByCompany 多命中（同名不同岗位）', () => {
  const { matchRecordsByCompany } = helpers;
  const records = [
    { id: 'a', company: '字节跳动', position: '算法' },
    { id: 'b', company: '北京字节跳动科技有限公司', position: '客户端' }
  ];
  const hits = matchRecordsByCompany('字节跳动', '', records);
  assert.ok(hits.length >= 2, `期望多命中，实际 ${hits.length}`);
});

check('matchRecordsByCompany 0 命中', () => {
  const { matchRecordsByCompany } = helpers;
  const records = [{ id: 'x', company: '美团', position: '产品' }];
  assert.strictEqual(matchRecordsByCompany('特斯拉', '', records).length, 0);
  assert.strictEqual(matchRecordsByCompany('', '', records).length, 0);
});

check('filterMailSuggestions 过滤 applied/dismissed', () => {
  const { filterMailSuggestions } = helpers;
  const sugs = [{ id: 'uid-1' }, { id: 'uid-2' }, { id: 'uid-3' }];
  const out = filterMailSuggestions(sugs, ['uid-1'], ['uid-3']);
  assert.deepStrictEqual(out.map(s => s.id), ['uid-2']);
});

console.log(`\n${failed ? `存在 ${failed} 个失败` : '网页端校验全部通过'}`);
if (failed) process.exitCode = 1;
