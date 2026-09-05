# autumn-mail-sync

把 QQ 邮箱里的招聘邮件（面试 / 笔试 / 测评 / Offer / 拒信）自动解析成**结构化建议**，写进你自己的私有 Gist 文件 `mail-suggestions.json`。网页端 **[秋招投递管理](../autumn-recruitment-tracker)** 在云同步时顺带读取它，在新增的「邮件提醒」视图里**逐字段人工复核**后并入投递台账。

> 本仓库必须建成 **私有仓库**：QQ 授权码、AI Key、Gist PAT 都放在这里的 Secrets，**永不进浏览器、永不进网页 localStorage、永不进 vault**。

## 架构（A2）

```
定时/手动 GitHub Action（本私有仓库）
  → IMAP 增量拉 QQ 邮箱（imap.qq.com:993 TLS + RFC2971 ID 命令破 "Unsafe Login"）
  → 关键词预筛（降噪、省 token）
  → AI（DeepSeek / OpenAI 兼容）判定归属 + 阶段 + 细节
  → 只 PATCH 用户现有私有 Gist 的独立文件 mail-suggestions.json（永不读写 vault）
网页端 syncNow 顺带读取该文件
  → 第 5 视图「邮件提醒」#/mail
  → 用本地台账模糊匹配（公司名归一化 + Dice 相似度）
  → 人工逐字段勾选复核
  → setTimeline / saveRecords 落库（触发快照 + 云同步）
```

**不变量**：① 一切更新经人工复核，无免复核自动写入；② AI 不编造，阶段仅限 14 个 `STAGE_PRESETS`；③ 密钥只在私有仓库 Secrets；④ Action 与网页按文件分别 PATCH 同一 Gist，互不覆盖；⑤ 授权码失效等失败写进 `meta.lastError` 并在网页上屏提示。

## 你需要做的 M0 步骤（人工闸门，Agent 无法代做）

M0 目的：在投入真实联调前，验证最脆弱的假设——**QQ 授权码能否从 GitHub-hosted runner（境外 Azure IP）经 IMAP 登录成功**。

1. **建私有仓库**：在 GitHub 新建 **private** 仓库 `autumn-mail-sync`，把本目录代码推上去（`git init && git remote add origin … && git push`，由你手动执行）。
2. **QQ 邮箱开启 IMAP 并生成授权码**：
   - 登录 QQ 邮箱网页版 → 设置 → 账户 → 开启「IMAP/SMTP 服务」；
   - 按提示用手机发短信验证，得到一个 **16 位授权码**（不是 QQ 密码）；
   - ⚠️ 改 QQ 密码后授权码会失效，需重新生成。
