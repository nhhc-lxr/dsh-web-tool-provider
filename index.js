/**
 * dsh-web-tool-provider — the normalization layer between the Harness web seam
 * and three vendor APIs.
 *
 *   web_search -> ctx.web.search() -> [ shared search options ] -> tavily | exa | firecrawl
 *   web_fetch  -> ctx.web.fetch()  -> [ shared fetch options  ] -> tavily | exa | firecrawl
 *
 * Settings are layered, matching the settings page:
 *
 *   search.backend / search.options   shared by every search backend
 *   fetch.backend  / fetch.options    shared by every fetch backend
 *   providers.<vendor>                per-provider connection and behaviour
 *
 * Normalization happens here and nowhere else: one source shape, one document
 * shape, one date format, one error taxonomy, and vendor warnings folded into
 * the answer as `> provider notice: ...` so the model learns about degradation.
 *
 * Routes:
 *   GET  /web-tool-provider/state  -> layered settings, capabilities, key state
 *   POST /web-tool-provider/state  -> edit any layer, store or clear a key
 *
 * Keys persist in `ctx.credentials`. Settings persist in the profile document
 * through the host settings service: `Config` below declares which fields a
 * form may edit (the Plugins page here, the native plugin sheet in dsh-go), and
 * the pre-settings state file is only read once, to import values saved before
 * this row became a form.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

const PLUGIN = 'web-tool-provider'
const PACKAGE = 'dsh-web-tool-provider'
/** Carried by every cosmokit volatile reference; Config output is full of them. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const ROUTE = '/web-tool-provider/state'
const CREDITS_ROUTE = '/web-tool-provider/credits'
const PROVIDER_ID = 'web-tool'
const VENDORS = ['tavily', 'exa', 'firecrawl']
const CREDENTIAL_REF = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}
const MAX_TIMER_MS = 2147483647
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const BODY_LIMIT_BYTES = 64 * 1024
const SNIPPET_CHARS = 400
/** Results asked of every backend, per query. Fixed on purpose: no setting. */
const RESULTS_PER_QUERY = 5

/**
 * Which failures are worth another vendor's time. A bad request or a blocked
 * URL fails the same way everywhere, so replaying it only burns quota; a rate
 * limit or an outage is exactly what a fallback is for.
 */
const RETRYABLE_CODES = new Set([
  'WEB_PROVIDER_RATE_LIMITED',
  'WEB_PROVIDER_QUOTA_EXCEEDED',
  'WEB_PROVIDER_UNAUTHORIZED',
  'WEB_PROVIDER_UPSTREAM',
  'WEB_PROVIDER_UNREACHABLE',
  'WEB_PROVIDER_EMPTY',
  'WEB_PROVIDER_CREDENTIAL_MISSING',
  'WEB_FETCH_TIMEOUT',
])
const NON_RETRYABLE_CODES = new Set([
  'WEB_PROVIDER_BAD_REQUEST',
  'WEB_INVALID_URL',
  'WEB_BLOCKED_URL',
  'WEB_REDIRECT_BLOCKED',
  'WEB_UNSUPPORTED_CONTENT_TYPE',
])
const TERMINAL_CODES = new Set(['WEB_ABORTED'])

/** How long a vendor sits out after each kind of failure. Zero = no rest. */
const COOLDOWN_MS = {
  WEB_PROVIDER_RATE_LIMITED: 60_000,
  WEB_PROVIDER_QUOTA_EXCEEDED: 10 * 60_000,
  WEB_PROVIDER_UNAUTHORIZED: 10 * 60_000,
  WEB_PROVIDER_UPSTREAM: 30_000,
  WEB_PROVIDER_UNREACHABLE: 30_000,
  WEB_FETCH_TIMEOUT: 30_000,
}

export const name = PLUGIN
export const inject = ['web', 'webServer']

/* ------------------------------------------------------------------ config -- */

/** One vendor id as a schema leaf, so every enum field validates the same list. */
const vendorField = Schema.union(VENDORS.map((id) => Schema.const(id)))

/**
 * The profile row's Config. Fields are flat camelCase because that is what the
 * profile patch has always carried; the settings service renders exactly the
 * `volatile()` ones as a form, and `autoGenerate` stays on so the dsh-go plugin
 * sheet can draw those same fields natively.
 *
 * Descriptions are Chinese on purpose: the settings service copies them into
 * the form schema, and that label is what both the desktop page and the phone
 * sheet show. Keys are `role('secret')`, so `describe({redactSecrets:true})`
 * removes them before they leave this process while `secrets` still reports
 * whether each one is set.
 */
export const Config = Schema.object({
  searchBackend: vendorField.description('搜索优先使用的后端').default('tavily').volatile(),
  searchFallbackOrder: Schema.array(vendorField).description('搜索后端失败后依次尝试').default([]).volatile(),
  fetchBackend: vendorField.description('抓取优先使用的后端').default('firecrawl').volatile(),
  fetchFallbackOrder: Schema.array(vendorField).description('抓取后端失败后依次尝试').default([]).volatile(),
  includeDomains: Schema.array(Schema.string()).description('只搜这些域名，留空不限').default([]).volatile(),
  excludeDomains: Schema.array(Schema.string()).description('排除这些域名').default([]).volatile(),
  fallbackToHttp: Schema.boolean().description('厂商失败后用普通 HTTP 兜底').default(true).volatile(),
  fallbackBudgetMs: Schema.number().description('一次调用在整条链上的总预算（毫秒）').default(60000).volatile(),
  fallbackTimeoutMs: Schema.number().description('单次抓取超时（毫秒）').default(20000).volatile(),
  fallbackMaxChars: Schema.number().description('单页保留的最大字符数').default(100000).volatile(),
  fallbackMaxBytes: Schema.number().description('单页读取的最大字节数').default(5000000).volatile(),
  fallbackMaxRedirects: Schema.number().description('普通 HTTP 最多跟随的重定向次数').default(5).volatile(),
  fallbackUserAgent: Schema.string().description('普通 HTTP 使用的 User-Agent').default(`${PLUGIN}/0.4.0`),

  tavilyBaseURL: Schema.string().default('https://api.tavily.com'),
  tavilyTimeoutMs: Schema.number().default(20000),
  tavilyMaxChars: Schema.number().default(100000),
  tavilyApiKey: Schema.string().description('Tavily API 密钥').role('secret').volatile(),
  tavilyApiKeyEnv: Schema.string().default(CREDENTIAL_REF.tavily),
  tavilyTopic: Schema.union(['general', 'news', 'finance'].map((id) => Schema.const(id))).default('general'),
  tavilySearchDepth: Schema.union(['basic', 'fast', 'advanced'].map((id) => Schema.const(id))).default('basic'),

  exaBaseURL: Schema.string().default('https://api.exa.ai'),
  exaTimeoutMs: Schema.number().default(20000),
  exaMaxChars: Schema.number().default(100000),
  exaApiKey: Schema.string().description('Exa API 密钥').role('secret').volatile(),
  exaApiKeyEnv: Schema.string().default(CREDENTIAL_REF.exa),
  exaSearchType: Schema.union(['auto', 'lite', 'deep'].map((id) => Schema.const(id))).default('auto'),

  firecrawlBaseURL: Schema.string().default('https://api.firecrawl.dev'),
  firecrawlTimeoutMs: Schema.number().default(30000),
  firecrawlMaxChars: Schema.number().default(100000),
  firecrawlApiKey: Schema.string().description('Firecrawl API 密钥').role('secret').volatile(),
  firecrawlApiKeyEnv: Schema.string().default(CREDENTIAL_REF.firecrawl),
  firecrawlApiVersion: Schema.union(['v1', 'v2'].map((id) => Schema.const(id))).default('v2'),
  firecrawlMainContent: Schema.boolean().default(true),
  firecrawlMaxAge: Schema.number().default(172800000),
})

