'use strict';
// ============================================================================
// config.js — 唯一配置入口：读 env（由 workflow 从 Secrets / dispatch 输入注入）
// 不变量③：密钥只从环境变量读，永不写盘、永不进 Gist 建议文件、永不进浏览器。
// ============================================================================

// 单一事实源提醒：STAGE_PRESETS 必须与网页端 autumn-recruitment-tracker/index.html
// 的 STAGE_PRESETS 完全一致（14 项、同序）。AI 只能从中选 stage，选不出留空。
const STAGE_PRESETS = ['待投递', '已投递', '测评', '笔试', '机试', '一面', '二面', '三面', '四面', '五面', '交叉面', 'HR面', 'Offer', '已结束'];

// 建议文件名：Action 只 PATCH 这一个文件，永不读写 vault-*.json（不变量①⑥）
const MAIL_SUGGEST_FILENAME = 'mail-suggestions.json';
// 配置文件名：网页端写、Action 端读（明文，绝不含任何密钥）；用于网页可调项下发
const MAIL_CONFIG_FILENAME = 'mail-config.json';

// 邮件类型枚举（AI 归一后的取值域）
const EMAIL_TYPES = ['测评', '笔试', '机试', '面试邀请', 'Offer', '拒信', '其它'];

// 预筛关键词默认值（可用 KEYWORDS Secret/env 覆盖，用 | 分隔）
// 已收紧：移除过于宽泛、易命中营销/理财邮件的 评估|offer|assessment；补充校招强相关词。
// 说明：银行/理财营销常含「限時 offer / 風險評估 / assessment」而漏进；去掉这几个后，
//       真正的招聘邮件仍会被 面试/笔试/录用/招聘/校招/应聘/网申/入职/简历/interview 命中。
const DEFAULT_KEYWORDS = '面试|笔试|机试|测评|录用|应聘|招聘|校招|网申|入职|简历|interview';

// 发件人/主题噪声排除（营销、退订、系统信使等），命中即丢弃，不进 AI
const NOISE_PATTERN = 'unsubscribe|退订|newsletter|no-?reply|donotreply|do-not-reply|营销|推广|广告|postmaster|mailer-daemon|noreply|通知中心|服务通知';

function strEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const s = String(raw).trim();
  return s === '' ? fallback : s;
}

function intEnv(name, fallback) {
  const n = Number.parseInt(strEnv(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatEnv(name, fallback) {
  const n = Number.parseFloat(strEnv(name, ''));
  return Number.isFinite(n) ? n : fallback;
}

// 组装运行时配置（冻结，防误改）。所有默认值严格按计划文件。
function buildConfig() {
  return Object.freeze({
    imap: Object.freeze({
      host: strEnv('IMAP_HOST', 'imap.qq.com'),
      port: intEnv('IMAP_PORT', 993),
      user: strEnv('QQ_EMAIL', ''),
      pass: strEnv('QQ_AUTHCODE', ''),
      // clientInfo 触发 imapflow 在 connect() 时发送 RFC2971 ID 命令，破 QQ 'Unsafe Login'
      clientInfo: Object.freeze({ name: 'autumn-mail-sync', version: '0.1.0', vendor: 'personal' })
    }),
    sinceDays: intEnv('SINCE_DAYS', 30),
    maxPerRun: intEnv('MAX_PER_RUN', 30),
    minConfidence: floatEnv('MIN_CONFIDENCE', 0.3),
    keywords: strEnv('KEYWORDS', DEFAULT_KEYWORDS),
    ai: Object.freeze({
      // 换百炼：AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 AI_MODEL=qwen-plus
      baseUrl: strEnv('AI_BASE_URL', 'https://api.deepseek.com'),
      apiKey: strEnv('AI_API_KEY', ''),
      model: strEnv('AI_MODEL', 'deepseek-chat')
    }),
    gist: Object.freeze({
      id: strEnv('GIST_ID', ''),
      token: strEnv('GIST_PAT', ''),
      apiBase: strEnv('GIST_API', 'https://api.github.com'),
      filename: MAIL_SUGGEST_FILENAME
    }),
    // 邮件建议加密密钥（可选）：设了则 mail-suggestions.json 加密存储；留空则明文（向后兼容）
    mailEncKey: strEnv('MAIL_ENC_KEY', ''),
    // 以下三项默认值，可被 Gist 里的 mail-config.json 覆盖（见 applyMailConfigOverrides）
    enabled: true,
    minIntervalHours: 0,
    promptExtra: ''
  });
}

// 用网页端写入 Gist 的 mail-config.json 覆盖可调项（非密钥）。缺省/非法值回落到 cfg 原值。
// 只覆盖：keywords / minConfidence / sinceDays / maxPerRun / enabled / minIntervalHours / promptExtra。
function applyMailConfigOverrides(cfg, mailConfig) {
  const mc = mailConfig && typeof mailConfig === 'object' ? mailConfig : {};
  const num = (v, fb) => (String(v == null ? '' : v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fb);
  const str = (v, fb, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 4000) : fb);
  return Object.freeze({
    ...cfg,
    keywords: str(mc.keywords, cfg.keywords, 2000),
    minConfidence: num(mc.minConfidence, cfg.minConfidence),
    sinceDays: num(mc.sinceDays, cfg.sinceDays),
    maxPerRun: num(mc.maxPerRun, cfg.maxPerRun),
    enabled: mc.enabled === false ? false : true, // 仅显式 false 才禁用
    minIntervalHours: Math.max(0, num(mc.minIntervalHours, cfg.minIntervalHours)),
    promptExtra: str(mc.promptExtra, cfg.promptExtra, 2000)
  });
}

// 运行门禁（纯函数）：返回跳过原因字符串或 null（继续）。跳过发生在 IMAP/AI 之前 → 0 token。
function gateReason(cfg, prevMeta) {
  if (cfg && cfg.enabled === false) return 'mail-config.json 中 enabled=false（网页端已关闭邮件同步）';
  const hours = Number(cfg && cfg.minIntervalHours) || 0;
  if (hours > 0 && prevMeta && prevMeta.lastRunAt) {
    const last = Date.parse(prevMeta.lastRunAt);
    if (Number.isFinite(last) && (Date.now() - last) < hours * 3600e3) {
      return `距上次运行不足 ${hours} 小时（minIntervalHours=${hours}）`;
    }
  }
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 由 KEYWORDS 字符串（| 分隔）构建大小写不敏感正则
function keywordRegex(keywords) {
  const parts = String(keywords || DEFAULT_KEYWORDS).split('|').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(parts.map(escapeRegExp).join('|'), 'i');
}

function noiseRegex() {
  return new RegExp(NOISE_PATTERN, 'i');
}

module.exports = {
  STAGE_PRESETS,
  EMAIL_TYPES,
  MAIL_SUGGEST_FILENAME,
  MAIL_CONFIG_FILENAME,
  DEFAULT_KEYWORDS,
  NOISE_PATTERN,
  buildConfig,
  applyMailConfigOverrides,
  gateReason,
  keywordRegex,
  noiseRegex,
  escapeRegExp
};
