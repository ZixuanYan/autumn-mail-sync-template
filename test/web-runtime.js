'use strict';
// ============================================================================
// test/web-runtime.js — 网页端「邮件提醒」运行时冒烟测试（无需浏览器/jsdom）
// 从 index.html 抽出邮件提醒整段函数，放进带桩 DOM 的 vm 沙箱真实执行，覆盖：
//   renderMailView 四态（未开云同步/无建议/失败/正常）、mailCardHtml 的 0/1/多命中
//   与高低置信勾选、applyMailPayload 过滤 applied、updateMailBadge 角标。
// 运行：node test/web-runtime.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.resolve(__dirname, '../../autumn-recruitment-tracker/index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const START = '      // ================= 邮件提醒（M3）：本地状态、模糊匹配、复核视图、应用/忽略 =================';
const END = '      // ================= 视图路由：#/view 形式，旧锚点 #view 自动重定向 =================';
const si = html.indexOf(START);
const ei = html.indexOf(END);
if (si === -1 || ei === -1 || ei <= si) { console.error('✗ 未定位到邮件提醒函数段'); process.exit(1); }
const sectionSrc = html.slice(si, ei);

// ---- 桩 DOM / 应用全局 ----
const els = {};
const sandbox = {
  console,
  $: sel => (els[sel] || (els[sel] = { className: '', innerHTML: '', textContent: '', hidden: false })),
  escapeHtml: v => String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
  formatClock: v => (v ? `CLK` : ''),
  formatDateTime: v => (v ? `DT(${v})` : '暂未安排'),
  localDateInput: () => '2026-09-05',
  MAIL_STORAGE_KEY: 'test.mail.v1',
  MAIL_CONFIG_FILENAME: 'mail-config.json',
  MAIL_CFG_DEFAULTS: { keywords: 'K', minConfidence: 0.3, sinceDays: 30, maxPerRun: 30, enabled: true, minIntervalHours: 0, promptExtra: '' },
  localStorage: { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); } },
  crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(Math.random() * 256); return a; } },
  records: [],
  syncConfig: { token: '', gistId: 'GID' },
  mailState: { appliedIds: [], dismissedIds: [], lastReadAt: '', encKey: '' },
  mailSuggestions: [],
  mailRawSuggestions: [],
  mailMeta: null,
  mailConfig: null,
  mailNeedKey: false,
  pendingMailSeedId: null,
  normalizeRecord: o => ({ ...o, id: o.id || 'new', stage: o.stage || '待投递', timeline: o.timeline || [{ stage: o.stage || '待投递', at: '2026-09-05', note: '' }] }),
  setTimeline: (rec, tl) => { rec.timeline = tl; rec.stage = tl[tl.length - 1].stage; return rec; },
  saveRecords: () => {}, render: () => {}, flashRow: () => {}, playOfferStamp: () => {}, showToast: () => {}, openDialog: () => {},
  scheduleSyncPush: () => {}, resolveSyncGist: async () => 'GID', gistRequest: async () => ({}), syncNow: async () => {}, openSyncDialog: () => {},
  CSS: { escape: s => s },
  document: { querySelector: () => null }
};

vm.createContext(sandbox);
vm.runInContext(sectionSrc, sandbox, { filename: 'mail-section.js' });

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const bar = () => els['#mailStatusBar'];
const list = () => els['#mailList'];
const badge = () => els['#mailNavBadge'];

console.log('renderMailView 状态');
check('未开云同步 → warning 条 + 空列表', () => {
  sandbox.syncConfig.token = '';
  sandbox.renderMailView();
  assert.ok(bar().className.includes('warning'));
  assert.ok(bar().innerHTML.includes('需先开启云同步'));
  assert.strictEqual(list().innerHTML, '');
});
check('已开云同步但无 meta → 暂无邮件建议', () => {
  sandbox.syncConfig.token = 'tok'; sandbox.mailMeta = null; sandbox.mailSuggestions = [];
  sandbox.renderMailView();
  assert.ok(bar().innerHTML.includes('暂无邮件建议'));
  assert.ok(list().innerHTML.includes('mail-empty'));
});
check('meta.lastStatus=error → error 条 + lastError + 修复说明', () => {
  sandbox.mailMeta = { lastStatus: 'error', lastError: 'QQ 授权码失效' };
  sandbox.renderMailView();
  assert.ok(bar().className.includes('error'));
  assert.ok(bar().innerHTML.includes('QQ 授权码失效'));
  assert.ok(bar().innerHTML.includes('怎么修复'));
});
check('meta 正常 → ok 条 + 统计', () => {
  sandbox.mailMeta = { lastStatus: 'ok', lastRunAt: '2026-09-05T10:00:00Z', newCount: 2, pendingCount: 3 };
  sandbox.mailSuggestions = [{ id: 'uid-9', sourceUid: 9, company: 'X', confidence: 0.9, proposed: {} }];
  sandbox.records = [];
  sandbox.renderMailView();
  assert.ok(bar().className.includes('ok'));
  assert.ok(list().innerHTML.includes('mail-card'));
});

