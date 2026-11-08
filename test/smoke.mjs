import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never touch the real profile: settings persist under $DSH_HOME, and the
// homedir fallback is sandboxed too so a developer's own state file cannot
// leak into the assertions.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-web-tool-'))
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_HOME
process.env.DSH_HOME = SANDBOX
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX

const mod = await import('../index.js')

/* --------------------------------------------------------------- harness -- */

const calls = []
const originalFetch = globalThis.fetch
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init, body })
    if (init.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return handler(String(url), body, init)
  }
}

function harness(config = {}, { credentials } = {}) {
  const registry = { search: null, fetch: null }
  const routes = []
  const ctx = {
    web: {
      registerSearchProvider: (entry) => ((registry.search = entry), () => {}),
      registerFetchProvider: (entry) => ((registry.fetch = entry), () => {}),
    },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    // The host settings service is optional: this stub keeps the pre-settings
    // path (the plugin-owned state file) under test. A dedicated harness below
    // mounts a fake form to cover the service path.
    // Route and provider registrations are mounted inside effects so a reload
    // releases them; this stub runs the callback immediately.
    effect: (callback) => (callback(), () => {}),
    inject: () => {},
  }
  mod.apply(ctx, config)
  return { registry, routes, route: routes[0], creditsRoute: routes[1] }
}

function request({ method = 'GET', origin, body, url } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url: url ?? '/web-tool-provider/state',
    method,
    headers: origin === undefined ? { host: '127.0.0.1:1' } : { host: '127.0.0.1:1', origin },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      this.body = chunk
    },
  }
}

async function call(route, opts) {
  const res = response()
  await route.handler(request(opts), res)
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : undefined }
}

const fakeCredentials = (store = {}) => {
  const writes = []
  return {
    writes,
    resolve: async (ref) => (store[ref] ? { value: store[ref], source: 'keyring' } : undefined),
    describe: async (ref) => ({
      configured: Boolean(store[ref]),
      source: store[ref] ? 'keyring' : undefined,
      writable: true,
    }),
    set: async (ref, value) => {
      writes.push(['set', ref, value])
      store[ref] = value
    },
    unset: async (ref) => {
      writes.push(['unset', ref])
      delete store[ref]
    },
  }
}

