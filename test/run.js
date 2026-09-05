'use strict';
// ============================================================================
// test/run.js — Action 侧纯函数单测（不触网、不依赖 imapflow/mailparser）
// 覆盖：config 关键词正则、prefilter 噪声/候选、parse 文本工具、state 水位/合并/prune、
//       ai 归一/校验/JSON 抽取/占位、gist 按文件 PATCH 不覆盖 vault + 损坏静默。
// 运行：node test/run.js
// ============================================================================

const assert = require('assert');

const config = require('../src/config');
const prefilter = require('../src/prefilter');
const parse = require('../src/parse');
const state = require('../src/state');
const ai = require('../src/ai');
const gist = require('../src/gist');

let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function runAll() {
  for (const c of cases) {
    try { await c.fn(); passed += 1; console.log(`  ✓ ${c.name}`); }
    catch (e) { failed += 1; console.error(`  ✗ ${c.name}\n    ${e.message}`); }
  }
  console.log(`\n${failed ? `存在 ${failed} 个失败用例` : '全部通过'}（共 ${passed + failed} 个，通过 ${passed}）`);
  if (failed) process.exitCode = 1;
}

test('STAGE_PRESETS 恰好 14 项且含 Offer/已结束', () => {
  assert.strictEqual(config.STAGE_PRESETS.length, 14);
  assert.ok(config.STAGE_PRESETS.includes('Offer'));
  assert.ok(config.STAGE_PRESETS.includes('已结束'));
});
test('keywordRegex 大小写不敏感、按 | 分隔', () => {
  const re = config.keywordRegex('面试|offer|测评');
  assert.ok(re.test('请你来面试'));
  assert.ok(re.test('An OFFER for you'));
  assert.ok(!re.test('天气预报'));
});

test('噪声发件人被排除', () => {
  assert.ok(prefilter.isNoise('no-reply@marketing.com', '面试通知'));
  assert.ok(prefilter.isNoise('hr@x.com', '退订请点此处'));
});
test('候选：命中关键词且非噪声', () => {
  const re = config.keywordRegex(config.DEFAULT_KEYWORDS);
  assert.ok(prefilter.isCandidate({ from: 'hr@bytedance.com', subject: '面试邀请', textBody: '你好' }, re));
  assert.ok(!prefilter.isCandidate({ from: 'noreply@shop.com', subject: '面试技巧课程促销 退订', textBody: '面试' }, re));
  assert.ok(!prefilter.isCandidate({ from: 'hr@x.com', subject: '你的订单已发货', textBody: '物流信息' }, re));
});

test('htmlToText 剥标签/解实体/去脚本', () => {
  const t = parse.htmlToText('<html><body><script>var a=1;</script><p>面试&nbsp;通知</p><br><div>9月12日</div></body></html>');
  assert.ok(t.includes('面试 通知'));
  assert.ok(t.includes('9月12日'));
  assert.ok(!t.includes('var a'));
  assert.ok(!t.includes('<'));
});
test('truncateBody 截断到 4000 字并加省略号', () => {
  const long = 'a'.repeat(5000);
  const out = parse.truncateBody(long);
  assert.ok(out.length <= parse.MAX_BODY + 1);
  assert.ok(out.endsWith('…'));
});

test('computeWatermark 推进到已抓取最大 UID（含非候选）', () => {
  const w = state.computeWatermark({ uidValidity: 999 }, [10, 12, 11], { lastUid: 8, lastUidValidity: 999 });
  assert.strictEqual(w.lastUid, 12);
  assert.strictEqual(w.lastUidValidity, 999);
});
test('computeWatermark 无新邮件时保留旧水位', () => {
  const w = state.computeWatermark({ uidValidity: 5 }, [], { lastUid: 42, lastUidValidity: 5 });
  assert.strictEqual(w.lastUid, 42);
});
test('mergeSuggestions 按 sourceUid 去重、incoming 覆盖、id 稳定', () => {
  const prev = [{ sourceUid: 1, id: 'uid-1', company: '旧', receivedAt: new Date().toISOString() }];
  const inc = [{ sourceUid: 1, id: 'uid-1', company: '新', receivedAt: new Date().toISOString() }, { sourceUid: 2, id: 'uid-2', company: 'B', receivedAt: new Date().toISOString() }];
  const merged = state.mergeSuggestions(prev, inc);
  assert.strictEqual(merged.length, 2);
  const one = merged.find(s => s.sourceUid === 1);
  assert.strictEqual(one.company, '新');
});
test('pruneSuggestions 上限 100 条、丢弃 30 天前', () => {
  const now = Date.now();
  const list = [];
  for (let i = 0; i < 120; i += 1) list.push({ sourceUid: i + 1, receivedAt: new Date(now - i * 3600000).toISOString() });
  list.push({ sourceUid: 999, receivedAt: new Date(now - 40 * 86400000).toISOString() });
  const pruned = state.pruneSuggestions(list);
  assert.ok(pruned.length <= state.PRUNE_MAX);
  assert.ok(!pruned.some(s => s.sourceUid === 999));
});