3. **准备 AI Key**：一个 DeepSeek（`https://platform.deepseek.com`）或阿里百炼（DashScope 兼容模式）的 API Key。
4. **拿到现有同步 Gist 的 GIST_ID**：网页端「工具 → 云同步」里能看到，或从 Gist URL `https://gist.github.com/<user>/<GIST_ID>` 取。必须与网页端用的是**同一个** Gist。
5. **准备一个 gist 权限的 PAT**：GitHub → Settings → Developer settings → Personal access tokens → 勾选 **gist**。
6. **在本私有仓库配置 Secrets**（Settings → Secrets and variables → Actions → New repository secret）：

   | Secret | 说明 | 示例 |
   |---|---|---|
   | `QQ_EMAIL` | QQ 邮箱地址 | `123456789@qq.com` |
   | `QQ_AUTHCODE` | 16 位 IMAP 授权码 | `abcdefghijklmnop` |
   | `AI_BASE_URL` | OpenAI 兼容基址 | `https://api.deepseek.com` |
   | `AI_API_KEY` | AI 密钥 | `sk-…` |
   | `AI_MODEL` | 模型名 | `deepseek-chat`（百炼填 `qwen-plus`） |
   | `GIST_ID` | 现有同步 Gist 的 ID | `a1b2c3…` |
   | `GIST_PAT` | 有 gist 权限的 PAT | `ghp_…` |

   > 换百炼：`AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`AI_MODEL=qwen-plus`。
   > 不配 `AI_API_KEY` 也能跑（M1 占位启发式：粗提取公司、不判阶段、confidence=0），配了才启用 M2 真实 AI 分析。

7. **手动跑连通性验证**：Actions → `connectivity-test` → Run workflow（`workflow_dispatch`）。
   - ✅ 日志出现「登录成功 + INBOX 邮件数 + 最近 3 封主题」→ **闸门通过**，可手动跑 `mail-sync` 进入真实联调。
   - ❌ 报 `Unsafe Login` / 异地登录 / 验证失败 → **闸门不通过**，见下方「M0 失败怎么办」。

## M0 失败怎么办（QQ 风控挡住境外 IP）

脚本**宿主无关**，登录被挡时可整体搬到国内宿主，代码几乎不用改：

- **自建 runner**：给本仓库挂一台国内机器作 self-hosted runner，workflow 里 `runs-on: self-hosted`。
- **阿里云函数计算 / 腾讯云 SCF**：把 `index.js` 的 `run()` 包成定时函数入口，用同样的 env 注入密钥。
- **国内 VPS + cron**：`npm i` 后 `crontab` 每小时 `node index.js`。
- 或**退回 B 手动导入**方案（不用本仓库）。

## 用法

```bash
npm install                 # 安装 imapflow + mailparser
node src/connectivity-test.js   # M0 连通性（需 QQ_EMAIL/QQ_AUTHCODE）
node index.js               # 跑一轮同步（需全部 Secrets）
node index.js --report-error    # 兜底：把 meta 标记为 error（workflow failure() 调用）
npm run check               # node --check 全部脚本
npm test                    # 纯函数单测（不触网、不依赖 IMAP/AI）
```

- **定时**：`mail-sync.yml` 用 `cron: '23 * * * *'`（每小时第 23 分）。招聘高峰可收紧到每 30 分钟（风控与实时性权衡）。
- **手动**：`workflow_dispatch` 可传 `SINCE_DAYS` / `MAX_PER_RUN` 覆盖默认值。
- **保活**：GitHub Actions 对 **60 天无活动**的仓库会**停用定时 workflow**，需偶尔手动 dispatch 一次保活。

## 建议文件契约 `mail-suggestions.json`

```jsonc
{
  "meta": {
    "version": 1, "lastRunAt": "ISO", "lastStatus": "ok|error", "lastError": "",
    "lastUidValidity": 0, "lastUid": 0, "newCount": 0, "pendingCount": 0
  },
  "suggestions": [{
    "id": "uid-<sourceUid>", "sourceUid": 0, "receivedAt": "ISO", "from": "", "subject": "",
    "emailType": "测评|笔试|机试|面试邀请|Offer|拒信|其它",
    "company": "", "position": "", "stage": "(STAGE_PRESETS 之一或空)",
    "scheduleAt": "YYYY-MM-DDTHH:mm|空", "location": "", "round": "",
    "summary": "(≤60)", "confidence": 0,
    "proposed": {
      "milestone": { "stage": "", "at": "YYYY-MM-DD", "note": "邮件·<类型>" },
      "scheduleAt": "", "recentSchedule": "", "nextAction": ""
    }
  }]
}
```

- **增量**：`meta.lastUidValidity/lastUid` 是高水位；`UIDVALIDITY` 变化则回退到 `SINCE_DAYS` 全量重扫并重置水位。
- **去重**：按 `sourceUid` 合并，`id` 稳定为 `uid-<sourceUid>`，网页端的「已应用/已忽略」按 id 记忆，建议被重新分析也不会复活。
- **prune**：只保留近 30 天、最多 100 条。

## 默认值（可调）

`SINCE_DAYS=30`、`MAX_PER_RUN=30`、`MIN_CONFIDENCE=0.3`、`IMAP_HOST=imap.qq.com`、`IMAP_PORT=993`、`KEYWORDS=面试|笔试|机试|测评|评估|offer|录用|应聘|招聘|简历|网申|入职|interview|assessment`。低于 `MIN_CONFIDENCE` 的建议直接丢弃；`0.3~0.6` 之间的仍进队列但网页端标黄（你要人工复核）。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `Unsafe Login` | QQ 风控。已发 ID 命令仍被挡 → 转国内宿主（见上）。 |
| 网页「邮件提醒」显示授权码可能失效 | 改了 QQ 密码 → 重新生成 16 位授权码，更新 `QQ_AUTHCODE` Secret。 |
| `GIST_ID 不存在` / 401 | `GIST_PAT` 无 gist 权限或过期；`GIST_ID` 与网页端不是同一个 Gist。 |
| AI HTTP 4xx/超额 | 检查 `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL`；软失败会写进 `meta.lastError` 上屏，不影响已抓取。 |
| 定时不触发 | 仓库 60 天无活动被停用；手动 dispatch 保活，或检查 Actions 是否被禁用。 |

## 隐私

- 邮件正文只发往**你自己配置**的 AI 端点（`AI_BASE_URL`）用于解析；建议结果明文存于**你的私有 Gist**（不加密，避免把同步口令放进 CI）。
- 本仓库永不读取或写入网页端的 vault 文件；两者按文件分别 PATCH 同一 Gist，互不覆盖。