const results = []
async function check(name, run) {
  rmSync(join(SANDBOX, 'web-tool-provider'), { recursive: true, force: true })
  try {
    await run()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const KEYS = { tavilyApiKey: 'tvly-x', exaApiKey: 'exa-x', firecrawlApiKey: 'fc-x' }
const TAVILY = {
  answer: 'A',
  results: [{ title: 'T', url: 'https://a.test/1', content: 'body', published_date: '2026-02-03' }],
}

/* ------------------------------------------------------------ contract -- */

await check('one provider per capability, one state route, one credits route', async () => {
  const { registry, routes } = harness()
  assert.equal(registry.search.id, 'web-tool')
  assert.equal(registry.fetch.id, 'web-tool')
  assert.equal(routes.length, 2)
  assert.equal(routes[0].path, '/web-tool-provider/state')
  assert.equal(routes[1].path, '/web-tool-provider/credits')
})

await check('every vendor normalizes to the same source shape', async () => {
  const expected = {
    url: 'https://x.test/1',
    title: 'X',
    snippet: 'body text · Ann Author',
    publishedAt: '2026-03-04',
  }
  const variants = {
    tavily: { answer: '', results: [{ title: 'X', url: 'https://x.test/1', content: 'body text', published_date: '2026-03-04', author: 'Ann Author' }] },
    exa: { results: [{ title: 'X', url: 'https://x.test/1', highlights: ['body text'], publishedDate: '2026-03-04T10:00:00.000Z', author: 'Ann Author' }] },
    firecrawl: { success: true, data: { web: [{ title: 'X', url: 'https://x.test/1', description: 'body text', author: 'Ann Author', date: '2026-03-04T08:00:00Z' }] } },
  }
  for (const vendor of Object.keys(variants)) {
    stubFetch(() => json(variants[vendor]))
    const { registry, route } = harness(KEYS)
    await call(route, { method: 'POST', body: { search: { backend: vendor } } })
    const out = await registry.search.search({ query: 'q' })
    assert.deepEqual(out.sources[0], expected, vendor)
    assert.equal(out.truncated, false)
  }
})

await check('dates become YYYY-MM-DD and long snippets are clipped', async () => {
  stubFetch(() =>
    json({ results: [{ title: 'T', url: 'https://x.test/', content: 'word '.repeat(300), published_date: 'Tue, 03 Feb 2026 10:00:00 GMT' }] }),
  )
  const { registry } = harness(KEYS)
  const out = await registry.search.search({ query: 'q' })
  assert.match(out.sources[0].publishedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(out.sources[0].snippet.length <= 401)
})

/* -------------------------------------------------- shared search knobs -- */

await check('shared options reach tavily as its own parameters', async () => {
  stubFetch(() => json(TAVILY))
  const { registry, route } = harness({
    ...KEYS,
    tavilyTopic: 'news',
    tavilySearchDepth: 'advanced',
    includeDomains: ['a.com'],
    excludeDomains: ['b.com'],
  })
  await registry.search.search({ query: 'q' })
  assert.equal(calls[0].body.topic, 'news')
  assert.equal(calls[0].body.search_depth, 'advanced')
  assert.equal(calls[0].body.include_published_date, true)
  assert.equal('include_answer' in calls[0].body, false)
  assert.equal(calls[0].body.max_results, 5)
  // A providers patch is ignored now: those knobs are no longer a surface.
  await call(route, { method: 'POST', body: { providers: { tavily: { searchDepth: 'fast' } } } })
  await registry.search.search({ query: 'q' })
  assert.equal(calls.at(-1).body.search_depth, 'advanced')
  assert.deepEqual(calls[0].body.include_domains, ['a.com'])
  assert.deepEqual(calls[0].body.exclude_domains, ['b.com'])
})

await check('the same shared options reach exa as ITS parameters', async () => {
  stubFetch(() => json({ results: [] }))
  const { registry, route } = harness({ ...KEYS, exaSearchType: 'lite', includeDomains: ['a.com'] })
  await call(route, { method: 'POST', body: { search: { backend: 'exa' } } })
  await registry.search.search({ query: 'q' })
  assert.equal(calls[0].url, 'https://api.exa.ai/search')
  assert.equal(calls[0].body.type, 'lite')
  assert.deepEqual(calls[0].body.includeDomains, ['a.com'])
})

await check('the same shared options reach firecrawl as ITS parameters', async () => {
  stubFetch(() => json({ success: true, data: { web: [] } }))
  const { registry, route } = harness({ ...KEYS, includeDomains: ['a.com'] })
  await call(route, { method: 'POST', body: { search: { backend: 'firecrawl' } } })
  await registry.search.search({ query: 'q' })
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search')
  assert.deepEqual(calls[0].body.includeDomains, ['a.com'])
})

/* ------------------------------------------------------ degrade + strict -- */

await check('results per query are fixed at five', async () => {
  stubFetch(() => json(TAVILY))
  const { registry } = harness(KEYS)
  await registry.search.search({ query: 'q', maxResults: 50 })
  assert.equal(calls[0].body.max_results, 5)
  await registry.search.search({ query: 'q', maxResults: 2 })
  assert.equal(calls.at(-1).body.max_results, 2)
})

await check('no backend is asked for an answer or per-result content', async () => {
  stubFetch(() => json(TAVILY))
  const tavily = harness(KEYS)
  const out = await tavily.registry.search.search({ query: 'q' })
  assert.equal('include_answer' in calls[0].body, false)
  assert.equal(out.content, undefined)

  stubFetch(() => json({ results: [] }))
  const exa = harness(KEYS)
  await call(exa.route, { method: 'POST', body: { search: { backend: 'exa' } } })
  await exa.registry.search.search({ query: 'q' })
  assert.equal('contents' in calls[0].body, false)
})

await check('an empty result set is reported to the model', async () => {
  stubFetch(() => json({ results: [] }))
  const { registry } = harness(KEYS)
  const out = await registry.search.search({ query: 'q' })
  assert.match(out.content, /returned no results/)
  assert.deepEqual(out.sources, [])
})

/* --------------------------------------------------------- error taxonomy -- */

await check('HTTP failures map to one taxonomy across vendors', async () => {
  const cases = [
    [401, 'WEB_PROVIDER_UNAUTHORIZED'],
    [402, 'WEB_PROVIDER_QUOTA_EXCEEDED'],
    [429, 'WEB_PROVIDER_RATE_LIMITED'],
    [503, 'WEB_PROVIDER_UPSTREAM'],
  ]
  for (const [status, code] of cases) {
    stubFetch(() => json({ error: 'nope' }, status))
    const { registry } = harness(KEYS)
    await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
      assert.equal(error.code, code, `HTTP ${status}`)
      return true
    })
  }
})

await check('an unreachable vendor differs from a bad key', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const { registry } = harness(KEYS)
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_UNREACHABLE')
    return true
  })
})

