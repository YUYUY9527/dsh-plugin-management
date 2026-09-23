/**
 * dsh-plugin-management —— client half（浏览器面板）。
 *
 * 这是 Web 端 bundle：dsh 的 client-modules 服务会读本包的 package.json
 * （`dsh.client` + `exports["./client"]`）并把本文件原样发给浏览器，
 * 由页面的 `__ModuleLoader__` 执行。因此：
 *   · 必须是 `window.__ModuleLoader__.load({ id, factory })` 包装；
 *   · 依赖走 factory 的 require（react 由外壳提供，无需在 dsh.client.inject 里声明）；
 *   · 不能用构建期语法（无 TS/JSX），这里全部用 React.createElement。
 *
 * 数据来自 host half 的同源接口 `/dsh-plugin-management/api`（见 lib/index.js）。
 *
 * @module dsh-plugin-management/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-management',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const e = React.createElement

    /** host API 前缀：与 lib/index.js 的 DEFAULT_API_PATH 保持一致。 */
    const API = '/dsh-plugin-management/api'
    /** 设置页里的 tab id：用自有 id，避免覆盖 shipped 的 configurable / all。 */
    const TAB_ID = 'plugin-management'
    /** 承载 tab 的 slot；若未来 dsh 改名，改这一处即可。 */
    const TAB_SLOT = 'settings.plugins.tab'

    // 字体与字号全部走 dsh 自己的变量：
    //   --dsw-font-family        正文（此前没设，落到浏览器默认）
    //   --ds-font-family-code    等宽（此前写死 ui-monospace，Windows 上会退化成 Courier）
    //   --dsw-font-xs-13         小字号 token
    // 颜色只用 Theme 暴露的 dsw-alias-* 系列，保证明暗主题一致。
    const CSS = [
      '.dsh-pm { display: flex; flex-direction: column; gap: 12px; padding: 2px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif); font-size: var(--dsw-font-xs-13, 13px); line-height: 1.5; }',
      '.dsh-pm-head { display: flex; align-items: center; gap: 8px; }',
      '.dsh-pm-title { font-size: 14px; font-weight: 600; }',
      '.dsh-pm-spacer { flex: 1 1 auto; }',
      '.dsh-pm-select { height: 26px; max-width: 230px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: var(--dsw-font-xs-13, 13px); padding: 0 6px; cursor: pointer; }',
      '.dsh-pm-btn { height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: var(--dsw-font-xs-13, 13px); cursor: pointer; white-space: nowrap; }',
      '.dsh-pm-btn:hover:enabled { background: var(--dsw-alias-bg-layer-2); }',
      '.dsh-pm-btn:disabled { opacity: 0.45; cursor: default; }',
      '.dsh-pm-btn-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #ffffff; }',
      '.dsh-pm-btn-danger { border-color: currentColor; background: transparent; color: var(--dsw-alias-state-error-primary); }',
      '.dsh-pm-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-pm-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }',
      '.dsh-pm-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l1); }',
      '.dsh-pm-row:first-child { border-top: none; }',
      '.dsh-pm-cell { flex: 1 1 auto; min-width: 0; }',
      // 包名与命令用 code 字体：它们是标识符，等宽更好读，也和 dsh 的代码风格一致
      '.dsh-pm-name { font-family: var(--ds-font-family-code, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace); font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsh-pm-vers { margin-top: 1px; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      // 安装命令：单行省略，不再换行（长 git spec 换行是之前最碍眼的地方），完整内容在 title 上
      '.dsh-pm-cmd { display: flex; align-items: center; gap: 6px; margin-top: 3px; min-width: 0; }',
      '.dsh-pm-cmd code { font-family: var(--ds-font-family-code, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; }',
      '.dsh-pm-copy { flex: 0 0 auto; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font-family: inherit; font-size: 12px; cursor: pointer; }',
      '.dsh-pm-copy:hover { text-decoration: underline; }',
      // 右侧一整列：徽标 + 操作，永远不换行、不被压扁
      '.dsh-pm-side { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }',
      '.dsh-pm-badges { display: flex; align-items: center; gap: 6px; }',
      '.dsh-pm-badge { font-size: 12px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
      '.dsh-pm-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }',
      '.dsh-pm-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }',
      '.dsh-pm-badge.err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }',
      '.dsh-pm-actions { display: flex; align-items: center; gap: 6px; }',
      '.dsh-pm-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-pm-warn { color: var(--dsw-alias-state-warn-primary); }',
      '.dsh-pm-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }',
      '.dsh-pm-out { max-height: 180px; margin: 0; padding: 8px 10px; overflow: auto; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-word; }',
      '.dsh-pm-outcome { display: flex; flex-direction: column; gap: 6px; }',
    ].join('\n')

    /**
     * 文案：跟随界面语言，取不到就按中文（本插件作者的主要语言）。
     * @param {any} ctx 客户端上下文
     * @returns {(zh: string, en: string) => string} 取词函数
     */
    function makeTranslator(ctx) {
      let zh = true
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          const snapshot =
            typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : locale.getLocale()
          if (snapshot && typeof snapshot.id === 'string') zh = snapshot.id.toLowerCase().indexOf('zh') === 0
        }
      } catch {
        /* 取不到语言就用中文 */
      }
      return (zhText, enText) => (zh ? zhText : enText)
    }

    /** 取错误信息文本。 */
    function describe(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /** 保留字符串尾部。 */
    function tail(value, limit) {
      const text = typeof value === 'string' ? value : ''
      return text.length > limit ? text.slice(text.length - limit) : text
    }

    /**
     * GET host 接口。
     * @param {string} path 子路径
     * @param {Record<string, string>} params 查询参数
     * @returns {Promise<any>} JSON
     */
    async function apiGet(path, params) {
      const query = new URLSearchParams()
      for (const key of Object.keys(params || {})) if (params[key]) query.set(key, params[key])
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      const response = await fetch(`${API}${path}${suffix}`, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => null)
      if (data === null) throw new Error(`HTTP ${response.status}`)
      if (data.error) throw new Error(String(data.error))
      return data
    }

    /**
     * POST host 接口。
     * @param {string} path 子路径
     * @param {object} body 请求体
     * @returns {Promise<any>} JSON
     */
    async function apiPost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await response.json().catch(() => null)
      if (data === null) throw new Error(`HTTP ${response.status}`)
      if (data.error) throw new Error(String(data.error))
      return data
    }

    /**
     * 面板组件。
     * @param {{ t: Function }} props 注入的取词函数
     * @returns {any} React 元素
     */
    function Panel(props) {
      const t = props.t
      const [profile, setProfile] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const [state, setState] = React.useState({
        phase: 'loading',
        data: null,
        error: null,
        checkFailure: '',
      })
      const [busy, setBusy] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [deep, setDeep] = React.useState(false)
      /** 正在二次确认卸载的行（卸载是破坏性操作，要两下）。 */
      const [confirming, setConfirming] = React.useState('')
      /** 刚复制成功的命令文本（用来把按钮短暂切成「已复制」）。 */
      const [copied, setCopied] = React.useState('')

      /**
       * 复制一条命令。clipboard API 在 127.0.0.1 上可用（安全上下文）；
       * 不可用时命令本身就是 user-select:all，点一下全选再 Ctrl+C 也行。
       * @param {string} text 命令
       */
      const copyCommand = (text) => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(text).then(
          () => {
            setCopied(text)
            window.setTimeout(() => setCopied((prev) => (prev === text ? '' : prev)), 1500)
          },
          () => setCopied(''),
        )
      }

      // 两段式加载：先出本地清单（快），再补一次联网版本检查。
      React.useEffect(() => {
        let alive = true
        const selection = profile === '' ? undefined : profile
        setState((prev) => ({
          phase: prev.data === null ? 'loading' : 'refreshing',
          data: prev.data,
          error: null,
          checkFailure: '',
        }))
        apiGet('/inventory', { profile: selection, refresh: tick > 0 ? '1' : '' })
          .then((first) => {
            if (!alive) return null
            setState({ phase: 'ready', data: first, error: null, checkFailure: '' })
            // 版本检查单独失败**不能静默**：这里把失败原因带回去显示，
            // 否则任何后端异常都只表现为一句无辜的「未检查」。
            return apiGet('/inventory', { profile: selection, check: '1' }).then(
              (checked) => ({ ok: true, data: checked }),
              (error) => ({ ok: false, error: describe(error) }),
            )
          })
          .then((second) => {
            if (!alive || second === null) return
            if (second.ok === false) {
              setState((prev) => ({ ...prev, phase: 'ready', checkFailure: second.error }))
              return
            }
            setState({ phase: 'ready', data: second.data, error: null, checkFailure: '' })
          })
          .catch((error) => {
            if (!alive) return
            setState((prev) => ({ phase: 'error', data: prev.data, error: describe(error) }))
          })
        return () => {
          alive = false
        }
      }, [profile, tick])

      const refresh = () => setTick((value) => value + 1)

      /**
       * 跑一次变更类操作（更新 / 卸载），结果落到 result 面板。
       * @param {'update' | 'uninstall'} kind 操作类型（决定结果文案）
       * @param {string} path API 子路径
       * @param {object} body 请求体
       * @param {string} busyKey busy 标记（'all' 或包名）
       */
      const runAction = (kind, path, body, busyKey) => {
        setBusy(busyKey)
        setConfirming('')
        setResult(null)
        apiPost(path, body)
          .then((data) => {
            setBusy(null)
            const payload =
              data === null || data === undefined ? { ok: false, error: 'empty response' } : data
            setResult({ ...payload, kind })
            refresh()
          })
          .catch((error) => {
            setBusy(null)
            setResult({ ok: false, kind, error: describe(error) })
          })
      }

      /**
       * 更新。
       * @param {string[] | null} names null = 全部
       * @param {boolean} useLatest 是否 --latest
       */
      const runUpdate = (names, useLatest) =>
        runAction(
          'update',
          '/update',
          {
            profile: profile === '' ? undefined : profile,
            names: names === null ? undefined : names,
            latest: useLatest === true || deep === true,
          },
          names === null ? 'all' : names.join(', '),
        )

      /**
       * 卸载单个插件（破坏性：host 侧要求必须点名）。
       * @param {string} name 包名
       */
      const runUninstall = (name) =>
        runAction(
          'uninstall',
          '/uninstall',
          { profile: profile === '' ? undefined : profile, names: [name] },
          name,
        )

      const data = state.data
      const rows = data && Array.isArray(data.plugins) ? data.plugins : []
      const updatable = rows.filter((row) => row.outdated === true && row.updatable === true)
      const majorRows = updatable.filter((row) => row.major === true)
      const offline = state.phase === 'loading' || state.phase === 'refreshing'

      const header = e(
        'div',
        { className: 'dsh-pm-head' },
        e('span', { className: 'dsh-pm-title' }, t('外部插件', 'External plugins')),
        data === null || data === undefined
          ? null
          : e(
              'select',
              {
                className: 'dsh-pm-select',
                value: profile,
                onChange: (event) => setProfile(event.target.value),
              },
              [
                e(
                  'option',
                  { key: '__auto', value: '' },
                  t('自动 · ', 'auto · ') +
                    String(data.profile) +
                    (data.runningProfile ? t('（运行中）', ' (running)') : ''),
                ),
              ].concat((data.profiles || []).map((item) => e('option', { key: item, value: item }, item))),
            ),
        e('span', { className: 'dsh-pm-spacer' }),
        e(
          'button',
          {
            className: 'dsh-pm-btn',
            onClick: refresh,
            disabled: offline,
            title: t('重新扫描 profile 与最新版本', 'Rescan profiles and newest versions'),
          },
          t('刷新', 'Refresh'),
        ),
        e(
          'button',
          {
            className: 'dsh-pm-btn dsh-pm-btn-primary',
            onClick: () => runUpdate(null, false),
            disabled: busy !== null || updatable.length === 0,
            title: t('更新该 profile 下所有可更新的外部插件', 'Update every outdated external plugin of this profile'),
          },
          busy === 'all'
            ? t('更新中…', 'Updating…')
            : t('一键更新', 'Update all') + (updatable.length > 0 ? ` (${updatable.length})` : ''),
        ),
      )

      const meta =
        data === null || data === undefined
          ? null
          : e(
              'div',
              { className: 'dsh-pm-meta' },
              // 目录不再占一行：挂到 profile 的 title 上，需要时悬停即可
              e(
                'span',
                { title: data.profileDir === null ? '' : String(data.profileDir) },
                t('profile ', 'profile ') +
                  String(data.profile) +
                  (data.runningProfile ? t('（运行中）', ' (running)') : ''),
              ),
              e('span', null, t('外部插件 ', 'external ') + String(rows.length)),
              data.checked === true ? e('span', null, t('已核对最新版本', 'versions checked')) : null,
              // 版本检查这一次请求本身失败了（后端异常/断线）：必须显示出来，
              // 否则用户只看到一句「未检查」，完全不知道出过事。
              state.checkFailure
                ? e(
                    'span',
                    { className: 'dsh-pm-warn' },
                    t('版本检查失败：', 'version check failed: ') + String(state.checkFailure),
                  )
                : null,
              // host 层的模型工具注册失败时，这里必须看得见（否则只能在 dsh 日志里找）
              data.tool && data.tool.state !== 'registered'
                ? e(
                    'span',
                    { className: 'dsh-pm-warn' },
                    t('模型工具未注册：', 'tool not registered: ') +
                      String(data.tool.state) +
                      (data.tool.error ? `（${String(data.tool.error)}）` : ''),
                  )
                : null,
              data.checked !== true && data.checkError
                ? e('span', { className: 'dsh-pm-warn' }, t('版本检查失败：', 'check failed: ') + String(data.checkError))
                : null,
              majorRows.length > 0
                ? e('span', null, `${majorRows.length}${t(' 个可跨大版本升级', ' major upgrade(s)')}`)
                : null,
            )

      const list = e(
        'div',
        { className: 'dsh-pm-list' },
        rows.length === 0
          ? e(
              'div',
              { className: 'dsh-pm-row' },
              e(
                'span',
                { className: 'dsh-pm-note' },
                offline ? t('读取中…', 'Loading…') : t('这个 profile 没有外部插件', 'No external plugin in this profile'),
              ),
            )
          : rows.map((row) => {
              const badges = []
              if (row.local === true) {
                badges.push(e('span', { key: 'local', className: 'dsh-pm-badge' }, t('本地链接', 'local link')))
              } else if (row.outdated === true) {
                badges.push(
                  e(
                    'span',
                    { key: 'out', className: 'dsh-pm-badge warn' },
                    row.major === true
                      ? t('可升级到 ', 'major → ') + String(row.latest)
                      : t('可更新到 ', 'update → ') + String(row.latest),
                  ),
                )
              } else if (data.checked === true) {
                badges.push(e('span', { key: 'ok', className: 'dsh-pm-badge ok' }, t('已是最新', 'up to date')))
              } else {
                badges.push(e('span', { key: 'unknown', className: 'dsh-pm-badge' }, t('未检查', 'not checked')))
              }
              if (row.layer !== true) {
                badges.push(e('span', { key: 'layer', className: 'dsh-pm-badge' }, t('非插件层', 'not a layer')))
              }
              if (row.deprecated === true) {
                badges.push(e('span', { key: 'dep', className: 'dsh-pm-badge err' }, t('已废弃', 'deprecated')))
              }

              const actions = []
              if (row.updatable === true && row.inRange === true) {
                actions.push(
                  e(
                    'button',
                    {
                      key: 'update',
                      className: 'dsh-pm-btn',
                      disabled: busy !== null,
                      onClick: () => runUpdate([row.name], false),
                    },
                    t('更新', 'Update'),
                  ),
                )
              }
              if (row.updatable === true && row.major === true) {
                actions.push(
                  e(
                    'button',
                    {
                      key: 'major',
                      className: 'dsh-pm-btn',
                      disabled: busy !== null,
                      onClick: () => runUpdate([row.name], true),
                    },
                    t('升级到最新', 'Upgrade'),
                  ),
                )
              }
              // 卸载：破坏性操作，两下确认（4 秒内不点第二下就自动取消）
              actions.push(
                confirming === row.name
                  ? e(
                      'button',
                      {
                        key: 'uninstall-confirm',
                        className: 'dsh-pm-btn dsh-pm-btn-danger',
                        disabled: busy !== null,
                        title: t('再点一次即从该 profile 移除', 'Click again to remove from this profile'),
                        onClick: () => runUninstall(row.name),
                      },
                      t('确认卸载', 'Confirm'),
                    )
                  : e(
                      'button',
                      {
                        key: 'uninstall',
                        className: 'dsh-pm-btn',
                        disabled: busy !== null,
                        title: t(
                          '从 profile 依赖里移除（重启 dsh 后彻底不加载）',
                          'Remove from the profile dependencies (fully unloaded after dsh restarts)',
                        ),
                        onClick: () => {
                          setConfirming(row.name)
                          window.setTimeout(
                            () => setConfirming((prev) => (prev === row.name ? '' : prev)),
                            4000,
                          )
                        },
                      },
                      t('卸载', 'Uninstall'),
                    ),
              )
              if (busy === row.name) {
                actions.push(e('span', { key: 'busy', className: 'dsh-pm-note' }, t('处理中…', 'working…')))
              }

              return e(
                'div',
                { key: row.name, className: 'dsh-pm-row' },
                e(
                  'div',
                  { className: 'dsh-pm-cell' },
                  e('div', { className: 'dsh-pm-name' }, String(row.name)),
                  e(
                    'div',
                    { className: 'dsh-pm-vers' },
                    t('已装 ', 'installed ') +
                      String(row.installed === null ? '?' : row.installed) +
                      ' · ' +
                      String(row.spec),
                  ),
                  // 该插件自己的安装 / 升级命令（host 已按依赖来源拼好）
                  row.installCommand
                    ? e(
                        'div',
                        { className: 'dsh-pm-cmd' },
                        e('code', { title: String(row.installCommand) }, String(row.installCommand)),
                        e(
                          'button',
                          {
                            className: 'dsh-pm-copy',
                            onClick: () => copyCommand(row.installCommand),
                            title: t('复制这条命令', 'Copy this command'),
                          },
                          copied === row.installCommand ? t('已复制', 'Copied') : t('复制', 'Copy'),
                        ),
                      )
                    : null,
                ),
                // 徽标与操作放同一列：保证右侧不换行、跨行对齐
                e(
                  'div',
                  { className: 'dsh-pm-side' },
                  e('div', { className: 'dsh-pm-badges' }, badges),
                  e('div', { className: 'dsh-pm-actions' }, actions),
                ),
              )
            }),
      )

      const outcome =
        result === null || result === undefined
          ? null
          : e(
              'div',
              { className: 'dsh-pm-outcome' },
              e(
                'div',
                { className: result.ok === true ? 'dsh-pm-note' : 'dsh-pm-error' },
                result.ok === true
                  ? (result.kind === 'uninstall'
                      ? t('卸载完成', 'Uninstall finished')
                      : t('更新完成', 'Update finished')) +
                      (Array.isArray(result.names) && result.names.length > 0
                        ? `：${result.names.join(', ')}`
                        : '')
                  : (result.kind === 'uninstall'
                      ? t('卸载失败：', 'Uninstall failed: ')
                      : t('更新失败：', 'Update failed: ')) +
                      String(result.error || result.stderr || `exit ${result.exitCode}`),
              ),
              result.command ? e('div', { className: 'dsh-pm-note' }, `$ ${String(result.command)}`) : null,
              result.restartRequired === true
                ? e(
                    'div',
                    { className: 'dsh-pm-note' },
                    result.kind === 'uninstall'
                      ? t(
                          '包已从依赖里移除，但进程里仍是活的 —— 重启 dsh 后才真正不再加载。',
                          'Removed from the dependencies, but still live in this process — restart dsh to fully unload it.',
                        )
                      : t(
                          '新版本需要重启 dsh 后才会加载（当前进程仍运行旧代码）。',
                          'Restart dsh to load the new version; this process still runs the old code.',
                        ),
                  )
                : null,
              result.stdout || result.stderr
                ? e(
                    'pre',
                    { className: 'dsh-pm-out' },
                    tail(`${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`, 3000),
                  )
                : null,
            )

      const footer = e(
        'div',
        { className: 'dsh-pm-note' },
        t(
          '管理该 profile package.json 里的外部依赖；更新或卸载后需重启 dsh 才真正生效。',
          'Manages the profile\u2019s external dependencies; restart dsh after an update or uninstall to take effect.',
        ),
      )

      return e(
        'div',
        { className: 'dsh-pm' },
        header,
        state.error ? e('div', { className: 'dsh-pm-error' }, String(state.error)) : null,
        meta,
        list,
        outcome,
        footer,
      )
    }

    /** 本 bundle 需要的服务（cordis 注入声明）。 */
    exports.inject = ['slots']

    /**
     * 客户端插件入口：把面板挂进「设置 → 插件」的一个 tab。
     * @param {any} ctx 客户端上下文
     */
    function apply(ctx) {
      const t = makeTranslator(ctx)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-plugin-management: styles')

      ctx.effect(
        () =>
          ctx.slots.inject(TAB_SLOT, () =>
            ctx.slots.register(
              {
                name: TAB_SLOT,
                id: TAB_ID,
                order: 20,
                label: () => t('外部插件', 'External plugins'),
              },
              () => e(Panel, { t }),
            ),
          ),
        'dsh-plugin-management: settings tab',
      )
    }

    exports.apply = apply
    return module.exports
  },
})