test('normalizeEmailType 同义词归一', () => {
  assert.strictEqual(ai.normalizeEmailType('interview'), '面试邀请');
  assert.strictEqual(ai.normalizeEmailType('录用通知'), 'Offer');
  assert.strictEqual(ai.normalizeEmailType('很遗憾通知你'), '拒信');
  assert.strictEqual(ai.normalizeEmailType('在线测评'), '测评');
  assert.strictEqual(ai.normalizeEmailType('随便什么'), '其它');
});
test('normalizeStage 仅接受预设，否则置空（防臆造）', () => {
  assert.strictEqual(ai.normalizeStage('二面'), '二面');
  assert.strictEqual(ai.normalizeStage('终面'), '');
  assert.strictEqual(ai.normalizeStage(''), '');
});
test('normalizeScheduleAt 支持 ISO/中文/仅日期', () => {
  assert.deepStrictEqual(ai.normalizeScheduleAt('2026-09-12T14:30:00Z').scheduleAt, '2026-09-12T14:30');
  assert.strictEqual(ai.normalizeScheduleAt('2026年9月12日 14:30').scheduleAt, '2026-09-12T14:30');
  const dateOnly = ai.normalizeScheduleAt('2026-09-12');
  assert.strictEqual(dateOnly.scheduleAt, '');
  assert.strictEqual(dateOnly.scheduleDate, '2026-09-12');
  assert.strictEqual(ai.normalizeScheduleAt('').scheduleAt, '');
});
test('extractJson 去 ```json 围栏并截取对象', () => {
  const obj = ai.extractJson('```json\n{"emailType":"Offer","confidence":0.9}\n```');
  assert.strictEqual(obj.emailType, 'Offer');
});
test('normalizeAiResult 钳制 confidence、生成 proposed.milestone', () => {
  const mail = { sourceUid: 7, receivedAt: '2026-09-10T08:00:00.000Z', from: 'hr@x.com', subject: '面试邀请', textBody: '' };
  const r = ai.normalizeAiResult({ emailType: '面试邀请', company: '星海科技', stage: '二面', scheduleAt: '2026-09-12T14:30', round: '技术二面', location: '线上', confidence: 5, summary: 'x'.repeat(80) }, mail);
  assert.strictEqual(r.confidence, 1);
  assert.strictEqual(r.summary.length, 60);
  assert.strictEqual(r.proposed.milestone.stage, '二面');
  assert.strictEqual(r.proposed.milestone.at, '2026-09-12');
  assert.strictEqual(r.proposed.milestone.note, '邮件·面试邀请');
  assert.ok(r.proposed.recentSchedule.includes('技术二面'));
});
test('placeholderAnalyze 无 Key 时可跑，company 粗提取、stage 空、confidence 0', () => {
  const mail = { sourceUid: 3, receivedAt: '2026-09-10T08:00:00.000Z', from: 'campus@jobs.bytedance.com', fromName: '', subject: '笔试邀请', textBody: '' };
  const r = ai.placeholderAnalyze(mail);
  assert.strictEqual(r.stage, '');
  assert.strictEqual(r.confidence, 0);
  assert.ok(typeof r.company === 'string');
  assert.ok(r.proposed && r.proposed.milestone);
});

test('readMailFile 损坏内容静默返回 null', () => {
  assert.strictEqual(gist.readMailFile({ files: { 'mail-suggestions.json': { content: '{ not json' } } }, 'mail-suggestions.json'), null);
  assert.strictEqual(gist.readMailFile({ files: {} }, 'mail-suggestions.json'), null);
});
test('patchMailFile 只提交 mail-suggestions.json，绝不触碰 vault', async () => {
  let captured = null;
  const stubFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({}) }; };
  const cfg = { gist: { apiBase: 'https://api.github.com', id: 'GID', token: 'T', filename: 'mail-suggestions.json' } };
  await gist.patchMailFile(cfg, { meta: {}, suggestions: [] }, stubFetch);
  const body = JSON.parse(captured.opts.body);
  const keys = Object.keys(body.files);
  assert.deepStrictEqual(keys, ['mail-suggestions.json']);
  assert.ok(!keys.some(k => /^vault-/.test(k) || k === 'qiuzhao-tracker-data.json'));
});

runAll();