await check('missing credentials stay distinct and actionable', async () => {
  const { registry } = harness({ tavilyApiKeyEnv: 'ABSENT_REF' }, { credentials: fakeCredentials({}) })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    assert.match(error.message, /ABSENT_REF/)
    return true
  })
})

/* ----------------------------------------------------------------- fetch -- */

await check('firecrawl pages are text with metadata mapped', async () => {
  stubFetch(() => json({ success: true, data: { markdown: '# Hi', metadata: { statusCode: 200, url: 'https://final.test/p' } } }))
  const { registry } = harness(KEYS)
  const out = await registry.fetch.fetch({ url: 'https://example.com/a' })
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/scrape')
  assert.equal(out.body.kind, 'text')
  assert.equal(out.url, 'https://final.test/p')
})

await check('a failing backend degrades and says so', async () => {
  stubFetch((url) => (url.includes('firecrawl.dev') ? json({ success: false, error: 'quota' }, 402) : html('<html>local</html>')))
  const { registry } = harness(KEYS)
  const out = await registry.fetch.fetch({ url: 'https://example.com/page' })
  assert.equal(calls.length, 2)
  assert.match(out.body.content, /local/)
  assert.match(out.body.content, /> provider notice: fell back to a direct HTTP fetch: WEB_PROVIDER_QUOTA_EXCEEDED/)
})

await check('the fallback switch is honoured', async () => {
  stubFetch(() => json({ success: false, error: 'quota' }, 402))
  const { registry } = harness({ ...KEYS, fallbackToHttp: false })
  await assert.rejects(registry.fetch.fetch({ url: 'https://example.com/page' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_QUOTA_EXCEEDED')
    return true
  })
})

/* --------------------------------------------------------- fallback chain -- */

await check('a rate-limited vendor hands over to the next one and says so', async () => {
  stubFetch((url) =>
    url.includes('tavily')
      ? json({ detail: { error: 'rate limited' } }, 429)
      : json({ results: [{ title: 'E', url: 'https://e.test/1', text: 'from exa' }] }),
  )
  const { registry } = harness({ ...KEYS, searchFallbackOrder: ['exa'] })
  const out = await registry.search.search({ query: 'q' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.tavily.com/search')
  assert.equal(calls[1].url, 'https://api.exa.ai/search')
  assert.equal(out.sources[0].url, 'https://e.test/1')
  assert.match(out.content, /> provider notice: fell back to exa after tavily WEB_PROVIDER_RATE_LIMITED/)
})

await check('a bad request is not retried on another vendor', async () => {
  stubFetch(() => json({ detail: 'bad' }, 400))
  const { registry } = harness({ ...KEYS, searchFallbackOrder: ['exa'] })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_BAD_REQUEST')
    return true
  })
  assert.equal(calls.length, 1, 'a 400 must not fan out to the fallback vendors')
})

await check('an aborted call ends the chain instead of retrying', async () => {
  stubFetch(() => json(TAVILY))
  const { registry } = harness({ ...KEYS, searchFallbackOrder: ['exa'] })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(registry.search.search({ query: 'q' }, controller.signal), (error) => {
    assert.equal(error.code, 'WEB_ABORTED')
    return true
  })
  assert.equal(calls.length, 0, 'an already-aborted call must not reach the network at all')
})

await check('vendors that are cooling down are skipped, not hammered', async () => {
  stubFetch(() => json({ detail: 'slow down' }, 429))
  const { registry, route } = harness({ ...KEYS, searchFallbackOrder: ['exa'] })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_RATE_LIMITED')
    return true
  })
  assert.equal(calls.length, 2, 'both vendors were tried once')

  const cooling = await call(route, {})
  assert.equal(cooling.payload.fallback.cooling.length, 2)
  assert.equal(cooling.payload.fallback.budgetMs, 60000)

  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.match(error.message, /every search backend is cooling down: tavily \d+s \(WEB_PROVIDER_RATE_LIMITED\), exa \d+s/)
    return true
  })
  assert.equal(calls.length, 2, 'a cooling vendor must not reach the network again')
})