/* ------------------------------------------------------------------ errors -- */

class ProviderError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

const providerError = (message, code) => new ProviderError(message, code)

const clip = (value, limit) => {
  const string = String(value ?? '')
  return string.length > limit ? `${string.slice(0, limit)}…` : string
}

/** HTTP status and transport failures become the same codes for every vendor. */
function classifyFailure(vendor, status, bodyText) {
  const detail = clip(String(bodyText ?? '').replace(/\s+/g, ' '), 240)
  const tail = detail === '' ? '' : ` — ${detail}`
  if (status === 401 || status === 403) {
    return providerError(`${vendor} rejected the API key (HTTP ${status})${tail}`, 'WEB_PROVIDER_UNAUTHORIZED')
  }
  if (status === 402) {
    return providerError(`${vendor} is out of credits (HTTP 402)${tail}`, 'WEB_PROVIDER_QUOTA_EXCEEDED')
  }
  if (status === 429) {
    return providerError(`${vendor} rate-limited the request (HTTP 429)${tail}`, 'WEB_PROVIDER_RATE_LIMITED')
  }
  if (status === 400 || status === 422) {
    return providerError(`${vendor} rejected the request (HTTP ${status})${tail}`, 'WEB_PROVIDER_BAD_REQUEST')
  }
  if (status >= 500) {
    return providerError(`${vendor} failed upstream (HTTP ${status})${tail}`, 'WEB_PROVIDER_UPSTREAM')
  }
  return providerError(`${vendor} failed with HTTP ${status}${tail}`, 'WEB_PROVIDER_ERROR')
}

