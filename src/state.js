'use strict';
// ============================================================================
// state.js — 建议文件的状态管理：高水位、suggestions 合并/去重/prune、meta 组装
// 全部为纯函数，便于本地单测（不触网、不依赖 imapflow/mailparser）。
// ============================================================================

const PRUNE_DAYS = 30;
const PRUNE_MAX = 100;

// 高水位：推进到本次「已抓取」的最大 UID（不论是否候选），避免非候选邮件被反复重扫。
// UIDVALIDITY 变化时以当前邮箱的 uidValidity 为准（水位随之重置）。
function computeWatermark(mailbox, fetchedUids, prevMeta) {
  const uidValidity = Number(mailbox && mailbox.uidValidity) || 0;
  let lastUid = Number(prevMeta && prevMeta.lastUid) || 0;
  for (const uid of (fetchedUids || [])) {
    const n = Number(uid) || 0;
    if (n > lastUid) lastUid = n;
  }
  return { lastUidValidity: uidValidity, lastUid };
}

// 由邮件 + AI/占位结果组装一条建议（契约见计划文件「建议文件契约」）
function buildSuggestion(mail, result) {
  const r = result || {};
  return {
    id: `uid-${mail.sourceUid}`,
    sourceUid: Number(mail.sourceUid) || 0,
    receivedAt: mail.receivedAt || '',
    from: mail.from || '',
    subject: mail.subject || '',
    emailType: r.emailType || '其它',
    company: r.company || '',
    position: r.position || '',
    stage: r.stage || '',
    scheduleAt: r.scheduleAt || '',
    location: r.location || '',
    round: r.round || '',
    summary: r.summary || '',
    confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0,
    proposed: r.proposed || { milestone: { stage: '', at: '', note: '' }, scheduleAt: '', recentSchedule: '', nextAction: '' }
  };
}

// prune：近 PRUNE_DAYS 天、按 receivedAt 倒序、最多 PRUNE_MAX 条
function pruneSuggestions(list) {
  const cutoff = Date.now() - PRUNE_DAYS * 86400000;
  return (Array.isArray(list) ? list : [])
    .filter(s => {
      const t = Date.parse(s && s.receivedAt || '');
      return !Number.isFinite(t) || t >= cutoff; // 无法判定时间的保守保留
    })
    .sort((a, b) => (Date.parse(b.receivedAt || '') || 0) - (Date.parse(a.receivedAt || '') || 0))
    .slice(0, PRUNE_MAX);
}

// 合并：按 sourceUid 去重（同一封以本次结果覆盖旧结果），保留 id 稳定（uid-<sourceUid>），
// 这样网页端 appliedIds/dismissedIds（按 id）在建议被重新分析后依然生效。
function mergeSuggestions(prevList, incoming) {
  const byUid = new Map();
  for (const s of (Array.isArray(prevList) ? prevList : [])) {
    const uid = Number(s && s.sourceUid) || 0;
    if (uid) byUid.set(uid, s);
  }
  for (const s of (Array.isArray(incoming) ? incoming : [])) {
    const uid = Number(s && s.sourceUid) || 0;
    if (uid) byUid.set(uid, s); // 覆盖
  }
  return pruneSuggestions([...byUid.values()]);
}

function buildMeta({ prevMeta, watermark, status, lastError, newCount, pendingCount }) {
  return {
    version: 1,
    lastRunAt: new Date().toISOString(),
    lastStatus: status === 'error' ? 'error' : 'ok',
    lastError: status === 'error' ? String(lastError || '同步失败') : '',
    lastUidValidity: Number(watermark && watermark.lastUidValidity) || Number(prevMeta && prevMeta.lastUidValidity) || 0,
    lastUid: Number(watermark && watermark.lastUid) || Number(prevMeta && prevMeta.lastUid) || 0,
    newCount: Number(newCount) || 0,
    pendingCount: Number(pendingCount) || 0
  };
}

module.exports = {
  PRUNE_DAYS,
  PRUNE_MAX,
  computeWatermark,
  buildSuggestion,
  pruneSuggestions,
  mergeSuggestions,
  buildMeta
};