/* ----------------------------------------------------------------- state -- */

await check('GET exposes the two layers and the key state', async () => {
  const { route } = harness({})
  const { payload } = await call(route, {})
  assert.equal(payload.search.backend, 'tavily')
  assert.equal(payload.fetch.backend, 'firecrawl')
  assert.equal(payload.providers, undefined)
  assert.equal(payload.keys.tavily.configured, false)
})

await check('POST persists the two layers and a restart picks them up', async () => {
  const { route } = harness({})
  const out = await call(route, {
    method: 'POST',
    body: {
      search: { backend: 'exa' },
      fetch: { backend: 'tavily' },
    },
  })
  assert.equal(out.payload.persistence.persisted, true)
  const stored = JSON.parse(readFileSync(join(SANDBOX, 'web-tool-provider', 'state.json'), 'utf8'))
  assert.equal(stored.search.backend, 'exa')
  assert.equal(stored.fetch.backend, 'tavily')
  assert.equal(stored.providers, undefined)

  const restarted = harness({})
  const snapshot = await call(restarted.route, {})
  assert.equal(snapshot.payload.search.backend, 'exa')
  assert.equal(snapshot.payload.fetch.backend, 'tavily')
})

await check('vendor defaults still come from Config, not from the page', async () => {
  stubFetch(() => json(TAVILY))
  const { registry } = harness({
    ...KEYS,
    tavilyBaseURL: 'https://gateway.test/tavily/',
    tavilySearchDepth: 'advanced',
    tavilyTopic: 'finance',
  })
  await registry.search.search({ query: 'q' })
  assert.equal(calls[0].url, 'https://gateway.test/tavily/search')
  assert.equal(calls[0].body.search_depth, 'advanced')
  assert.equal(calls[0].body.topic, 'finance')
})

await check('keys go through the credential service, never the state file', async () => {
  const credentials = fakeCredentials({})
  const { route } = harness({}, { credentials })
  const saved = await call(route, { method: 'POST', body: { setKey: { vendor: 'exa', value: 'exa-new' } } })
  assert.equal(saved.payload.keys.exa.configured, true)
  assert.deepEqual(credentials.writes[0], ['set', 'EXA_API_KEY', 'exa-new'])
  await call(route, { method: 'POST', body: { clearKey: { vendor: 'exa' } } })
  assert.deepEqual(credentials.writes[1], ['unset', 'EXA_API_KEY'])
})

await check('credits: tavily is a limit minus usage, firecrawl is direct, exa is unsupported', async () => {
  stubFetch((url) => {
    if (url.includes('/usage')) return json({ key: { usage: 150 }, account: { plan_usage: 500, plan_limit: 15000, current_plan: 'Bootstrap' } })
    if (url.includes('/team/credit-usage')) return json({ success: true, data: { remainingCredits: 42000, planCredits: 500000 } })
    throw new Error(`unexpected credits URL ${url}`)
  })
  const { creditsRoute } = harness(KEYS)

  const tavily = await call(creditsRoute, { url: '/web-tool-provider/credits?vendor=tavily' })
  assert.equal(tavily.status, 200)
  assert.equal(tavily.payload.remaining, 14500)
  assert.equal(tavily.payload.limit, 15000)

  const firecrawl = await call(creditsRoute, { url: '/web-tool-provider/credits?vendor=firecrawl' })
  assert.equal(firecrawl.payload.remaining, 42000)

  const before = calls.length
  const exa = await call(creditsRoute, { url: '/web-tool-provider/credits?vendor=exa' })
  assert.equal(exa.payload.supported, false)
  assert.equal(calls.length, before, 'exa must not reach the network')

  const bogus = await call(creditsRoute, { url: '/web-tool-provider/credits?vendor=nope' })
  assert.equal(bogus.status, 400)
})