const transportFailure = (vendor, cause, timedOut, timeoutMs) => {
  if (timedOut) return providerError(`${vendor} timed out after ${timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')
  const message = cause?.message ?? String(cause)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket hang up/i.test(message)) {
    return providerError(`${vendor} is unreachable: ${message}`, 'WEB_PROVIDER_UNREACHABLE')
  }
  return providerError(`${vendor} failed: ${message}`, 'WEB_PROVIDER_ERROR')
}

/* ------------------------------------------------------------------ values -- */

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const asNumber = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
const asInteger = (value, fallback, min, max) => Math.round(asNumber(value, fallback, min, max))
const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const oneOf = (value, allowed, fallback) => {
  const candidate = text(value).toLowerCase()
  return allowed.includes(candidate) ? candidate : fallback
}
const stripSlash = (value) => value.replace(/\/+$/, '')

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Results per query are fixed at five; a caller asking for fewer still wins. */
function perQueryResults(request) {
  const asked = Number.isFinite(request?.maxResults) ? Math.round(request.maxResults) : RESULTS_PER_QUERY
  return Math.max(1, Math.min(RESULTS_PER_QUERY, asked))
}

function domainList(value) {  const parts = Array.isArray(value) ? value : text(value).split(/[\s,]+/)
  const seen = new Set()
  for (const part of parts) {
    const host = text(part).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (host !== '') seen.add(host)
  }
  return [...seen]
}

/** Fallback order: known vendors only, in the order given, each at most once. */
function vendorList(value) {
  const parts = Array.isArray(value) ? value : text(value).split(/[\s,]+/)
  const seen = new Set()
  for (const part of parts) {
    const vendor = text(part).toLowerCase()
    if (VENDORS.includes(vendor) && !seen.has(vendor)) seen.add(vendor)
  }
  return [...seen]
}

/* ---------------------------------------------------------------- settings -- */

/** Detach cosmokit volatile references so the rest of the file sees plain values. */
function plainConfig(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/** Static Config supplies first-run defaults; the state file overrides them. */
function defaultsFromConfig(raw) {
  const config = plainConfig(raw ?? {})
  return {
    search: {
      backend: oneOf(config.searchBackend, VENDORS, 'tavily'),
      fallbackOrder: vendorList(config.searchFallbackOrder),
      options: {
        includeDomains: domainList(config.includeDomains),
        excludeDomains: domainList(config.excludeDomains),
      },
    },
    fetch: {
      backend: oneOf(config.fetchBackend, VENDORS, 'firecrawl'),
      fallbackOrder: vendorList(config.fetchFallbackOrder),
      options: { fallbackToHttp: asBoolean(config.fallbackToHttp, true) },
    },
    providers: {
      tavily: {
        baseURL: stripSlash(text(config.tavilyBaseURL) || 'https://api.tavily.com'),
        timeoutMs: asInteger(config.tavilyTimeoutMs, 20000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.tavilyMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.tavilyApiKey),
        apiKeyEnv: text(config.tavilyApiKeyEnv) || CREDENTIAL_REF.tavily,
        topic: oneOf(config.tavilyTopic, ['general', 'news', 'finance'], 'general'),
        searchDepth: oneOf(config.tavilySearchDepth, ['basic', 'fast', 'advanced'], 'basic'),
      },
      exa: {
        baseURL: stripSlash(text(config.exaBaseURL) || 'https://api.exa.ai'),
        timeoutMs: asInteger(config.exaTimeoutMs, 20000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.exaMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.exaApiKey),
        apiKeyEnv: text(config.exaApiKeyEnv) || CREDENTIAL_REF.exa,
        searchType: oneOf(config.exaSearchType, ['auto', 'lite', 'deep'], 'auto'),
      },
      firecrawl: {
        baseURL: stripSlash(text(config.firecrawlBaseURL) || 'https://api.firecrawl.dev'),
        timeoutMs: asInteger(config.firecrawlTimeoutMs, 30000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.firecrawlMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.firecrawlApiKey),
        apiKeyEnv: text(config.firecrawlApiKeyEnv) || CREDENTIAL_REF.firecrawl,
        version: oneOf(config.firecrawlApiVersion, ['v1', 'v2'], 'v2'),
        mainContent: asBoolean(config.firecrawlMainContent, true),
        maxAge: asInteger(config.firecrawlMaxAge, 172800000, 0, 604800000),
      },
    },
    fallback: {
      /** Total time one tool call may spend walking the chain. */
      budgetMs: asInteger(config.fallbackBudgetMs, 60000, 1000, MAX_TIMER_MS),
      timeoutMs: asInteger(config.fallbackTimeoutMs, 20000, 1000, MAX_TIMER_MS),
      maxChars: asInteger(config.fallbackMaxChars, 100000, 1000, 5000000),
      maxBytes: asInteger(config.fallbackMaxBytes, 5000000, 1000, 50000000),
      maxRedirects: asInteger(config.fallbackMaxRedirects, 5, 0, 20),
      userAgent: text(config.fallbackUserAgent) || `${PLUGIN}/0.4.0`,
    },
  }
}

/** Merge a partial (persisted or posted) document over the current settings. */
function mergeSettings(base, patch) {
  const next = {
    search: { ...base.search, options: { ...base.search.options } },
    fetch: { ...base.fetch, options: { ...base.fetch.options } },
    providers: Object.fromEntries(VENDORS.map((vendor) => [vendor, { ...base.providers[vendor] }])),
    fallback: { ...base.fallback },
  }
  if (!patch || typeof patch !== 'object') return next

  if (typeof patch.search?.backend === 'string') {
    next.search.backend = oneOf(patch.search.backend, VENDORS, next.search.backend)
  }
  if (Array.isArray(patch.search?.fallbackOrder)) {
    next.search.fallbackOrder = vendorList(patch.search.fallbackOrder)
  }

  if (typeof patch.fetch?.backend === 'string') {
    next.fetch.backend = oneOf(patch.fetch.backend, VENDORS, next.fetch.backend)
  }
  if (Array.isArray(patch.fetch?.fallbackOrder)) {
    next.fetch.fallbackOrder = vendorList(patch.fetch.fallbackOrder)
  }

  const searchOptions = patch.search?.options
  if (searchOptions !== null && typeof searchOptions === 'object') {
    if (Array.isArray(searchOptions.includeDomains)) {
      next.search.options.includeDomains = domainList(searchOptions.includeDomains)
    }
    if (Array.isArray(searchOptions.excludeDomains)) {
      next.search.options.excludeDomains = domainList(searchOptions.excludeDomains)
    }
  }
  const fetchOptions = patch.fetch?.options
  if (fetchOptions !== null && typeof fetchOptions === 'object') {
    next.fetch.options.fallbackToHttp = asBoolean(
      fetchOptions.fallbackToHttp,
      next.fetch.options.fallbackToHttp,
    )
  }

  // The fallback budget and caps are form fields too, so an HTTP caller gets the
  // same reach as the native sheet in dsh-go.
  const fallback = patch.fallback
  if (fallback !== null && typeof fallback === 'object') {
    next.fallback.budgetMs = asInteger(fallback.budgetMs, next.fallback.budgetMs, 1000, MAX_TIMER_MS)
    next.fallback.timeoutMs = asInteger(fallback.timeoutMs, next.fallback.timeoutMs, 1000, MAX_TIMER_MS)
    next.fallback.maxChars = asInteger(fallback.maxChars, next.fallback.maxChars, 1000, 5000000)
    next.fallback.maxBytes = asInteger(fallback.maxBytes, next.fallback.maxBytes, 1000, 50000000)
    next.fallback.maxRedirects = asInteger(fallback.maxRedirects, next.fallback.maxRedirects, 0, 20)
  }

  return next
}

/* -------------------------------------------------------------------- keys -- */

async function resolveKey(ctx, vendor, provider) {
  const literal = text(provider.apiKey)
  if (literal !== '') return { value: literal, source: 'config' }
  const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && text(resolved.value) !== '') {
        return { value: text(resolved.value), source: resolved.source || 'credentials' }
      }
    } catch {
      /* fall through to the environment */
    }
  }
  const fromEnv = text(process.env[ref])
  if (fromEnv !== '') return { value: fromEnv, source: 'env' }
  return { value: '', source: 'missing' }
}

async function requireKey(ctx, vendor, provider) {
  const key = await resolveKey(ctx, vendor, provider)
  if (key.value === '') {
    const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
    throw providerError(
      `${vendor} API key is not configured: open Settings -> Plugins -> Web tool provider and save it, or set $${ref}`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  return key.value
}

async function describeKeys(ctx, settings) {
  const credentials = ctx.get('credentials')
  const result = {}
  for (const vendor of VENDORS) {
    const provider = settings.providers[vendor]
    const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
    let info = { ref, configured: false, source: 'missing', writable: credentials !== undefined }
    if (text(provider.apiKey) !== '') {
      info = { ...info, configured: true, source: 'config' }
    } else if (credentials !== undefined) {
      try {
        const described = await credentials.describe(ref)
        info = {
          ref,
          configured: Boolean(described.configured),
          source: described.source || (described.configured ? 'credentials' : 'missing'),
          writable: Boolean(described.writable),
        }
      } catch {
        /* keep the default */
      }
    }
    if (!info.configured && text(process.env[ref]) !== '') {
      info = { ...info, configured: true, source: 'env' }
    }
    result[vendor] = info
  }
  return result
}

/* ------------------------------------------------------------------- state -- */

function stateFileCandidates() {
  const candidates = []
  if (text(process.env.DSH_PROFILE_DIR) !== '') {
    candidates.push(join(process.env.DSH_PROFILE_DIR, `.${PLUGIN}`, 'state.json'))
  }
  if (text(process.env.DSH_HOME) !== '') candidates.push(join(process.env.DSH_HOME, PLUGIN, 'state.json'))
  candidates.push(join(homedir(), '.dsh', PLUGIN, 'state.json'))
  return candidates
}

function loadSettings(config) {
  const defaults = defaultsFromConfig(config)
  const legacy = legacyState()
  return legacy === undefined
    ? { settings: defaults, storage: undefined }
    : { settings: mergeSettings(defaults, legacy.raw), storage: legacy.storage }
}

/** The plugin-owned state file written before the settings service existed. */
function legacyState() {
  for (const file of stateFileCandidates()) {
    try {
      return { raw: JSON.parse(readFileSync(file, 'utf8')), storage: file }
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/** Flatten the editable layers back into the volatile fields the form declares. */
function configFromSettings(settings) {
  return {
    searchBackend: settings.search.backend,
    searchFallbackOrder: [...settings.search.fallbackOrder],
    fetchBackend: settings.fetch.backend,
    fetchFallbackOrder: [...settings.fetch.fallbackOrder],
    includeDomains: [...settings.search.options.includeDomains],
    excludeDomains: [...settings.search.options.excludeDomains],
    fallbackToHttp: settings.fetch.options.fallbackToHttp,
    fallbackBudgetMs: settings.fallback.budgetMs,
    fallbackTimeoutMs: settings.fallback.timeoutMs,
    fallbackMaxChars: settings.fallback.maxChars,
    fallbackMaxBytes: settings.fallback.maxBytes,
    fallbackMaxRedirects: settings.fallback.maxRedirects,
  }
}

/** The Loader row this fiber belongs to; that id is the settings namespace. */
function ownEntryId(ctx) {
  let fallback
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name !== PACKAGE) continue
      const id = entry.options.id
      if (typeof id !== 'string' || id === '') continue
      if (entry.fiber === ctx.fiber) return id
      if (entry.disabled !== true && fallback === undefined) fallback = id
    }
  } catch {
    return undefined
  }
  return fallback
}

/**
 * A small face over the host settings service, scoped to this row. `get` is
 * cheap enough for a request handler; `update` writes the patch into the
 * profile document and remounts the row, so the next request sees the values
 * the form just saved.
 *
 * `describe()` is called without `redactSecrets` on purpose: this call stays
 * inside this process, and a redacted read would hand the resolver an empty
 * key for every vendor the user filled in on the phone. Responses leaving this
 * process are redacted by the settings wire layer, not here.
 */
function createSettingsFace(settings, ns) {
  const describe = () => {
    try {
      return settings.describe().find((row) => row.ns === ns)
    } catch {
      return undefined
    }
  }
  const face = {
    documentPath: () => {
      try {
        return settings.documentPath
      } catch {
        return undefined
      }
    },
    get: () => {
      const row = describe()
      return row === undefined ? undefined : { value: row.value, revision: row.revision }
    },
    update: async (patch, expectedRevision) => {
      await settings.update(ns, patch, expectedRevision)
      return face.get()
    },
  }
  return face
}

/**
 * Import the pre-settings state file once — only while the row carries no user
 * values. The file stays on disk as a backup but is never written again: from
 * here on the profile document is the only place settings are stored.
 */
async function importLegacyState(ctx, settings, ns) {
  const legacy = legacyState()
  if (legacy === undefined) return
  await ctx.loader?.await?.()
  const row = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns)
  if (row === undefined) return
  const user = row.user
  if (user !== null && typeof user === 'object' && Object.keys(user).length > 0) return
  const merged = mergeSettings(defaultsFromConfig(row.value), legacy.raw)
  await settings.update(ns, configFromSettings(merged))
  ctx.logger?.info?.(`${PLUGIN}: imported ${legacy.storage} into the profile settings`)
}

function persistSettings(settings) {
  let lastError
  for (const file of stateFileCandidates()) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      const payload = {
        search: {
          backend: settings.search.backend,
          fallbackOrder: settings.search.fallbackOrder,
          options: {
            includeDomains: settings.search.options.includeDomains,
            excludeDomains: settings.search.options.excludeDomains,
          },
        },
        fetch: {
          backend: settings.fetch.backend,
          fallbackOrder: settings.fetch.fallbackOrder,
          options: { fallbackToHttp: settings.fetch.options.fallbackToHttp },
        },
        fallback: {
          budgetMs: settings.fallback.budgetMs,
          timeoutMs: settings.fallback.timeoutMs,
          maxChars: settings.fallback.maxChars,
          maxBytes: settings.fallback.maxBytes,
          maxRedirects: settings.fallback.maxRedirects,
        },
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`)
      renameSync(temporary, file)
      return { persisted: true, location: file }
    } catch (error) {
      lastError = error
    }
  }
  return { persisted: false, reason: `write-failed: ${lastError?.message ?? 'no writable location'}` }
}

