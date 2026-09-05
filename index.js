'use strict';
// ============================================================================
// index.js — 编排：连接 → 读水位 → 增量 fetch → 预筛 → 解析 → AI → 合并 → 写 meta → PATCH
// 两种模式：
//   node index.js                正常同步
//   node index.js --report-error 兜底：仅把 meta 标记为 error（保留已有 suggestions/水位），
//                                供 workflow `if: failure()` 步骤在硬崩溃后调用。
// 失败策略：
//   硬失败（连接/抓取/Gist/密钥缺失）→ 尽力写 error meta（保留旧 suggestions+旧水位）→ 退出码 1；
//   软失败（部分 AI 调用失败）→ 正常写建议与水位，meta.lastStatus='error'+lastError 上屏 → 退出码 0。
// ============================================================================

const { buildConfig, keywordRegex } = require('./src/config');
const { openInbox, closeInbox, planFetch, fetchMessages } = require('./src/imap');
const { isCandidate } = require('./src/prefilter');
const { parseMessage } = require('./src/parse');
const { computeWatermark, buildSuggestion, mergeSuggestions, buildMeta } = require('./src/state');
const { gistGet, readMailFile, patchMailFile } = require('./src/gist');
const { analyzeEmail } = require('./src/ai');

function assertSecrets(cfg) {
  const missing = [];
  if (!cfg.imap.user) missing.push('QQ_EMAIL');
  if (!cfg.imap.pass) missing.push('QQ_AUTHCODE');
  if (!cfg.gist.id) missing.push('GIST_ID');
  if (!cfg.gist.token) missing.push('GIST_PAT');
  if (missing.length) throw new Error(`缺少必需 Secrets：${missing.join(', ')}`);
}

async function loadPrev(cfg) {
  const gist = await gistGet(cfg);
  const prev = readMailFile(gist, cfg.gist.filename);
  return {
    meta: (prev && prev.meta && typeof prev.meta === 'object') ? prev.meta : {},
    suggestions: (prev && Array.isArray(prev.suggestions)) ? prev.suggestions : []
  };
}

// 尽力写 error meta：保留旧 suggestions 与旧水位（本轮不可信）
async function writeErrorMeta(cfg, message) {
  try {
    const prev = await loadPrev(cfg);
    const meta = buildMeta({
      prevMeta: prev.meta,
      watermark: { lastUidValidity: Number(prev.meta.lastUidValidity) || 0, lastUid: Number(prev.meta.lastUid) || 0 },
      status: 'error',
      lastError: message,
      newCount: 0,
      pendingCount: prev.suggestions.length
    });
    await patchMailFile(cfg, { meta, suggestions: prev.suggestions });
    console.log(`[sync] 已把失败原因写入 meta.lastError：${message}`);
  } catch (e) {
    console.error(`[sync] 兜底写 error meta 也失败（Gist 不可达？）：${e.message}`);
  }
}

async function run() {
  const cfg = buildConfig();
  assertSecrets(cfg);

  const prev = await loadPrev(cfg);
  console.log(`[sync] 读回水位 lastUid=${prev.meta.lastUid || 0} uidValidity=${prev.meta.lastUidValidity || 0}，已有建议 ${prev.suggestions.length} 条`);

  const { client, lock, mailbox } = await openInbox(cfg);
  let fetched = [];
  const incoming = [];
  let candidates = 0;
  let aiErrors = 0;
  let lastAiError = '';

  try {
    const plan = planFetch(mailbox, prev.meta, cfg.sinceDays);
    console.log(`[sync] 抓取模式=${plan.mode}${plan.mode === 'uid' ? ` startUid=${plan.startUid}` : ` since=${plan.since.toISOString()}`}${plan.resetWatermark ? '（UIDVALIDITY 变化→重置水位）' : ''}`);
    fetched = await fetchMessages(client, plan, cfg.maxPerRun);
    console.log(`[sync] 本次抓取 ${fetched.length} 封（上限 ${cfg.maxPerRun}），INBOX exists=${mailbox.exists}`);

    const kw = keywordRegex(cfg.keywords);
    for (const msg of fetched) {
      const mail = await parseMessage(msg);
      if (!isCandidate(mail, kw)) continue;
      candidates += 1;
      let result;
      try {
        result = await analyzeEmail(mail, cfg);
      } catch (e) {
        aiErrors += 1;
        lastAiError = e.message;
        console.warn(`[sync] AI 分析失败 uid=${mail.sourceUid}：${e.message}`);
        continue;
      }
      if (Number(result.confidence) < cfg.minConfidence) {
        console.log(`[sync] 丢弃低置信 uid=${mail.sourceUid} conf=${result.confidence} < ${cfg.minConfidence}`);
        continue;
      }
      incoming.push(buildSuggestion(mail, result));
    }
  } finally {
    await closeInbox(client, lock);
  }

  const merged = mergeSuggestions(prev.suggestions, incoming);
  const watermark = computeWatermark(mailbox, fetched.map(m => m.uid), prev.meta);
  const softError = aiErrors > 0;
  const meta = buildMeta({
    prevMeta: prev.meta,
    watermark,
    status: softError ? 'error' : 'ok',
    lastError: softError ? `AI 分析失败 ${aiErrors}/${candidates} 封：${lastAiError}` : '',
    newCount: incoming.length,
    pendingCount: merged.length
  });

  await patchMailFile(cfg, { meta, suggestions: merged });
  console.log(`[sync] ✅ 完成：候选 ${candidates}，新增/更新 ${incoming.length}，合并后 ${merged.length} 条，lastUid→${meta.lastUid}，lastStatus=${meta.lastStatus}`);
  if (softError) console.warn('[sync] ⚠️ 存在 AI 软失败，已写入 meta.lastError（网页端会上屏提示），本轮抓取/水位正常。');
}

async function reportError() {
  const cfg = buildConfig();
  if (!cfg.gist.id || !cfg.gist.token) {
    console.error('[sync] 无法兜底：缺少 GIST_ID / GIST_PAT');
    process.exitCode = 1;
    return;
  }
  const message = process.env.MAIL_SYNC_ERROR || '邮件同步失败，请查看本次 Action 日志（常见原因：QQ 授权码失效 / AI 超额 / IMAP 被风控）';
  await writeErrorMeta(cfg, message);
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--report-error')) await reportError();
    else await run();
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error(`[sync] ❌ 硬失败：${message}`);
    // 尽力把失败原因上屏（保留旧建议与旧水位）
    const cfg = buildConfig();
    if (cfg.gist.id && cfg.gist.token) await writeErrorMeta(cfg, message);
    process.exitCode = 1;
  }
}

main();