await check('the state route refuses a foreign origin', async () => {
  const { route } = harness({})
  assert.equal((await call(route, { origin: 'https://evil.test' })).status, 403)
})

await check('the form lives on the Plugins page under the bundle package name', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // Stand in for the browser seams the module touches at load time: the module
  // loader hands back the definition, React is only reached through
  // createElement (nothing renders here), and the primitives package is the one
  // dependency allowed to be missing.
  const stubRequire = (id) => {
    if (id !== 'react') throw new Error(`unexpected require: ${id}`)
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useMemo: (factory) => factory(),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useCallback: (callback) => callback,
      useRef: (initial) => ({ current: initial }),
      useEffect: () => {},
    }
  }

  let definition
  new Function('window', 'require', source)(
    { __ModuleLoader__: { load: (value) => (definition = value) } },
    stubRequire,
  )
  assert.equal(definition.id, pkg.name)

  const injected = []
  const registered = []
  definition.factory(stubRequire).apply({
    slots: {
      inject: (name, register) => (injected.push(name), register()),
      register: (options, component) => (registered.push({ options, component }), () => {}),
    },
  })

  // The Plugins page declares `plugins.bundle.config` keyed by package name; a
  // settings tab would land in Settings instead, which is what this replaced.
  assert.deepEqual(injected, ['plugins.bundle.config'])
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'plugins.bundle.config')
  assert.equal(options.key, pkg.name, 'the key must be the bundle package name')
  assert.equal(component({ view: 'summary' }), null, 'only the full page carries the form')
  assert.equal(typeof component({ view: 'page', ctx: {} }).type, 'function')
})

await check('the bundle patch mounts this package so the Plugins page can list it', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const quoted = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(patch, new RegExp(`name: '${quoted}'`), 'the inserted row must name this package')
})

await check('the profile row exports a Config form the settings service can render', async () => {
  const schema = mod.Config
  assert.equal(typeof schema.toJSON, 'function')
  assert.ok(Object.keys(schema.toJSON().refs).length > 0, 'a form needs a serialized schema')

  // Only fields a user owns carry the volatile marker: the settings service
  // refuses every other path, so an unmarked field cannot be edited from a form.
  const volatile = Object.entries(schema.dict)
    .filter(([, field]) => field.meta?.volatile === true)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(volatile, [
    'exaApiKey',
    'excludeDomains',
    'fallbackBudgetMs',
    'fallbackMaxBytes',
    'fallbackMaxChars',
    'fallbackMaxRedirects',
    'fallbackTimeoutMs',
    'fallbackToHttp',
    'fetchBackend',
    'fetchFallbackOrder',
    'firecrawlApiKey',
    'includeDomains',
    'searchBackend',
    'searchFallbackOrder',
    'tavilyApiKey',
  ])

  // Keys are form fields so the phone sheet can collect them, but they are
  // declared secret: the settings wire layer strips them from every response
  // and only reports whether each one is set.
  for (const key of ['tavilyApiKey', 'exaApiKey', 'firecrawlApiKey']) {
    assert.equal(schema.dict[key].meta?.volatile, true, `${key} must be a form field`)
    assert.equal(schema.dict[key].meta?.role, 'secret', `${key} must never leave the process`)
  }
  assert.equal(schema.dict.searchBackend.meta.default, 'tavily')
  assert.equal(schema.dict.fetchBackend.meta.default, 'firecrawl')
})

