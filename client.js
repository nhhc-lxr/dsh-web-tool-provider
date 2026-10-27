window.__ModuleLoader__.load({
  id: 'dsh-web-tool-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The primitives ship with the desktop shell. A missing or renamed export
    // must never white-screen the settings page, so every control below has a
    // plain-element twin and the wrappers only pass props we have verified in
    // other plugins that use this package.
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch {
      primitives = {}
    }

    const ENDPOINT = '/web-tool-provider/state'
    const VENDORS = ['tavily', 'exa', 'firecrawl']
    const LABELS = { tavily: 'Tavily', exa: 'Exa', firecrawl: 'Firecrawl' }
    const labelOf = (vendor) => LABELS[vendor] || vendor

    const DICT = {
      en: {
        tab: 'Web tools',
        title: 'Web tool provider',
        subtitle: 'One backend serves both web_search and web_fetch. When it fails, the next vendor in the chain is tried.',
        backends: 'Backends',
        searchBackend: 'web_search',
        fetchBackend: 'web_fetch',
        fallback: 'Fallback',
        fallbackNone: 'none',
        chain: 'chain',
        cooling: 'cooling down',
        keys: 'API keys',
        save: 'Save',
        clear: 'Clear',
        edit: 'Edit',
        cancel: 'Cancel',
        saved: 'Saved',
        cleared: 'Cleared',
        localOnly: 'Applied now, but not persisted: ',
        configured: 'configured',
        fromEnv: 'from environment',
        fromConfig: 'from plugin config',
        missing: 'not configured',
        loading: 'Loading…',
        loadFailed: 'Could not read the plugin state: ',
        keyPlaceholder: 'Paste the key',
        creditsLoading: 'checking…',
        creditsLeft: 'left',
        creditsUsed: 'used',
        creditsFailed: 'quota lookup failed',
        creditsUnsupported: 'no quota API',
      },
      zh: {
        tab: '网页工具',
        title: '网页工具后端',
        subtitle: '一个后端同时服务 web_search 与 web_fetch；失败时自动按顺序换下一个。',
        backends: '后端选择',
        searchBackend: 'web_search',
        fetchBackend: 'web_fetch',
        fallback: '自动回退',
        fallbackNone: '无',
        chain: '顺序',
        cooling: '冷却中',
        keys: 'API 密钥',
        save: '保存',
        clear: '清除',
        edit: '编辑',
        cancel: '取消',
        saved: '已保存',
        cleared: '已清除',
        localOnly: '已生效，但未能持久化：',
        configured: '已配置',
        fromEnv: '来自环境变量',
        fromConfig: '来自插件配置',
        missing: '未配置',
        loading: '加载中…',
        loadFailed: '读取插件状态失败：',
        keyPlaceholder: '粘贴密钥',
        creditsLoading: '查询中…',
        creditsLeft: '剩余',
        creditsUsed: '已用',
        creditsFailed: '额度查询失败',
        creditsUnsupported: '无额度接口',
      },
    }

    function pickLanguage(ctx) {
      const candidates = []
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
        if (typeof snapshot === 'string') candidates.push(snapshot)
        else if (snapshot) candidates.push(snapshot.locale, snapshot.id, snapshot.current, snapshot.language)
        const live = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        if (live && typeof live === 'object') candidates.push(live.locale, live.id, live.current, live.language)
      } catch {
        /* locale service unavailable: fall back to the document */
      }
      try {
        candidates.push(document.documentElement.getAttribute('lang'), navigator.language)
      } catch {
        /* not a browser */
      }
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.toLowerCase().startsWith('zh')) return 'zh'
      }
      return 'en'
    }

    function createTranslate(ctx) {
      const language = pickLanguage(ctx)
      const dict = DICT[language] || DICT.en
      return (key) => dict[key] || DICT.en[key] || key
    }

    /* ------------------------------------------------------------- styles -- */

    const styles = {
      page: { padding: '4px 0 28px', maxWidth: 720, color: 'var(--dsw-alias-label-primary)' },
      title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' },
      subtitle: {
        margin: '4px 0 16px',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px 16px',
        marginBottom: 12,
      },
      cardTitle: {
        margin: '0 0 12px',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary)',
        textTransform: 'uppercase',
      },
      block: { display: 'grid', gap: 8, padding: '8px 0' },
      blockDivider: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
      row: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 32 },
      label: { flex: '0 0 96px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, monospace' },
      control: { flex: '1 1 auto', minWidth: 0 },
      subrow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 108 },
      caption: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      chain: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, monospace' },
      cooling: { margin: '4px 0 0', paddingLeft: 108, fontSize: 11, color: 'var(--dsw-alias-state-warning-primary)' },
      keyRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1.3fr) auto',
        alignItems: 'center',
        gap: 12,
        minHeight: 40,
        padding: '4px 0',
      },
      keyIdent: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      vendor: { fontSize: 12, fontWeight: 600 },
      keyStatus: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      keyBody: { display: 'flex', alignItems: 'center', minWidth: 0 },
      keyActions: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' },
      credits: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      note: { margin: '8px 0 0', fontSize: 12, lineHeight: 1.6 },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      empty: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    }

    /* ---------------------------------------------------------- controls -- */

    const fallbackButtonStyle = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 28,
      padding: '0 12px',
      fontSize: 12,
      borderRadius: 7,
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)',
    }

    function Button({ variant, size, disabled, onClick, children }) {
      if (primitives.Button) {
        return h(primitives.Button, { variant, size, disabled, onClick }, children)
      }
      const style = disabled === true ? { ...fallbackButtonStyle, opacity: 0.5, cursor: 'default' } : fallbackButtonStyle
      return h('button', { type: 'button', disabled, onClick, style }, children)
    }

    function Input({ value, placeholder, type, disabled, autoComplete, onChange }) {
      if (primitives.Input) {
        return h(primitives.Input, { value, placeholder, type, disabled, autoComplete, onChange })
      }
      return h('input', {
        value,
        placeholder,
        type,
        disabled,
        autoComplete,
        spellCheck: false,
        onChange,
        style: {
          ...fallbackButtonStyle,
          height: 28,
          padding: '0 9px',
          width: '100%',
          cursor: 'text',
          background: 'var(--dsw-alias-bg-base)',
        },
      })
    }

    /** Segmented choice for the active backend; falls back to a native select. */
    function Segmented({ label, value, options, onChange }) {
      // The primitive hands back the chosen value, a native select hands back
      // the event: unwrap both so callers always see a vendor id.
      const pick = (payload) => onChange(typeof payload === 'string' ? payload : payload?.target?.value)
      if (primitives.SegmentedControl) {
        return h(primitives.SegmentedControl, { label, value, options, onChange: pick })
      }
      return h(
        'select',
        {
          value,
          'aria-label': label,
          onChange: pick,
          style: {
            ...fallbackButtonStyle,
            height: 28,
            padding: '0 8px',
            cursor: 'pointer',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function Pill({ active, onClick, children }) {
      if (primitives.Pill) return h(primitives.Pill, { active, onClick }, children)
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            ...fallbackButtonStyle,
            height: 24,
            padding: '0 10px',
            borderRadius: 999,
            ...(active
              ? { border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' }
              : { color: 'var(--dsw-alias-label-secondary)' }),
          },
        },
        children,
      )
    }

    const dotColors = {
      done: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warning: 'var(--dsw-alias-state-warning-primary)',
      ongoing: 'var(--dsw-alias-brand-primary)',
    }

    function StateDot({ state, size = 8 }) {
      if (primitives.StateDot) return h(primitives.StateDot, { state, size })
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block',
          flex: '0 0 auto',
          width: size,
          height: size,
          borderRadius: 999,
          background: dotColors[state] || 'var(--dsw-alias-label-secondary)',
        },
      })
    }

    /* ------------------------------------------------------------- data -- */

    async function readState() {
      const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function writeState(body) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    const clone = (value) => JSON.parse(JSON.stringify(value))
    const formatNumber = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

    function creditsText(t, entry) {
      if (!entry || entry.status === 'loading') return t('creditsLoading')
      if (entry.status === 'error') return t('creditsFailed')
      if (entry.supported === false) return t('creditsUnsupported')
      if (entry.remaining !== undefined && entry.limit !== undefined) {
        return `${t('creditsLeft')} ${formatNumber(entry.remaining)} / ${formatNumber(entry.limit)}`
      }
      if (entry.used !== undefined) return `${t('creditsUsed')} ${formatNumber(entry.used)}`
      return '—'
    }

    function keyStatusText(t, key) {
      if (!key || key.configured !== true) return t('missing')
      if (key.source === 'env') return `${t('configured')} · ${t('fromEnv')}`
      if (key.source === 'config') return `${t('configured')} · ${t('fromConfig')}`
      return t('configured')
    }

    const orderOf = (state, kind) => {
      const list = state && state[kind] && state[kind].fallbackOrder
      return Array.isArray(list) ? list.filter((vendor) => VENDORS.includes(vendor)) : []
    }

    const chainOf = (state, kind) => {
      const backend = state && state[kind] ? state[kind].backend : undefined
      return [backend, ...orderOf(state, kind).filter((vendor) => vendor !== backend)].filter(
        (vendor) => VENDORS.includes(vendor),
      )
    }

    function ProviderPage(props) {
      const ctx = props.ctx
      const t = React.useMemo(() => createTranslate(ctx), [ctx])
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [draftKeys, setDraftKeys] = React.useState({})
      const [editingKeys, setEditingKeys] = React.useState({})
      const [credits, setCredits] = React.useState({})

      const stateRef = React.useRef(null)
      const timerRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await readState()
          stateRef.current = payload
          setState(payload)
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      React.useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        },
        [],
      )

      const loadCredits = React.useCallback(async (vendor) => {
        setCredits((current) => ({ ...current, [vendor]: { status: 'loading' } }))
        try {
          const response = await fetch(`${ENDPOINT.replace('/state', '/credits')}?vendor=${vendor}`, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json().catch(() => ({}))
          setCredits((current) => ({
            ...current,
            [vendor]: response.ok ? { status: 'ok', ...payload } : { status: 'error' },
          }))
        } catch {
          setCredits((current) => ({ ...current, [vendor]: { status: 'error' } }))
        }
      }, [])

      const askedRef = React.useRef({})
      React.useEffect(() => {
        if (!state) return
        for (const vendor of VENDORS) {
          const key = state.keys && state.keys[vendor]
          if (key && key.configured && askedRef.current[vendor] !== true) {
            askedRef.current[vendor] = true
            loadCredits(vendor)
          }
        }
      }, [state, loadCredits])

      /** Auto-save: keep local edits, only refresh the fields the host owns. */
      const commit = React.useCallback(
        async (body) => {
          try {
            const payload = await writeState(body)
            setError('')
            setState((current) => (current ? { ...current, keys: payload.keys || current.keys } : current))
            if (payload.persistence && payload.persistence.persisted === false) {
              setNotice(`${t('localOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t('saved'))
            }
          } catch (cause) {
            setError(String(cause && cause.message ? cause.message : cause))
          }
        },
        [t],
      )

      const edit = (mutate) => {
        const next = clone(stateRef.current)
        mutate(next)
        stateRef.current = next
        setState(next)
        return next
      }

      const setBackend = (kind, vendor) => {
        const next = edit((draft) => {
          draft[kind].backend = vendor
          draft[kind].fallbackOrder = orderOf(draft, kind).filter((entry) => entry !== vendor)
        })
        commit({ [kind]: { backend: vendor, fallbackOrder: next[kind].fallbackOrder } })
      }

      const toggleFallback = (kind, vendor) => {
        const current = orderOf(stateRef.current, kind)
        const next = current.includes(vendor) ? current.filter((entry) => entry !== vendor) : [...current, vendor]
        edit((draft) => {
          draft[kind].fallbackOrder = next
        })
        commit({ [kind]: { fallbackOrder: next } })
      }

      const applyKeys = React.useCallback(
        async (body, kind) => {
          setBusy(true)
          setNotice('')
          try {
            const payload = await writeState(body)
            stateRef.current = payload
            setState(payload)
            setError('')
            if (payload.persistence && payload.persistence.persisted === false) {
              setNotice(`${t('localOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t(kind))
            }
            const touched = body.setKey ? body.setKey.vendor : body.clearKey ? body.clearKey.vendor : undefined
            if (body.setKey) setDraftKeys((current) => ({ ...current, [body.setKey.vendor]: '' }))
            if (touched !== undefined) setEditingKeys((current) => ({ ...current, [touched]: false }))
          } catch (cause) {
            setError(String(cause && cause.message ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        },
        [t],
      )

      if (state === null && error === '') {
        return h('div', { style: styles.page }, h('p', { style: styles.empty }, t('loading')))
      }
      if (state === null) {
        return h('div', { style: styles.page }, h('p', { style: styles.error }, `${t('loadFailed')}${error}`))
      }

      const backendBlock = (kind, nameKey) => {
        const chain = chainOf(state, kind)
        const primary = state[kind] ? state[kind].backend : chain[0]
        const options = VENDORS.map((vendor) => ({ value: vendor, label: labelOf(vendor) }))
        const candidates = VENDORS.filter((vendor) => vendor !== primary)
        return h(
          'div',
          { style: styles.block },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t(nameKey)),
            h(
              'div',
              { style: styles.control },
              h(Segmented, {
                label: t(nameKey),
                value: primary,
                options,
                onChange: (vendor) => setBackend(kind, vendor),
              }),
            ),
          ),
          h(
            'div',
            { style: styles.subrow },
            h('span', { style: styles.caption }, t('fallback')),
            candidates.map((vendor) =>
              h(
                Pill,
                { key: vendor, active: orderOf(state, kind).includes(vendor), onClick: () => toggleFallback(kind, vendor) },
                labelOf(vendor),
              ),
            ),
            h('span', { style: styles.chain }, `${t('chain')}: ${chain.map(labelOf).join(' → ')}`),
          ),
        )
      }

      const cooling = (state.fallback && Array.isArray(state.fallback.cooling) ? state.fallback.cooling : []).map(
        (entry) => {
          const seconds = Math.max(1, Math.round((entry.remainingMs || 0) / 1000))
          return `${labelOf(entry.vendor)} ${seconds}s (${entry.code})`
        },
      )

      const keyRows = VENDORS.map((vendor) => {
        const key = (state.keys && state.keys[vendor]) || {}
        const draft = draftKeys[vendor] === undefined ? '' : draftKeys[vendor]
        const configured = Boolean(key.configured)
        const editing = editingKeys[vendor] === true || !configured
        const actions = []

        if (editing) {
          actions.push(
            h(
              Button,
              {
                key: 'save',
                size: 'sm',
                variant: 'primary',
                disabled: busy || draft.trim() === '',
                onClick: () => applyKeys({ setKey: { vendor, value: draft.trim() } }, 'saved'),
              },
              t('save'),
            ),
          )
          if (configured) {
            actions.push(
              h(
                Button,
                {
                  key: 'cancel',
                  size: 'sm',
                  variant: 'outline',
                  onClick: () => setEditingKeys((current) => ({ ...current, [vendor]: false })),
                },
                t('cancel'),
              ),
            )
          }
        } else {
          actions.push(
            h(
              Button,
              {
                key: 'edit',
                size: 'sm',
                variant: 'outline',
                onClick: () => setEditingKeys((current) => ({ ...current, [vendor]: true })),
              },
              t('edit'),
            ),
            h(
              Button,
              {
                key: 'clear',
                size: 'sm',
                variant: 'outline',
                disabled: busy,
                onClick: () => applyKeys({ clearKey: { vendor } }, 'cleared'),
              },
              t('clear'),
            ),
          )
        }

        return h(
          'div',
          { key: vendor, style: styles.keyRow },
          h(
            'div',
            { style: styles.keyIdent },
            h(StateDot, { state: configured ? 'done' : 'error', size: 8 }),
            h('span', { style: styles.vendor }, labelOf(vendor)),
            h('span', { style: styles.keyStatus }, keyStatusText(t, key)),
          ),
          h(
            'div',
            { style: styles.keyBody },
            editing
              ? h(Input, {
                  key: 'input',
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: `${t('keyPlaceholder')} (${key.ref || vendor})`,
                  value: draft,
                  disabled: busy,
                  onChange: (event) => setDraftKeys({ ...draftKeys, [vendor]: event.target.value }),
                })
              : h('span', { key: 'credits', style: styles.credits }, creditsText(t, credits[vendor])),
          ),
          h('div', { style: styles.keyActions }, ...actions),
        )
      })

      return h(
        'div',
        { style: styles.page },
        h('h2', { style: styles.title }, t('title')),
        h('p', { style: styles.subtitle }, t('subtitle')),
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('backends')),
          backendBlock('search', 'searchBackend'),
          h('div', { style: styles.blockDivider }),
          backendBlock('fetch', 'fetchBackend'),
          cooling.length === 0
            ? null
            : h('p', { style: styles.cooling }, `${t('cooling')}: ${cooling.join(' · ')}`),
        ),
        h('div', { style: styles.card }, h('h3', { style: styles.cardTitle }, t('keys')), ...keyRows),
        notice === '' ? null : h('p', { style: { ...styles.note, ...styles.ok } }, notice),
        error === '' ? null : h('p', { style: { ...styles.note, ...styles.error } }, error),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'web-tool-provider',
              order: 65,
              label: () => createTranslate(ctx)('tab'),
            },
            (props) => h(ProviderPage, { ...props, ctx }),
          ),
        )
      },
    }
  },
})
