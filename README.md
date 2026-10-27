# dsh-web-tool-provider

DeepSeek Harness 的 `web_search` / `web_fetch` 与 **Tavily / Exa / Firecrawl** 之间的**归一化中间层**。

```text
web_search ─┐                          ┌─ tavily
            ├─ ctx.web 统一契约 ───────┤
web_fetch  ─┘   （本插件负责转换）        └─ exa / firecrawl
```

- **输入归一**：通用层只有域名白/黑名单；每次查询固定 5 条；其余厂商参数（深度、主题、格式、地区……）全部由插件内部的默认值决定，界面不暴露。
- **输出归一**：一个 source 形状、一种日期格式、一套错误码；厂商的 `author`/`warnings`/`failed_results` 都折进同一处。
- **不向厂商索要答案或逐条正文**：Tavily 的 `include_answer` 与 Exa 的 `contents.highlights` 都关闭，`content` 只承载降级 notice，正文一律走 `web_fetch`。
- **失败自动回退**：主后端限流/额度/超时/5xx/连不上时，按配置的链换下一家重试；被限流的后端进入冷却，在此期间不会被再次请求。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
```

## 设置页

**Settings → Plugins → 网页工具后端**，一页两块：

```text
┌ 后端选择 ─────────────────────────────────────┐
│ web_search  [Tavily│Exa│Firecrawl]            │
│   自动回退  (Exa) (Firecrawl)  顺序: tavily → exa│
│ web_fetch   [Tavily│Exa│Firecrawl]            │
│   自动回退  (Exa) (Firecrawl)  顺序: firecrawl → exa│
│   冷却中: Exa 45s (WEB_PROVIDER_RATE_LIMITED)  │
├ API 密钥 ─────────────────────────────────────┤
│ ● Tavily    已配置 · 来自环境变量   编辑  清除   │
│ ● Exa       未配置  [____粘贴密钥____]  保存    │
│ ● Firecrawl 已配置 · 已配置       剩余 42,000  │
└───────────────────────────────────────────────┘
```

后端是分段选择，**改动即存**；回退顺序用标签点选（点一下加入链尾，再点一下移出）。密钥显式保存（避免输一半就被写进凭据库）：已配置的行隐藏输入框，点「编辑」才展开，同时在输入框位置显示剩余额度。

界面控件用 `@deepseek-ai/dsh-client-ui-primitives`，颜色全部走 `--dsw-alias-*` 设计令牌，与 DSH 自带页面同一套组件；任一导出缺失时自动退回原生控件，不会白屏。

额度查询直连厂商接口（不经 `ctx.web`、不经工具层）：

| 厂商 | 接口 | 剩余额度 |
|---|---|---|
| Tavily | `GET /usage` | `account.plan_limit - plan_usage`（`limit` 为 `null` 表示不限） |
| Firecrawl | `GET /v2/team/credit-usage` | 直接给 `remainingCredits` |
| Exa | — | 无余额接口（要 service key + 团队开通，且只给美元消费额），页面显示「无额度接口」 |

密钥解析顺序：插件配置里的字面量 → 凭据库 → 环境变量（`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`），每次调用重新解析。**字面量密钥不会被写进状态文件。**

## 配置（YAML，可选）

界面只动后端与通用选项；下面的字段只从 profile 的 `cordis.patch.yml` 读取，作为**首次运行的默认值**：

| 层 | 字段 |
|---|---|
| `search` | `backend`、`fallbackOrder`、`includeDomains`、`excludeDomains` |
| `fetch` | `backend`、`fallbackOrder`、`fallbackToHttp` |
| `fallback` | `budgetMs`（一次工具调用走完整条链的总预算，默认 60000） |
| `providers.tavily` | `baseURL`、`timeoutMs`、`maxChars`、`topic`、`searchDepth`、`apiKey`、`apiKeyEnv` |
| `providers.exa` | `baseURL`、`timeoutMs`、`maxChars`、`searchType`、`apiKey`、`apiKeyEnv` |
| `providers.firecrawl` | `baseURL`、`timeoutMs`、`maxChars`、`version`、`mainContent`、`maxAge`、`apiKey`、`apiKeyEnv` |

YAML 里的写法就是 Config 的键名：`searchFallbackOrder: [exa, tavily]`、`fetchFallbackOrder: [tavily]`、`fallbackBudgetMs: 45000`。

后端与通用选项存在插件自管状态文件（`<profile>/.web-tool-provider/state.json`，回退 `$DSH_HOME`、`~/.dsh`）；状态文件优先于 Config。

## 失败自动回退

链 = `当前后端` + `回退顺序`（去重、只认已知厂商）。逐跳规则：

| 厂商返回 | 错误码 | 处理 |
|---|---|---|
| 429 | `WEB_PROVIDER_RATE_LIMITED` | 冷却 60s，换下一家 |
| 401 / 403 | `WEB_PROVIDER_UNAUTHORIZED` | 冷却 10 分钟，换下一家（改了密钥立即解除） |
| 402 / 额度 | `WEB_PROVIDER_QUOTA_EXCEEDED` | 冷却 10 分钟，换下一家 |
| 5xx | `WEB_PROVIDER_UPSTREAM` | 冷却 30s，换下一家 |
| 超时 / 连不上 | `WEB_FETCH_TIMEOUT` / `WEB_PROVIDER_UNREACHABLE` | 冷却 30s，换下一家 |
| 空结果 / 没配密钥 | `WEB_PROVIDER_EMPTY` / `_CREDENTIAL_MISSING` | 换下一家（不冷却） |
| 400 / 422 | `WEB_PROVIDER_BAD_REQUEST` | **不换**，直接报错（参数错了换谁都没用） |
| 非法 URL / 被拦地址 / 重定向越界 / 不支持的类型 | `WEB_INVALID_URL` 等 | **不换**，直接报错 |
| 用户 abort | `WEB_ABORTED` | **立即停止**整条链 |

- 冷却按 `(能力, 厂商)` 分开记：搜索被限流不影响抓取，反之亦然。
- 整条链共享一个 `budgetMs` 预算：前一家慢掉 50 秒，下一家只剩 10 秒，不会 3 家各等 60 秒。
- 换过家之后结果里会附一行 notice：`> provider notice: fell back to exa after tavily WEB_PROVIDER_RATE_LIMITED`；被跳过时也会说明 `tavily is cooling down for 43s after ...`。
- 全链都在冷却 → 直接报 `every search backend is cooling down: tavily 43s (...), exa 12s (...)`，不再发请求。
- 抓取端仍然保留最后一层本地降级：整条链都失败且 `fallbackToHttp` 打开时，走本地 HTTP 抓取并附 notice。

## 输出契约

```ts
SearchResult = { content?: string; sources: { url; title?; snippet?; publishedAt? }[]; truncated: boolean }
FetchResult  = { url: string; statusCode: number; body: { kind: 'text' | 'html'; content: string }; truncated: boolean }
```

- `snippet` 单行、≤400 字；`author` 以 ` · 作者` 附在末尾。
- `publishedAt` 一律 `YYYY-MM-DD`；Tavily 需显式请求 `include_published_date` 才有，Firecrawl 只有少数结果带。
- **Exa 没有 snippet**：不请求 `contents` 之后，它的结果只剩链接、标题和日期。
- `content` 只装降级 notice（我们不向厂商要答案）；抓取降级也会附 `> provider notice: fell back ...`。
- 错误码：`WEB_PROVIDER_UNAUTHORIZED` / `_QUOTA_EXCEEDED` / `_RATE_LIMITED` / `_BAD_REQUEST` / `_UPSTREAM` / `_UNREACHABLE` / `_EMPTY` / `_CREDENTIAL_MISSING`、`WEB_ABORTED`、`WEB_INVALID_URL`、`WEB_BLOCKED_URL`。

## 各后端的实际请求参数

| | 搜索 | 抓取 |
|---|---|---|
| Tavily | `max_results=5`、`search_depth`(basic)、`topic`(general)、`include_published_date` | `/extract` |
| Exa | `numResults=5`、`type`(auto)，**无 contents** | `/contents`（`text: true`） |
| Firecrawl | `limit=5`、`sources=['web']` | `/v2/scrape`（markdown、onlyMainContent、48h 缓存） |

这些都能在 YAML 里覆盖，见上一节。

## 行为

- **`web_search` 多 query = 多次厂商调用**（工具层并发 fan-out 后合并）。
- **抓取结果一律 `text`**：三家给的都是 markdown/文本，标成 `html` 会让工具层再转一遍。
- **抓取降级**：整条链报错/额度/无密钥/空正文/超时 → 本地抓取并附带 notice；目标页 4xx 是结果不降级；abort 不降级。
- **搜索**：主后端失败按链换人；链上都没配密钥才报 `WEB_PROVIDER_CREDENTIAL_MISSING`。

本地抓取只做协议白名单、明文内网/回环地址拦截、逐跳重定向校验与字节上限，**没有**官方 `dsh-web-fetch-http` 的 DNS 解析+公网校验+连接钉扎。要那层保护就关掉 `fallbackToHttp`。

## 开发

- `index.js`：两层设置 + 归一化层 + 回退链（分类/冷却/预算）+ 两个 provider + 两条 Host 路由，零第三方依赖。
- `client.js`：设置页（分段选择 + 回退标签 + 三家密钥），控件用 DSH UI primitives 并带原生兜底。
- `node test/smoke.mjs`：25 项离线测试。
- `node scripts/check-keys.mjs`：检查 `client.js` 里用到的文案 key 都在词典里。

> 改完代码需要**重启一次** Harness 才会加载新的 host 实现；设置页刷新页面即可。

## License

MIT