/**
 * Persist through the profile form when the settings service is mounted, and
 * fall back to the hand-rolled file on hosts that do not have one. A rejected
 * edit is reported to the page instead of silently vanishing.
 */
async function saveSettings(state, settings) {
  if (state.forms === undefined) return persistSettings(settings)
  try {
    const revision = state.forms.get()?.revision
    await state.forms.update(configFromSettings(settings), revision)
    return { persisted: true, location: state.forms.documentPath() ?? 'profile settings' }
  } catch (error) {
    return { persisted: false, reason: `settings-rejected: ${error?.message ?? String(error)}` }
  }
}

/* ----------------------------------------------------------------- helpers -- */

const flatten = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Every vendor's date becomes `YYYY-MM-DD`, or nothing. */
function toDateOnly(value) {
  const candidate = text(value)
  if (candidate === '') return undefined
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(candidate)
  if (iso !== null) return iso[1]
  const parsed = Date.parse(candidate)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString().slice(0, 10)
}

async function withDeadline(signal, timeoutMs, label, task) {
  if (signal?.aborted) throw providerError(`${label} aborted`, 'WEB_ABORTED')
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await task(controller.signal)
  } catch (error) {
    if (error?.code) throw error
    if (signal?.aborted) throw providerError(`${label} aborted`, 'WEB_ABORTED')
    throw transportFailure(label, error, timedOut, timeoutMs)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function postJson(url, body, { headers, timeoutMs, signal, label, vendor }) {
  return withDeadline(signal, timeoutMs, label, async (inner) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: inner,
    })
    const raw = await response.text()
    if (!response.ok) throw classifyFailure(vendor, response.status, raw)
    try {
      return JSON.parse(raw)
    } catch {
      throw providerError(`${vendor} returned a non-JSON response`, 'WEB_PROVIDER_UPSTREAM')
    }
  })
}

