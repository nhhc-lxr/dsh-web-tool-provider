# dsh-web-tool-provider

DeepSeek Harness 的 `web_search` / `web_fetch` 与 **Tavily / Exa / Firecrawl** 之间的归一化中间层。

```text
web_search ─┐                          ┌─ tavily
            ├─ ctx.web 统一契约 ───────┤
web_fetch  ─┘   （本插件负责转换）        └─ exa / firecrawl
```

- **输入归一**：通用层只有域名白/黑名单，每次查询固定 5 条；厂商细节参数由插件内部默认值决定。
- **输出归一**：一个 source 形状、一种日期格式、一套错误码；厂商的 `author`/`warnings` 折进同一处。
- **不向厂商索要答案或逐条正文**：正文一律走 `web_fetch`。
- **失败自动回退**：主后端限流/额度/超时/5xx/连不上时按链换下一家，出问题的后端进入冷却。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
```

## 插件页配置

侧栏 **插件 → 已安装插件 → dsh-web-tool-provider**，配置渲染在详情页的描述与行列表之间（`plugins.bundle.config`）：

- **后端选择**：`web_search` / `web_fetch` 各一个分段选择，改动即存；回退顺序用标签点选（点一下加入链尾，再点一下移出）。
- **API 密钥**：已配置的行隐藏输入框，点「编辑」才展开并显示剩余额度；显式保存，避免输一半就写进文档。
- 冷却中的后端在页面上直接显示剩余秒数与错误码。

宿主层面这一行导出了 `Config`，其中 15 个可编辑字段带 `volatile()`（3 个密钥同时声明 `role('secret')`），所以 `settings/describe` 会给出 `web-tool-provider` 这个 namespace：**dsh-go 手机端在同一个插件详情页里能画出一套原生表单**，字段说明是中文，密钥显示为「已配置/未配置」的 secret 行。网页端和手机端写的是同一份 profile 文档。

控件用 `@deepseek-ai/dsh-client-ui-primitives`，颜色走 `--dsw-alias-*` 令牌；任一导出缺失时退回原生控件，不会白屏。

密钥解析顺序：插件配置里的字面量 → 凭据库 → 环境变量（`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`），每次调用重新解析。表单填的密钥落在 profile 文档的 `tavilyApiKey` 等字段（明文 YAML，仅本机），凭据库与环境变量仍然可用。

额度查询直连厂商接口：Tavily `GET /usage`（`plan_limit - plan_usage`）、Firecrawl `GET /v2/team/credit-usage`（`remainingCredits`）、Exa 无余额接口。

## 配置（YAML，可选）

网页端设置页只动后端与密钥；dsh-go 表单能改全部 15 个带 `volatile()` 的字段。其余字段从 profile 的 `cordis.patch.yml` 读作首次运行的默认值：

| 层 | 字段 |
|---|---|
| `search` | `searchBackend`、`searchFallbackOrder`、`includeDomains`、`excludeDomains` |
| `fetch` | `fetchBackend`、`fetchFallbackOrder`、`fallbackToHttp` |
| `fallback` | `budgetMs`、`timeoutMs`、`maxChars`、`maxBytes`、`maxRedirects`、`userAgent` |
| `providers.<vendor>` | `baseURL`、`timeoutMs`、`maxChars`、`apiKey`、`apiKeyEnv`，以及各家的 `topic`/`searchDepth`/`searchType`/`version`/`mainContent`/`maxAge` |

YAML 键名就是 Config 的字段名（`searchFallbackOrder: [exa, tavily]`、`fallbackBudgetMs: 45000`）。

**设置的唯一事实来源是 profile 文档**：表单、`POST /web-tool-provider/state` 都通过宿主 settings 服务写回 `cordis.patch.yml`。旧版插件自管的 `state.json` 只在首次启动、且这一行还没有用户值时被导入一次，之后不再读写。

## 失败自动回退

链 = `当前后端` + `回退顺序`（去重、只认已知厂商）。

| 厂商返回 | 处理 |
|---|---|
| 429 / 401 / 402 / 5xx / 超时 / 连不上 / 空结果 / 没配密钥 | 换下一家；前四类进入冷却（60s / 10min / 10min / 30s） |
| 400 / 422、非法 URL、被拦地址、重定向越界、不支持的类型 | 不换，直接报错 |
| 用户 abort | 立即停止整条链 |

- 冷却按 `(能力, 厂商)` 分开记：搜索被限流不影响抓取。
- 整条链共享一个 `budgetMs` 预算，不会每家各等一次超时。
- 换家后结果里附一行 `> provider notice: fell back to exa after tavily WEB_PROVIDER_RATE_LIMITED`。
- 抓取端最后一层降级是本地 HTTP（`fallbackToHttp` 打开时），并附带 notice。

## 输出契约

```ts
SearchResult = { content?: string; sources: { url; title?; snippet?; publishedAt? }[]; truncated: boolean }
FetchResult  = { url: string; statusCode: number; body: { kind: 'text' | 'html'; content: string }; truncated: boolean }
```

`snippet` 单行、≤400 字；`publishedAt` 一律 `YYYY-MM-DD`；`content` 只装降级 notice。抓取结果一律标 `text`。

## 开发

- `index.js`：Config schema + 两层设置 + 归一化 + 回退链 + 两个 provider + 两条 Host 路由。
- `client.js`：插件页配置，注册为 `plugins.bundle.config`。
- `node test/smoke.mjs`：33 项离线测试，守住插件页注册契约（slot 名、`key` 等于包名、`view` 分流）与配置表单契约（volatile 字段清单、密钥标 secret、只写 volatile 路径、settings 路径写回、无 settings 服务时回落 state 文件）。
- `node scripts/check-keys.mjs`：检查 `client.js` 里的文案 key 都在词典里。

改完宿主代码（`index.js`）需要**重启一次** Harness；只改 `client.js` 刷新页面即可。

## License

MIT