await check('a host with the settings service saves edits through the profile form', async () => {
  const updates = []
  const routes = []
  const value = { searchBackend: 'tavily', fetchBackend: 'firecrawl' }
  const settings = {
    documentPath: 'C:/profile/cordis.patch.yml',
    describe: () => [{ ns: 'web-tool-provider', value, revision: 4, user: {} }],
    update: async (ns, patch, revision) => updates.push({ ns, patch, revision }),
  }
  const ctx = {
    web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: () => undefined,
    loader: {
      entries: () => [{ options: { name: 'dsh-web-tool-provider', id: 'web-tool-provider' }, fiber: undefined }],
      await: () => Promise.resolve(),
    },
    effect: (callback) => (callback(), () => {}),
    inject: (names, callback) => callback({ settings }),
  }
  mod.apply(ctx, {})

  const result = await call(routes[0], { method: 'POST', body: { search: { backend: 'exa' } } })
  assert.equal(result.status, 200)
  assert.equal(updates.length, 1, 'the edit must reach the profile document')
  assert.equal(updates[0].ns, 'web-tool-provider')
  assert.equal(updates[0].revision, 4, 'the revision guards against a stale form')
  assert.equal(updates[0].patch.searchBackend, 'exa')
  // The settings service rejects non-volatile paths; shipping one in the patch
  // would make every save fail, so the writer only carries form fields.
  for (const key of Object.keys(updates[0].patch)) {
    assert.equal(mod.Config.dict[key].meta?.volatile, true, `${key} must be a form field`)
  }
  assert.equal(result.payload.persistence.location, 'C:/profile/cordis.patch.yml')
})

await check('a parsed Config snapshot (volatile references included) becomes plain defaults', async () => {
  // Cordis hands apply() the schema output, where every volatile field is a
  // cosmokit reference rather than a string. Reading it raw would hand those
  // wrappers to the provider layer.
  const parsed = mod.Config({
    searchBackend: 'exa',
    searchFallbackOrder: ['tavily'],
    fallbackBudgetMs: 45000,
    fallbackToHttp: false,
  })
  const { route } = harness(parsed)
  const result = await call(route, {})
  assert.equal(result.payload.search.backend, 'exa')
  assert.deepEqual(result.payload.search.fallbackOrder, ['tavily'])
  assert.equal(result.payload.fallback.budgetMs, 45000)
})

await check('the HTTP form reaches the same fields the native sheet does', async () => {
  const { route } = harness({})
  const result = await call(route, {
    method: 'POST',
    body: {
      fallback: { budgetMs: 55000, maxRedirects: 2 },
      search: { options: { includeDomains: ['Example.COM', 'https://a.test/x'] } },
      fetch: { options: { fallbackToHttp: false } },
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.fallback.budgetMs, 55000)
  const saved = JSON.parse(readFileSync(result.payload.persistence.location, 'utf8'))
  assert.equal(saved.fallback.budgetMs, 55000)
  assert.equal(saved.fallback.maxRedirects, 2)
  assert.deepEqual(saved.search.options.includeDomains, ['example.com', 'a.test'])
  assert.equal(saved.fetch.options.fallbackToHttp, false)
})

await check('a key typed on the desktop page reaches the same form the phone writes', async () => {
  const updates = []
  const routes = []
  const value = { searchBackend: 'tavily', fetchBackend: 'firecrawl' }
  const settings = {
    documentPath: 'C:/profile/cordis.patch.yml',
    describe: () => [{ ns: 'web-tool-provider', value, revision: 4, user: {} }],
    update: async (ns, patch, revision) => updates.push({ ns, patch, revision }),
  }
  const ctx = {
    web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: () => undefined,
    loader: {
      entries: () => [{ options: { name: 'dsh-web-tool-provider', id: 'web-tool-provider' }, fiber: undefined }],
      await: () => Promise.resolve(),
    },
    effect: (callback) => (callback(), () => {}),
    inject: (names, callback) => callback({ settings }),
  }
  mod.apply(ctx, {})

  // One store for both surfaces: the phone sheet edits `exaApiKey` in this
  // document, so the desktop page must write the same field instead of the
  // credentials service, or the two would silently disagree.
  const result = await call(routes[0], { method: 'POST', body: { setKey: { vendor: 'exa', value: 'exa-secret' } } })
  assert.equal(result.status, 200)
  assert.deepEqual(updates, [{ ns: 'web-tool-provider', patch: { exaApiKey: 'exa-secret' }, revision: 4 }])
})

await check('the same edit still lands in the state file without a settings service', async () => {
  const { route } = harness({})
  const result = await call(route, { method: 'POST', body: { fetch: { backend: 'exa' } } })
  assert.equal(result.status, 200)
  assert.equal(result.payload.persistence.persisted, true)
  const saved = JSON.parse(readFileSync(result.payload.persistence.location, 'utf8'))
  assert.equal(saved.fetch.backend, 'exa')
})

globalThis.fetch = originalFetch

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
