window.__ModuleLoader__.load({
  id: 'dsh-plugin-hop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MUTED = 'var(--dsw-alias-label-secondary)'
    const TEXT = 'var(--dsw-alias-label-primary)'
    const BORDER = 'var(--dsw-alias-border-l1)'
    const BRAND = 'var(--dsw-alias-brand-primary)'

    async function api(name, init) {
      const response = await fetch(`api/hop/${name}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init
      })
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { ok: false, error: text || `HTTP ${response.status}` }
      }
      if (!response.ok) throw new Error(data.error || text || `HTTP ${response.status}`)
      if (data && data.ok === false) throw new Error(data.error || '请求失败')
      return data
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function HopIcon({ size, active }) {
      const color = active ? BRAND : MUTED
      const edge = Math.max(12, size || 18)
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2.2, y: 4.2, width: 8.6, height: 6.8, rx: 1.8, stroke: color, strokeWidth: 1.7 }),
        h('rect', { x: 13.2, y: 4.2, width: 8.6, height: 6.8, rx: 1.8, stroke: color, strokeWidth: 1.7 }),
        h('path', { d: 'M7 13.5v2.2h10v-2.2', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M9.6 18.4 12 20.6l2.4-2.2', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })
      )
    }

    const button = (extra) => ({
      border: `1px solid ${BORDER}`,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: TEXT,
      borderRadius: 8,
      padding: '6px 12px',
      fontSize: 13,
      cursor: 'pointer',
      lineHeight: 1.4,
      ...extra
    })

    function Panel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [flash, setFlash] = React.useState(null)
      const [relayInput, setRelayInput] = React.useState('')
      const [editing, setEditing] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const data = await api('state')
          setState(data)
          setError(data.error || '')
          if (!relayInput && data.relay) setRelayInput(data.relay)
        } catch (problem) {
          setError(String(problem && problem.message ? problem.message : problem))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const save = async () => {
        const relay = relayInput.trim()
        if (!relay) return
        setBusy('setup')
        setFlash(null)
        try {
          const result = await api('setup', { method: 'POST', body: JSON.stringify({ relay }) })
          setFlash({ kind: 'ok', text: result.text })
          setEditing(false)
          await load()
        } catch (problem) {
          setFlash({ kind: 'error', text: String(problem && problem.message ? problem.message : problem) })
        } finally {
          setBusy('')
        }
      }

      const pullProject = async (project) => {
        setBusy(project.id)
        setFlash({ kind: 'info', text: `正在下载 ${project.name}…大仓库第一次会慢一点` })
        try {
          const started = await api('pull', { method: 'POST', body: JSON.stringify({ project: project.name }) })
          for (let tick = 0; tick < 1200; tick += 1) {
            await sleep(1500)
            const job = await api(`job?id=${encodeURIComponent(started.jobId)}`)
            if (job.status === 'running') continue
            setFlash({ kind: job.status === 'done' ? 'ok' : 'error', text: job.text })
            break
          }
          await load()
        } catch (problem) {
          setFlash({ kind: 'error', text: String(problem && problem.message ? problem.message : problem) })
        } finally {
          setBusy('')
        }
      }

      const projects = (state && state.projects) || []

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: 'var(--dsw-alias-bg-base)',
            color: TEXT,
            padding: '28px 32px 56px'
          }
        },
        h(
          'div',
          { style: { maxWidth: 780, margin: '0 auto' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 } },
            h('div', { style: { fontSize: 20, fontWeight: 600 } }, '跨机接力'),
            h('div', { style: { flex: 1 } }),
            h(
              'button',
              { style: button({ opacity: busy ? 0.6 : 1 }), onClick: () => !busy && load(), disabled: Boolean(busy) },
              '刷新'
            ),
            h('button', { style: button(), onClick: () => setEditing((value) => !value) }, editing ? '收起' : '设置仓库')
          ),
          h(
            'div',
            { style: { color: MUTED, fontSize: 13, marginBottom: 18 } },
            state && state.relay ? state.relay : '还没有配置接力仓库'
          ),
          editing || !(state && state.configured)
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    gap: 8,
                    marginBottom: 20,
                    padding: 14,
                    border: `1px solid ${BORDER}`,
                    borderRadius: 10,
                    background: 'var(--dsw-alias-bg-layer-1)'
                  }
                },
                h('input', {
                  value: relayInput,
                  onChange: (event) => setRelayInput(event.target.value),
                  placeholder: 'git@github.com:you/dsh-hop-myrepo.git',
                  spellCheck: false,
                  style: {
                    flex: 1,
                    minWidth: 0,
                    border: `1px solid ${BORDER}`,
                    borderRadius: 8,
                    background: 'var(--dsw-alias-bg-base)',
                    color: TEXT,
                    padding: '7px 10px',
                    fontSize: 13,
                    outline: 'none'
                  }
                }),
                h(
                  'button',
                  { style: button({ borderColor: BRAND, color: BRAND }), onClick: save, disabled: Boolean(busy) },
                  busy === 'setup' ? '保存中…' : '保存'
                )
              )
            : null,
          error
            ? h(
                'div',
                {
                  style: {
                    marginBottom: 16,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: `1px solid var(--dsw-alias-state-error-primary)`,
                    color: 'var(--dsw-alias-state-error-primary)',
                    fontSize: 13,
                    whiteSpace: 'pre-wrap'
                  }
                },
                error
              )
            : null,
          state && state.configured && projects.length === 0 && !error
            ? h('div', { style: { color: MUTED, fontSize: 13 } }, '仓库里还没有项目。在任意项目里运行 /hop push 就会加进来。')
            : null,
          projects.map((project) =>
            h(
              'div',
              {
                key: project.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 16px',
                  marginBottom: 10,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 12,
                  background: 'var(--dsw-alias-bg-layer-1)'
                }
              },
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 550 } },
                  h(
                    'span',
                    {
                      style: {
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: project.downloaded ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'
                      }
                    }
                  ),
                  project.name
                ),
                h(
                  'div',
                  { style: { color: MUTED, fontSize: 12, marginTop: 4 } },
                  `${project.sessions || 0} 个会话 · ${project.attachments || 0} 个附件${project.updatedAt ? ` · ${String(project.updatedAt).slice(0, 16).replace('T', ' ')}` : ''}`
                ),
                project.localPath
                  ? h(
                      'div',
                      { style: { color: MUTED, fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      project.localPath
                    )
                  : null
              ),
              h(
                'button',
                {
                  style: button(busy === project.id ? { opacity: 0.6 } : {}),
                  disabled: Boolean(busy),
                  onClick: () => pullProject(project)
                },
                busy === project.id ? '下载中…' : project.downloaded ? '更新' : '下载'
              )
            )
          ),
          flash
            ? h(
                'div',
                {
                  style: {
                    marginTop: 16,
                    padding: '12px 14px',
                    borderRadius: 10,
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    border: `1px solid ${
                      flash.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : BORDER
                    }`,
                    color: flash.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : TEXT,
                    background: 'var(--dsw-alias-bg-layer-2)'
                  }
                },
                flash.text
              )
            : null
        )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'hop', order: 20, label: '接力' },
            HopIcon
          )
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'hop' }, Panel)
        )
      }
    }
  }
})
