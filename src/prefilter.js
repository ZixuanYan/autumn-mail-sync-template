'use strict';
// ============================================================================
// prefilter.js — 关键词预筛：只有候选邮件才进 AI，省 token、降噪
// 规则：命中 KEYWORDS（主题/正文）且 未命中噪声（发件人/主题的营销/退订/系统信使）
// ============================================================================

const { noiseRegex } = require('./config');

const NOISE_RE = noiseRegex();

// 发件人或主题命中噪声词 → 丢弃
function isNoise(from, subject) {
  const hay = `${from || ''} ${subject || ''}`;
  return NOISE_RE.test(hay);
}

// 候选判定：非噪声 且 主题/正文命中关键词
function isCandidate(mail, kwRegex) {
  if (!mail) return false;
  if (isNoise(mail.from, mail.subject)) return false;
  if (!kwRegex) return true; // 无关键词配置时不排除（保守放行，交 AI 判定）
  // 正文只在预筛阶段截前段参与匹配，避免超长正文拖慢正则
  const hay = `${mail.subject || ''} ${mail.textBody || ''}`.slice(0, 8000);
  return kwRegex.test(hay);
}

module.exports = { isNoise, isCandidate };