async function getJson(url, { headers, timeoutMs, signal, label, vendor }) {
  return withDeadline(signal, timeoutMs, label, async (inner) => {
    const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: inner })
    const raw = await response.text()
    if (!response.ok) throw classifyFailure(vendor, response.status, raw)
    try {
      return JSON.parse(raw)
    } catch {
      throw providerError(`${vendor} returned a non-JSON response`, 'WEB_PROVIDER_UPSTREAM')
    }
  })
}

/**
 * Remaining balance per vendor. Tavily reports usage against a limit, Firecrawl
 * reports the remaining credits directly, Exa has no balance endpoint at all.
 */
async function fetchCredits(ctx, settings, vendor) {
  if (vendor === 'exa') return { supported: false, reason: 'exa has no balance endpoint' }
  const provider = settings.providers[vendor]
  const apiKey = await requireKey(ctx, vendor, provider)

  if (vendor === 'tavily') {
    const payload = await getJson(`${provider.baseURL}/usage`, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: provider.timeoutMs,
      label: 'tavily usage',
      vendor: 'tavily',
    })
    const keyUsage = payload?.key ?? {}
    const account = payload?.account ?? {}
    const limit = Number.isFinite(account.plan_limit) ? account.plan_limit : Number.isFinite(keyUsage.limit) ? keyUsage.limit : undefined
    const used = Number.isFinite(account.plan_usage) ? account.plan_usage : Number.isFinite(keyUsage.usage) ? keyUsage.usage : undefined
    return {
      supported: true,
      plan: text(account.current_plan) || undefined,
      used,
      limit,
      remaining: limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined,
    }
  }

  const payload = await getJson(`${provider.baseURL}/${provider.version}/team/credit-usage`, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: provider.timeoutMs,
    label: 'firecrawl credit usage',
    vendor: 'firecrawl',
  })
  if (payload?.success === false) {
    throw providerError(`firecrawl credit usage failed: ${clip(payload?.error ?? 'unknown error', 200)}`, 'WEB_PROVIDER_UPSTREAM')
  }
  const data = payload?.data ?? {}
  return {
    supported: true,
    used: Number.isFinite(data.planCredits) && Number.isFinite(data.remainingCredits) ? data.planCredits - data.remainingCredits : undefined,
    limit: Number.isFinite(data.planCredits) ? data.planCredits : undefined,
    remaining: Number.isFinite(data.remainingCredits) ? data.remainingCredits : undefined,
    periodEnd: text(data.billingPeriodEnd) || undefined,
  }
}

function normalizeSource(raw) {
  const url = text(raw?.url) || text(raw?.link) || text(raw?.metadata?.sourceURL)
  if (url === '') return undefined
  const title = flatten(raw?.title) || undefined
  const highlights = Array.isArray(raw?.highlights) ? raw.highlights.map(flatten).filter(Boolean).join(' ') : ''
  const body = flatten(raw?.description || raw?.snippet || raw?.summary || raw?.text || raw?.content || highlights)
  const author = flatten(raw?.author)
  let snippet = body
  if (snippet === '' && author !== '') snippet = author
  else if (snippet !== '' && author !== '') snippet = `${snippet} · ${author}`
  const source = { url }
  if (title !== undefined) source.title = title
  if (snippet !== '') source.snippet = clip(snippet, SNIPPET_CHARS)
  const publishedAt = toDateOnly(raw?.published_date ?? raw?.publishedDate ?? raw?.date)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return source
}

function normalizeSources(items) {
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const source = normalizeSource(item)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return sources
}

function composeAnswer(answer, notices) {
  const blocks = []
  if (answer !== '') blocks.push(answer)
  for (const notice of notices) blocks.push(`> provider notice: ${notice}`)
  return blocks.length === 0 ? undefined : blocks.join('\n\n')
}

/* ---------------------------------------------------------- fallback chain -- */

const cooldownId = (kind, vendor) => `${kind}:${vendor}`

function cooldownOf(state, kind, vendor) {
  const entry = state.cooldowns.get(cooldownId(kind, vendor))
  if (entry === undefined) return undefined
  if (entry.until <= Date.now()) {
    state.cooldowns.delete(cooldownId(kind, vendor))
    return undefined
  }
  return entry
}

/** A vendor that just failed sits out; zero-length codes are not remembered. */
function markCooling(state, kind, vendor, code) {
  const ms = COOLDOWN_MS[code] ?? 0
  if (ms <= 0) {
    state.cooldowns.delete(cooldownId(kind, vendor))
    return
  }
  state.cooldowns.set(cooldownId(kind, vendor), { until: Date.now() + ms, code })
}

/** A working key clears its vendor's record for both capabilities. */
function clearCooling(state, vendor) {
  for (const kind of ['search', 'fetch']) state.cooldowns.delete(cooldownId(kind, vendor))
}

/** Primary first, then the configured order; a vendor is never tried twice. */
function chainFor(settings, kind) {
  const chain = []
  for (const vendor of [settings[kind].backend, ...settings[kind].fallbackOrder]) {
    if (VENDORS.includes(vendor) && !chain.includes(vendor)) chain.push(vendor)
  }
  return chain
}

function activeCooling(state) {
  const now = Date.now()
  const list = []
  for (const [id, entry] of state.cooldowns) {
    if (entry.until <= now) {
      state.cooldowns.delete(id)
      continue
    }
    const [kind, vendor] = id.split(':')
    list.push({ kind, vendor, code: entry.code, remainingMs: entry.until - now })
  }
  return list
}