console.log('mailCardHtml 匹配分支');
const baseSug = {
  id: 'uid-1', sourceUid: 1, company: '腾讯科技（深圳）有限公司', position: '后端', emailType: '面试邀请',
  confidence: 0.8, subject: '面试邀请', summary: '二面通知', from: 'hr@t.com', receivedAt: '2026-09-05T10:00:00Z',
  proposed: { milestone: { stage: '二面', at: '2026-09-12', note: '邮件·面试邀请' }, scheduleAt: '2026-09-12T14:30', recentSchedule: '二面 · 线上', nextAction: '准备项目' }
};
check('1 命中 → single + data-target-id + 应用所选 + 高置信默认勾选', () => {
  sandbox.records = [{ id: 'r1', company: '腾讯', position: '后端', stage: '一面' }];
  const h = sandbox.mailCardHtml(baseSug);
  assert.ok(h.includes('mail-match single'));
  assert.ok(h.includes('data-target-id="r1"'));
  assert.ok(h.includes('data-mail-action="apply"'));
  assert.ok(h.includes('data-mail-field="milestone" checked'));
  assert.ok(!h.includes('low-conf'));
});
check('多命中 → 下拉选择 mail-target-select', () => {
  sandbox.records = [{ id: 'a', company: '腾讯', position: '后端', stage: '一面' }, { id: 'b', company: '腾讯科技', position: '前端', stage: '笔试' }];
  const h = sandbox.mailCardHtml(baseSug);
  assert.ok(h.includes('mail-target-select'));
  assert.ok(h.includes('<option'));
});
check('0 命中 → none + 新建记录按钮', () => {
  sandbox.records = [{ id: 'z', company: '美团', position: '产品', stage: '一面' }];
  const h = sandbox.mailCardHtml(baseSug);
  assert.ok(h.includes('mail-match none'));
  assert.ok(h.includes('data-mail-action="new"'));
});
check('低置信 → low-conf 且默认不勾选', () => {
  sandbox.records = [{ id: 'r1', company: '腾讯', position: '后端', stage: '一面' }];
  const h = sandbox.mailCardHtml({ ...baseSug, confidence: 0.4 });
  assert.ok(h.includes('low-conf'));
  assert.ok(h.includes('data-mail-field="milestone" >') || !h.includes('milestone" checked'));
  assert.ok(!h.includes('data-mail-field="milestone" checked'));
});

console.log('applyMailPayload / updateMailBadge');
check('applyMailPayload 过滤 appliedIds，只留待复核', () => {
  sandbox.mailState = { appliedIds: ['uid-1'], dismissedIds: [], lastReadAt: '' };
  sandbox.syncConfig.token = 'tok';
  sandbox.applyMailPayload({ meta: { lastStatus: 'ok', newCount: 2, pendingCount: 2 }, suggestions: [{ id: 'uid-1', sourceUid: 1 }, { id: 'uid-2', sourceUid: 2 }] });
  assert.strictEqual(sandbox.mailSuggestions.length, 1);
  assert.strictEqual(sandbox.mailSuggestions[0].id, 'uid-2');
});
check('applyMailPayload(null) 清空建议与 meta', () => {
  sandbox.applyMailPayload(null);
  assert.strictEqual(sandbox.mailSuggestions.length, 0);
  assert.strictEqual(sandbox.mailMeta, null);
});
check('updateMailBadge 数量>0 显示、=0 隐藏', () => {
  sandbox.mailSuggestions = [{ id: 'a' }, { id: 'b' }];
  sandbox.updateMailBadge();
  assert.strictEqual(badge().textContent, '2');
  assert.strictEqual(badge().hidden, false);
  sandbox.mailSuggestions = [];
  sandbox.updateMailBadge();
  assert.strictEqual(badge().hidden, true);
});

console.log('加密 / 配置 / 跨设备（v4.3.0）');
check('mailNeedKey=true → 提示填写解密密钥、列表清空', () => {
  sandbox.syncConfig.token = 'tok';
  sandbox.mailNeedKey = true;
  sandbox.renderMailView();
  assert.ok(bar().className.includes('warning'));
  assert.ok(bar().innerHTML.includes('邮件建议已加密'));
  assert.strictEqual(list().innerHTML, '');
  sandbox.mailNeedKey = false;
});
check('applyMailPayload 存原始建议；refilterMail 按 mailState 过滤（模拟跨设备合并）', () => {
  sandbox.mailState = { appliedIds: ['uid-2'], dismissedIds: [], lastReadAt: '', encKey: '' };
  sandbox.applyMailPayload({ meta: { lastStatus: 'ok' }, suggestions: [{ id: 'uid-1' }, { id: 'uid-2' }, { id: 'uid-3' }] });
  assert.strictEqual(sandbox.mailRawSuggestions.length, 3);
  assert.deepStrictEqual(sandbox.mailSuggestions.map(s => s.id), ['uid-1', 'uid-3']);
  sandbox.mailState.dismissedIds = ['uid-1']; // 另一设备忽略了 uid-1，同步并集后
  sandbox.refilterMail();
  assert.deepStrictEqual(sandbox.mailSuggestions.map(s => s.id), ['uid-3']);
});
check('currentMailConfig 无云端配置时回落默认值', () => {
  sandbox.mailConfig = null;
  const c = sandbox.currentMailConfig();
  assert.strictEqual(c.minConfidence, 0.3);
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.sinceDays, 30);
});

console.log(`\n${failed ? `存在 ${failed} 个失败` : '邮件提醒运行时冒烟测试全部通过'}`);
if (failed) process.exitCode = 1;
