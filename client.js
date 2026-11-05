window.__ModuleLoader__.load({
  id: 'dsh-plugin-hop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MUTED = 'var(--dsw-alias-label-secondary)'
    const TEXT = 'var(--dsw-alias-label-primary)'
    const BORDER = 'var(--dsw-alias-border-l1)'
    const BRAND = 'var(--dsw-alias-brand-primary)'
    const ERROR = 'var(--dsw-alias-state-error-primary)'
    const OK = 'var(--dsw-alias-state-success-primary)'

    const PROVIDERS = {
      github: {
        label: 'GitHub',
        newRepo: 'https://github.com/new',
        sshKeys: 'https://github.com/settings/keys',
        tokens: 'https://github.com/settings/tokens',
        url: (protocol, user, repo) =>
          protocol === 'ssh' ? `git@github.com:${user}/${repo}.git` : `https://github.com/${user}/${repo}.git`,
        user: '你的 GitHub 用户名'
      },
      gitee: {
        label: 'Gitee',
        newRepo: 'https://gitee.com/projects/new',
        sshKeys: 'https://gitee.com/profile/sshkeys',
        tokens: 'https://gitee.com/profile/personal_access_tokens',
        url: (protocol, user, repo) =>
          protocol === 'ssh' ? `git@gitee.com:${user}/${repo}.git` : `https://gitee.com/${user}/${repo}.git`,
        user: '你的 Gitee 用户名'
      }
    }

    async function request(name, init) {
      const options = { credentials: 'same-origin', method: 'GET', ...(init || {}) }
      if (options.body) options.headers = { 'content-type': 'application/json' }
      const response = await fetch(`api/hop/${name}`, options)
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { ok: false, error: text || `HTTP ${response.status}` }
      }
      if (!response.ok) {
        data.ok = false
        const detail = data.error || text || ''
        data.error = detail ? `HTTP ${response.status}：${detail}` : `HTTP ${response.status}`
      }
      return data
    }

    async function api(name, init) {
      const data = await request(name, init)
      if (!data || data.ok === false) throw new Error((data && data.error) || '请求失败')
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
      padding: '7px 14px',
      fontSize: 13,
      cursor: 'pointer',
      lineHeight: 1.4,
      ...extra
    })

    const card = {
      border: `1px solid ${BORDER}`,
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: '18px 20px'
    }

    const inputStyle = {
      flex: 1,
      minWidth: 0,
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-base)',
      color: TEXT,
      padding: '8px 10px',
      fontSize: 13,
      outline: 'none'
    }

    function Field({ label, children, hint }) {
      return h(
        'div',
        { style: { marginBottom: 16 } },
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 6 } }, label),
        children,
        hint ? h('div', { style: { fontSize: 12, color: MUTED, marginTop: 6 } }, hint) : null
      )
    }

    function Segmented({ options, value, onChange }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 6 } },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              onClick: () => onChange(option.value),
              style: {
                border: `1px solid ${value === option.value ? BRAND : BORDER}`,
                background: value === option.value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: value === option.value ? BRAND : TEXT,
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 13,
                cursor: 'pointer'
              }
            },
            option.label
          )
        )
      )
    }

    function Panel() {
      const [doctor, setDoctor] = React.useState(null)
      const [projects, setProjects] = React.useState([])
      const [view, setView] = React.useState('loading')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [flash, setFlash] = React.useState(null)

      const [provider, setProvider] = React.useState('github')
      const [protocol, setProtocol] = React.useState('ssh')
      const [url, setUrl] = React.useState('')
      const [publicKey, setPublicKey] = React.useState('')
      const [showKey, setShowKey] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const [nextDoctor, state] = await Promise.all([request('doctor'), request('state')])
          setDoctor(nextDoctor)
          setProjects((state && state.projects) || [])
          if (nextDoctor && nextDoctor.relay) {
            setProvider(nextDoctor.provider === 'gitee' ? 'gitee' : 'github')
            setProtocol(nextDoctor.protocol === 'https' ? 'https' : 'ssh')
            setUrl((current) => current || nextDoctor.relay)
          }
          if (!nextDoctor || !nextDoctor.configured) setView('setup')
          else if (nextDoctor.reachable === false) setView('auth')
          else setView('list')
          setError((nextDoctor && nextDoctor.error) || (state && state.error) || '')
        } catch (problem) {
          setError(String(problem && problem.message ? problem.message : problem))
          setView('setup')
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const save = async () => {
        const relay = url.trim()
        if (!relay) {
          setFlash({ kind: 'error', text: '先填仓库地址' })
          return
        }
        setBusy('save')
        setFlash({ kind: 'info', text: '正在检测仓库…' })
        try {
          const result = await request(`setup?relay=${encodeURIComponent(relay)}`)
          if (result.ok) {
            setFlash({ kind: 'ok', text: result.text })
            await refresh()
          } else {
            setError(result.error || '连接失败')
            setFlash(null)
            setView(result.hint === 'auth' ? 'auth' : 'setup')
            if (result.hint !== 'auth') setFlash({ kind: 'error', text: result.error || '连接失败' })
          }
        } catch (problem) {
          setFlash({ kind: 'error', text: String(problem && problem.message ? problem.message : problem) })
        } finally {
          setBusy('')
        }
      }

      const makeKey = async () => {
        setBusy('key')
        try {
          const result = await request('ssh-key')
          if (result.ok) {
            setPublicKey(result.publicKey)
            setShowKey(true)
          } else {
            setFlash({ kind: 'error', text: result.error || '生成密钥失败' })
          }
        } catch (problem) {
          setFlash({ kind: 'error', text: String(problem && problem.message ? problem.message : problem) })
        } finally {
          setBusy('')
        }
      }

      const copyKey = async () => {
        try {
          await navigator.clipboard.writeText(publicKey)
          setFlash({ kind: 'ok', text: '公钥已复制，粘贴到平台的 SSH 设置页面即可' })
        } catch {
          setFlash({ kind: 'error', text: '复制失败，请手动选中复制' })
        }
      }

      const retest = async () => {
        setBusy('test')
        setFlash({ kind: 'info', text: '正在重新检测…' })
        await refresh()
        setBusy('')
        setFlash(null)
      }

      const pullProject = async (project) => {
        setBusy(project.id)
        setFlash({ kind: 'info', text: `正在下载 ${project.name}…` })
        try {
          const started = await api(`pull?project=${encodeURIComponent(project.name)}`)
          for (let tick = 0; tick < 1200; tick += 1) {
            await sleep(1500)
            const job = await api(`job?id=${encodeURIComponent(started.jobId)}`)
            if (job.status === 'running') continue
            setFlash({ kind: job.status === 'done' ? 'ok' : 'error', text: job.text })
            break
          }
          await refresh()
        } catch (problem) {
          setFlash({ kind: 'error', text: String(problem && problem.message ? problem.message : problem) })
        } finally {
          setBusy('')
        }
      }

      const meta = PROVIDERS[provider]

      const setupView = h(
        'div',
        null,
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '连接一个私有仓库'),
        h(
          'div',
          { style: { color: MUTED, fontSize: 13, marginBottom: 18 } },
          '它只保存会话和附件，不放代码。仓库必须是私有的。'
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, marginBottom: 18 } },
          Object.entries(PROVIDERS).map(([key, value]) =>
            h(
              'button',
              {
                key,
                onClick: () => setProvider(key),
                style: {
                  flex: 1,
                  border: `1px solid ${provider === key ? BRAND : BORDER}`,
                  background: provider === key ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                  color: provider === key ? BRAND : TEXT,
                  borderRadius: 10,
                  padding: '14px 16px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer'
                }
              },
              value.label
            )
          )
        ),
        h(
          'div',
          { style: { ...card, marginBottom: 16 } },
          h(
            Field,
            {
              label: '连接方式',
              hint: protocol === 'ssh' ? '推荐：配一次 SSH 密钥，之后不用输密码' : '用令牌代替密码，令牌交给系统钥匙串保存'
            },
            h(Segmented, {
              value: protocol,
              onChange: setProtocol,
              options: [
                { value: 'ssh', label: 'SSH（推荐）' },
                { value: 'https', label: 'HTTPS' }
              ]
            })
          ),
          h(
            Field,
            { label: '仓库地址' },
            h('input', {
              value: url,
              onChange: (event) => setUrl(event.target.value),
              placeholder: meta.url(protocol, meta.user, 'dsh-hop-myrepo'),
              spellCheck: false,
              style: inputStyle
            })
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 } },
            h(
              'a',
              {
                href: meta.newRepo,
                target: '_blank',
                rel: 'noreferrer',
                style: { color: BRAND, fontSize: 13, textDecoration: 'none' }
              },
              `还没有仓库？去 ${meta.label} 新建 ↗`
            ),
            h('div', { style: { flex: 1 } }),
            h(
              'button',
              { style: button({ borderColor: BRAND, color: BRAND }), onClick: save, disabled: Boolean(busy) },
              busy === 'save' ? '检测中…' : '保存并检测'
            )
          ),
          h(
            'div',
            { style: { fontSize: 12, color: MUTED, marginTop: 12, lineHeight: 1.6 } },
            '新建时把仓库设为 Private，名字随意（例如 dsh-hop-myrepo），创建完把地址复制到上面。'
          )
        )
      )

      const authView = h(
        'div',
        null,
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4, color: ERROR } }, '仓库连不上'),
        h(
          'div',
          { style: { fontSize: 13, color: MUTED, marginBottom: 14, whiteSpace: 'pre-wrap' } },
          error || '这台电脑还没有访问该仓库的凭据。'
        ),
        h(
          'div',
          { style: { ...card, marginBottom: 16 } },
          protocol === 'ssh'
            ? h(
                'div',
                null,
                h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, '配一把 SSH 密钥'),
                h(
                  'div',
                  { style: { fontSize: 13, color: MUTED, marginBottom: 12, lineHeight: 1.8 } },
                  h('div', null, '1. 点下面的按钮生成密钥（已经有会直接显示）'),
                  h('div', null, '2. 复制公钥，粘贴到平台的 SSH 设置页面'),
                  h('div', null, '3. 回来点「重新检测」')
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' } },
                  h(
                    'button',
                    { style: button({ borderColor: BRAND, color: BRAND }), onClick: makeKey, disabled: Boolean(busy) },
                    busy === 'key' ? '生成中…' : showKey ? '重新生成' : '生成 / 查看密钥'
                  ),
                  h(
                    'a',
                    {
                      href: meta.sshKeys,
                      target: '_blank',
                      rel: 'noreferrer',
                      style: { color: BRAND, fontSize: 13, textDecoration: 'none' }
                    },
                    `打开 ${meta.label} 的 SSH 设置 ↗`
                  )
                ),
                showKey && publicKey
                  ? h(
                      'div',
                      null,
                      h('textarea', {
                        readOnly: true,
                        value: publicKey,
                        rows: 3,
                        style: {
                          width: '100%',
                          boxSizing: 'border-box',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 12,
                          padding: 10,
                          borderRadius: 8,
                          border: `1px solid ${BORDER}`,
                          background: 'var(--dsw-alias-bg-base)',
                          color: TEXT,
                          resize: 'vertical'
                        }
                      }),
                      h('button', { style: button({ marginTop: 8 }), onClick: copyKey }, '复制公钥')
                    )
                  : null
              )
            : h(
                'div',
                null,
                h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, '配一个访问令牌'),
                h(
                  'div',
                  { style: { fontSize: 13, color: MUTED, lineHeight: 1.9 } },
                  h('div', null, '1. 在平台生成一个带仓库读写权限的令牌'),
                  h('div', null, '2. 在终端执行一次，让这台电脑记住它：'),
                  h(
                    'pre',
                    {
                      style: {
                        margin: '10px 0',
                        padding: 10,
                        borderRadius: 8,
                        background: 'var(--dsw-alias-bg-base)',
                        border: `1px solid ${BORDER}`,
                        fontSize: 12,
                        overflowX: 'auto'
                      }
                    },
                    'git config --global credential.helper osxkeychain\n',
                    `printf 'protocol=https\\nhost=${provider === 'gitee' ? 'gitee.com' : 'github.com'}\\nusername=<账号>\\npassword=<令牌>\\n\\n' | git credential approve`
                  ),
                  h('div', null, '3. 回来点「重新检测」')
                ),
                h(
                  'a',
                  {
                    href: meta.tokens,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { color: BRAND, fontSize: 13, textDecoration: 'none', display: 'inline-block', marginTop: 12 }
                  },
                  `打开 ${meta.label} 的令牌页面 ↗`
                )
              )
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10 } },
          h('button', { style: button(), onClick: retest, disabled: Boolean(busy) }, busy === 'test' ? '检测中…' : '重新检测'),
          h('button', { style: button(), onClick: () => setView('setup') }, '换一个仓库')
        )
      )

      const listView = h(
        'div',
        null,
        doctor && doctor.relay
          ? h(
              'div',
              { style: { fontSize: 12, color: MUTED, marginBottom: 16, wordBreak: 'break-all' } },
              h('span', { style: { color: OK } }, '● '),
              '已连接 ',
              doctor.relay
            )
          : null,
        projects.length === 0
          ? h('div', { style: { color: MUTED, fontSize: 13 } }, '仓库里还没有项目。在任意项目里运行 /hop push 就会加进来。')
          : projects.map((project) =>
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
                    h('span', {
                      style: {
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: project.downloaded ? OK : 'var(--dsw-alias-state-idle-primary)'
                      }
                    }),
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
                        {
                          style: {
                            color: MUTED,
                            fontSize: 12,
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }
                        },
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
            )
      )

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
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 } },
            h('div', { style: { fontSize: 20, fontWeight: 600 } }, '跨机接力'),
            h('div', { style: { flex: 1 } }),
            view !== 'setup'
              ? h('button', { style: button(), onClick: () => setView('setup') }, '设置仓库')
              : null,
            h('button', { style: button(), onClick: refresh, disabled: Boolean(busy) }, '刷新')
          ),
          view === 'loading' ? h('div', { style: { color: MUTED, fontSize: 13 } }, '加载中…') : null,
          view === 'setup' ? setupView : view === 'auth' ? authView : listView,
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
                    border: `1px solid ${flash.kind === 'error' ? ERROR : BORDER}`,
                    color: flash.kind === 'error' ? ERROR : TEXT,
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
          ctx.slots.register({ name: 'sidebar.panellist', id: 'hop', order: 20, label: '接力' }, HopIcon)
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'hop' }, Panel))
      }
    }
  }
})