function describeCooldown(entry) {
  const seconds = Math.max(1, Math.ceil((entry.until - Date.now()) / 1000))
  return `${entry.vendor} is cooling down for ${seconds}s after ${entry.code}`
}

function pushFallbackNotices(notices, attempts, skipped, vendor) {
  for (const entry of skipped ?? []) notices.push(describeCooldown(entry))
  if (vendor !== undefined && attempts !== undefined && attempts.length > 0) {
    const trail = attempts.map((entry) => `${entry.vendor} ${entry.code}`).join(', ')
    notices.push(`fell back to ${vendor} after ${trail}`)
  }
}

/**
 * Walk the chain until one vendor answers. Every hop gets what is left of a
 * shared budget, so three dead vendors cost one timeout instead of three.
 */
async function runChain({ state, settings, kind, signal, run }) {
  const chain = chainFor(settings, kind)
  const budgetMs = settings.fallback.budgetMs
  const startedAt = Date.now()
  const attempts = []
  const skipped = []
  let lastError
  let exhausted = false

  for (const vendor of chain) {
    const cooling = cooldownOf(state, kind, vendor)
    if (cooling !== undefined) {
      skipped.push({ vendor, ...cooling })
      continue
    }
    const remaining = budgetMs - (Date.now() - startedAt)
    if (remaining <= 250) {
      exhausted = true
      break
    }

    let ranOut = false
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) forwardAbort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => {
      ranOut = true
      controller.abort()
    }, remaining)
    try {
      const result = await run(vendor, controller.signal)
      clearCooling(state, vendor)
      return { result, vendor, attempts, skipped }
    } catch (error) {
      if (ranOut) {
        exhausted = true
        lastError = providerError(
          `${kind} fallback budget (${budgetMs}ms) ran out while ${vendor} was still working`,
          'WEB_FETCH_TIMEOUT',
        )
        break
      }
      const code = error?.code ?? 'WEB_PROVIDER_ERROR'
      if (TERMINAL_CODES.has(code) || NON_RETRYABLE_CODES.has(code)) throw error
      attempts.push({ vendor, code })
      markCooling(state, kind, vendor, code)
      lastError = error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  if (lastError === undefined && attempts.length === 0 && skipped.length > 0) {
    const detail = skipped
      .map((entry) => `${entry.vendor} ${Math.max(1, Math.ceil((entry.until - Date.now()) / 1000))}s (${entry.code})`)
      .join(', ')
    lastError = providerError(`every ${kind} backend is cooling down: ${detail}`, skipped[0].code)
  }
  const error = lastError ?? providerError(
    exhausted
      ? `${kind} fallback budget (${budgetMs}ms) ran out before any backend answered`
      : `no ${kind} backend is configured`,
    exhausted ? 'WEB_FETCH_TIMEOUT' : 'WEB_PROVIDER_BAD_REQUEST',
  )
  error.attempts = attempts
  error.skipped = skipped
  error.exhausted = exhausted
  throw error
}

/* ---------------------------------------------------------------- adapters -- */

async function tavilySearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.tavily
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'tavily', provider)
  const body = {
    query: text(request?.query),
    max_results: perQueryResults(request),
    search_depth: provider.searchDepth,
    topic: provider.topic,
  }
  // Published dates only come back when asked for (beta, free); topic=news implies it.
  body.include_published_date = true
  if (options.includeDomains.length > 0) body.include_domains = options.includeDomains
  if (options.excludeDomains.length > 0) body.exclude_domains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'tavily search',
    vendor: 'tavily',
  })
  return { answer: '', sources: normalizeSources(payload?.results) }
}

async function exaSearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.exa
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'exa', provider)
  const body = {
    query: text(request?.query),
    type: provider.searchType,
    numResults: perQueryResults(request),
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'exa search',
    vendor: 'exa',
  })
  return { answer: '', sources: normalizeSources(payload?.results) }
}

async function firecrawlSearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.firecrawl
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'firecrawl', provider)
  const body = {
    query: text(request?.query),
    limit: perQueryResults(request),
    sources: ['web'],
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/${provider.version}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'firecrawl search',
    vendor: 'firecrawl',
  })
  if (payload?.success === false) {
    throw providerError(`firecrawl search failed: ${clip(payload?.error ?? 'unknown error', 240)}`, 'WEB_PROVIDER_UPSTREAM')
  }
  const data = payload?.data
  const items = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : []
  return { answer: '', sources: normalizeSources(items) }
}

function documentResult(content, maxChars, url, statusCode = 200) {
  const body = String(content ?? '').trim()
  if (body === '') throw providerError('the provider returned no page content', 'WEB_PROVIDER_EMPTY')
  const truncated = body.length > maxChars
  return {
    url,
    statusCode,
    body: { kind: 'text', content: truncated ? body.slice(0, maxChars) : body },
    truncated,
  }
}

async function firecrawlFetch(ctx, settings, request, signal) {
  const provider = settings.providers.firecrawl
  const apiKey = await requireKey(ctx, 'firecrawl', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/${provider.version}/scrape`,
    {
      url,
      formats: ['markdown'],
      onlyMainContent: provider.mainContent,
      maxAge: provider.maxAge,
      timeout: provider.timeoutMs,
    },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: provider.timeoutMs + 15000,
      signal,
      label: 'firecrawl scrape',
      vendor: 'firecrawl',
    },
  )
  if (payload?.success === false) {
    throw providerError(
      `firecrawl scrape failed: ${clip(payload?.error ?? payload?.message ?? 'unknown error', 240)}`,
      'WEB_PROVIDER_UPSTREAM',
    )
  }
  const doc = payload?.data ?? payload
  const metadata = doc?.metadata ?? {}
  const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200
  const finalUrl = text(metadata.url) || text(metadata.sourceURL) || url
  return documentResult(doc?.markdown ?? doc?.content, provider.maxChars, finalUrl, statusCode)
}

async function exaFetch(ctx, settings, request, signal) {
  const provider = settings.providers.exa
  const apiKey = await requireKey(ctx, 'exa', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/contents`,
    { urls: [url], text: true },
    {
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      timeoutMs: provider.timeoutMs,
      signal,
      label: 'exa contents',
      vendor: 'exa',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) throw providerError('exa returned no page content', 'WEB_PROVIDER_EMPTY')
  const content = text(first.text) || (Array.isArray(first.highlights) ? first.highlights.join('\n\n') : '')
  return documentResult(content, provider.maxChars, text(first.url) || url)
}

async function tavilyFetch(ctx, settings, request, signal) {
  const provider = settings.providers.tavily
  const apiKey = await requireKey(ctx, 'tavily', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/extract`,
    { urls: [url] },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: provider.timeoutMs,
      signal,
      label: 'tavily extract',
      vendor: 'tavily',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) {
    const failed = Array.isArray(payload?.failed_results) ? payload.failed_results[0] : undefined
    throw providerError(
      `tavily could not extract ${url}${failed?.error ? `: ${clip(failed.error, 200)}` : ''}`,
      'WEB_PROVIDER_EMPTY',
    )
  }
  return documentResult(text(first.raw_content), provider.maxChars, text(first.url) || url)
}

/* -------------------------------------------------- credential-free fetch -- */

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
    if (host.startsWith('::ffff:')) return true
    return false
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 === null) return false
  const a = Number(ipv4[1])
  const b = Number(ipv4[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function parseTarget(raw) {
  const value = text(raw)
  if (value === '') throw providerError('url must be a non-empty string', 'WEB_INVALID_URL')
  let url
  try {
    url = new URL(value)
  } catch {
    throw providerError(`invalid URL ${JSON.stringify(value)}`, 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw providerError(`unsupported protocol ${JSON.stringify(url.protocol)}`, 'WEB_INVALID_URL')
  }
  if (isBlockedHost(url.hostname)) {
    throw providerError(`host ${JSON.stringify(url.hostname)} is not a public destination`, 'WEB_BLOCKED_URL')
  }
  return url
}

function classifyContentType(value) {
  const type = text(value).split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json' || type.endsWith('+json')) return 'text'
  if (type === 'application/xml' || type.endsWith('+xml')) return 'text'
  return undefined
}

function charsetOf(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(text(contentType))
  return match === null ? 'utf-8' : match[1].toLowerCase()
}

function decodeBytes(bytes, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

async function readCapped(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    if (error?.code) throw error
    throw transportFailure('local fetch', error, false, 0)
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, truncated }
}

async function localFetch(settings, request, signal) {
  const fallback = settings.fallback
  return withDeadline(signal, fallback.timeoutMs, 'local fetch', async (inner) => {
    let current = parseTarget(request?.url)
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: inner,
        headers: {
          'user-agent': fallback.userAgent,
          accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,application/xml;q=0.7',
        },
      })

      if (REDIRECT_STATUS.has(response.status)) {
        if (hop >= fallback.maxRedirects) {
          await response.body?.cancel().catch(() => {})
          throw providerError(
            `redirect limit (${fallback.maxRedirects}) exceeded for ${current.toString()}`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (location === null || location === '') {
          throw providerError(
            `redirect response (HTTP ${response.status}) without a Location header`,
            'WEB_PROVIDER_UPSTREAM',
          )
        }
        current = parseTarget(new URL(location, current).toString())
        continue
      }

      const contentType = response.headers.get('content-type')
      const kind = classifyContentType(contentType)
      if (kind === undefined) {
        await response.body?.cancel().catch(() => {})
        throw providerError(
          `unsupported content type ${JSON.stringify(contentType ?? 'unknown')}`,
          'WEB_UNSUPPORTED_CONTENT_TYPE',
        )
      }
      const { bytes, truncated: truncatedByBytes } = await readCapped(response, fallback.maxBytes)
      const decoded = decodeBytes(bytes, contentType)
      const truncated = truncatedByBytes || decoded.length > fallback.maxChars
      return {
        url: current.toString(),
        statusCode: response.status,
        body: { kind, content: truncated ? decoded.slice(0, fallback.maxChars) : decoded },
        truncated,
      }
    }
  })
}

/* ------------------------------------------------------------------ plugin -- */

const SEARCH_VENDOR = { tavily: tavilySearch, exa: exaSearch, firecrawl: firecrawlSearch }
const FETCH_VENDOR = { tavily: tavilyFetch, exa: exaFetch, firecrawl: firecrawlFetch }

function withNotices(result, notices) {
  if (notices.length === 0) return result
  const trailer = notices.map((notice) => `> provider notice: ${notice}`).join('\n')
  return { ...result, body: { ...result.body, content: `${result.body.content}\n\n${trailer}` } }
}

function createSearchProvider(ctx, state) {
  return {
    id: PROVIDER_ID,
    available() {
      return true
    },
    async search(request, signal) {
      const settings = state.settings
      const notices = []
      const { result, vendor, attempts, skipped } = await runChain({
        state,
        settings,
        kind: 'search',
        signal,
        // Notices from a failed hop must not leak into the answer the next
        // vendor produces, so each hop collects its own and merges on success.
        run: async (name, hop) => {
          const hopNotices = []
          const result = await SEARCH_VENDOR[name](ctx, settings, request, hop, hopNotices)
          notices.push(...hopNotices)
          return result
        },
      })
      pushFallbackNotices(notices, attempts, skipped, vendor)
      if (result.sources.length === 0) notices.push(`${vendor} returned no results for this query`)
      return {
        content: composeAnswer(result.answer, notices),
        sources: result.sources,
        truncated: false,
      }
    },
  }
}

function createFetchProvider(ctx, state) {
  return {
    id: PROVIDER_ID,
    available() {
      return true
    },
    async fetch(request, signal) {
      const settings = state.settings
      const notices = []
      try {
        const { result, vendor, attempts, skipped } = await runChain({
          state,
          settings,
          kind: 'fetch',
          signal,
          run: (name, hop) => FETCH_VENDOR[name](ctx, settings, request, hop),
        })
        pushFallbackNotices(notices, attempts, skipped, vendor)
        return withNotices(result, notices)
      } catch (error) {
        if (!settings.fetch.options.fallbackToHttp) throw error
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) throw error
        pushFallbackNotices(notices, error?.attempts, error?.skipped, undefined)
        const result = await localFetch(settings, request, signal)
        return withNotices(result, [...notices, `fell back to a direct HTTP fetch: ${error?.code ?? 'error'}`])
      }
    },
  }
}

/* ------------------------------------------------------------------ routes -- */

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw providerError('request body too large', 'WEB_PROVIDER_BAD_REQUEST')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw providerError('request body must be JSON', 'WEB_PROVIDER_BAD_REQUEST')
  }
}

function createStateRoutes(ctx, state) {
  /**
   * The profile form is the source of truth once the settings service is
   * mounted: another device (dsh-go) writes the same document, so reading
   * through the form keeps this page from showing a stale backend.
   */
  const liveSettings = () => {
    const row = state.forms?.get()
    if (row === undefined || row.value === null || typeof row.value !== 'object') return state.settings
    return defaultsFromConfig(row.value)
  }

  const refreshKeys = async () => {
    state.keys = await describeKeys(ctx, liveSettings())
  }

  const snapshot = () => {
    const settings = liveSettings()
    return {
      search: { backend: settings.search.backend, fallbackOrder: settings.search.fallbackOrder },
      fetch: { backend: settings.fetch.backend, fallbackOrder: settings.fetch.fallbackOrder },
      fallback: { budgetMs: settings.fallback.budgetMs, cooling: activeCooling(state) },
      keys: state.keys,
      stateFile: state.forms?.documentPath() ?? state.storage ?? stateFileCandidates()[0],
    }
  }

  const handler = async (req, res) => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await refreshKeys()
      sendJson(res, 200, snapshot())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const credentialRef = (vendor) => text(state.settings.providers[vendor].apiKeyEnv) || CREDENTIAL_REF[vendor]
      // Keys typed on either surface have to land in the same place: the
      // profile form, which is where the phone sheet writes them. Without the
      // form (older host) fall back to the credentials service.
      const storeKey = async (vendor, value) => {
        if (state.forms === undefined) return false
        const row = state.forms.get()
        await state.forms.update({ [`${vendor}ApiKey`]: value }, row?.revision)
        return true
      }
      if (body.setKey && typeof body.setKey === 'object') {
        const vendor = oneOf(body.setKey.vendor, VENDORS, '')
        const value = text(body.setKey.value)
        if (vendor === '' || value === '') {
          throw providerError('setKey needs a vendor and a non-empty value', 'WEB_PROVIDER_BAD_REQUEST')
        }
        if (!(await storeKey(vendor, value))) {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) {
            throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
          }
          await credentials.set(credentialRef(vendor), value)
        }
        clearCooling(state, vendor)
      }
      if (body.clearKey && typeof body.clearKey === 'object') {
        const vendor = oneOf(body.clearKey.vendor, VENDORS, '')
        if (vendor === '') throw providerError('clearKey needs a vendor', 'WEB_PROVIDER_BAD_REQUEST')
        if (!(await storeKey(vendor, ''))) {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) {
            throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
          }
          await credentials.unset(credentialRef(vendor))
        }
        clearCooling(state, vendor)
      }
      // Saving a key alone must not rewrite the profile document: every write
      // reloads this row, which would drop the providers a search is using.
      const touched = ['search', 'fetch', 'fallback'].filter((key) => body[key] !== undefined)
      let persistence
      if (touched.length === 0) {
        state.settings = liveSettings()
      } else {
        state.settings = mergeSettings(liveSettings(), body)
        persistence = await saveSettings(state, state.settings)
      }
      await refreshKeys()
      sendJson(res, 200, persistence === undefined ? snapshot() : { ...snapshot(), persistence })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error), code: error?.code })
    }
  }

  return ctx.webServer.register({ kind: 'exact', path: ROUTE, handler })
}

function createCreditsRoutes(ctx, state) {
  const handler = async (req, res) => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    const vendor = oneOf(new URL(req.url ?? '/', 'http://localhost').searchParams.get('vendor'), VENDORS, '')
    if (vendor === '') {
      sendJson(res, 400, { error: 'vendor is required' })
      return
    }
    try {
      sendJson(res, 200, { vendor, ...(await fetchCredits(ctx, state.settings, vendor)) })
    } catch (error) {
      sendJson(res, 502, { vendor, error: error?.message ?? String(error), code: error?.code })
    }
  }
  return ctx.webServer.register({ kind: 'exact', path: CREDITS_ROUTE, handler })
}

export function apply(ctx, config) {
  const { settings, storage } = loadSettings(config)
  const state = { settings, storage, keys: {}, cooldowns: new Map(), forms: undefined }
  // Every registration below is released on dispose. An edit from the Plugins
  // page re-applies this row, and a duplicate route or provider id is a hard
  // error, so a leak here would break the very page that made the edit.
  ctx.effect(() => {
    const disposers = [
      ctx.web.registerSearchProvider(createSearchProvider(ctx, state)),
      ctx.web.registerFetchProvider(createFetchProvider(ctx, state)),
    ]
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, `${PLUGIN}: providers`)
  ctx.effect(() => {
    const disposers = []
    for (const [label, mount] of [
      ['settings', () => createStateRoutes(ctx, state)],
      ['credits', () => createCreditsRoutes(ctx, state)],
    ]) {
      try {
        disposers.push(mount())
      } catch (error) {
        // Losing a page is survivable; losing the web backends is not.
        ctx.logger?.warn?.(`${PLUGIN}: ${label} route unavailable: ${error?.message ?? String(error)}`)
      }
    }
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, `${PLUGIN}: routes`)

  // The Plugins page (and dsh-go's native plugin sheet) edit this row through
  // the host settings service. Without it the state file above stays in charge,
  // which is exactly the pre-0.14 behaviour.
  ctx.inject(['settings'], (sctx) => {
    const ns = ownEntryId(ctx)
    if (ns === undefined) {
      ctx.logger?.warn?.(`${PLUGIN}: no profile row for this package; settings stay at the config defaults`)
      return
    }
    state.forms = createSettingsFace(sctx.settings, ns)
    // describe() only lists rows whose fiber is active, and this one is still
    // inside apply(), so the first read has to wait for the loader to settle.
    void (async () => {
      await ctx.loader?.await?.()
      const row = state.forms.get()
      if (row !== undefined && row.value !== null && typeof row.value === 'object') {
        state.settings = defaultsFromConfig(row.value)
        state.storage = undefined
      }
      await importLegacyState(ctx, sctx.settings, ns)
    })().catch((error) => {
      ctx.logger?.warn?.(`${PLUGIN}: could not read the profile form: ${error?.message ?? String(error)}`)
    })
  })
}
