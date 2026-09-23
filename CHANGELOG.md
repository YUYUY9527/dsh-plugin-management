# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 结构。

## [1.2.0] - 2026-09-20

### 新增

- **每行新增「卸载」按钮**：点一下变「确认卸载」，4 秒内再点一下才真的执行（破坏性操作不做单点即触发）。走 `dsh plugin --profile <p> remove <包名>` —— 官方转发器会同步把包名从 `dsh.profile.bundles` 摘掉，避免残留 bundle 行导致下次启动报错。结果面板会提示**包已移除但进程里仍是活的，要重启 dsh 才真正不加载**。
  host 侧**必须点名**：不带 `names` 的卸载请求一律拒绝；只允许该 profile 里真实存在且非官方的依赖。模型工具同步支持 `action="uninstall"`。
- 行配置 `config.sandboxMode`（默认 `danger-full-access`）：声明命令的执行策略，见下方修复说明。

### 修复

- **沙箱可写根与 workdir 对不上（一键更新必失败）**：之前没给 `ShellExecRequest` 传 `sandboxPolicy`，执行器按 dsh 自己的可写根跑，而 `pnpm update` 要写 pnpm store（如 `D:\.pnpm-store\v11`，不在任何 profile 目录里）→ **即使沙箱健康也会在写 store 时 `Access is denied`**。现在显式传 `{ mode, workspaceRoot: workdir }`。
- **执行器/沙箱不可用不该让整条链路崩**：此前只有「shell 服务没挂载」才退 `child_process`；现在 `shell.run()` 的任何 rejection（含 `SANDBOX_UNAVAILABLE`）都归入「执行器不可用」，走同一条不受限兜底并留下告警。**沙箱明确 denied 不兜底** —— 那是策略决定，不是故障。
- **客户端吞异常**：版本检查那一次请求的 `.catch(() => null)` 会把任何后端异常变成一句无辜的「未检查」。现在失败原因会显示在面板上。
- **`registerTool` 被调了两次**：第二次必然抛 `tool "external_plugins" is already registered`，只剩一条无用的 warn 日志。现在只调一次。
- **同类隐患一并堵掉**：`void mount()` 与 webServer handler 两处 fire-and-forget promise 补上 `.catch` —— **未捕获的 rejection 在 Node 22 默认策略下会直接终止 dsh 进程**（开发探针里真实踩过一次，宿主被带崩）。

## [1.1.0] - 2026-09-20

### 新增

- **每个插件下方显示自己的安装命令**：一行可直接复制的 `dsh plugin --profile <profile> add …`，右侧带「复制」按钮（`navigator.clipboard`；`127.0.0.1` 属安全上下文，可用），复制成功后 1.5 秒内显示「已复制」。命令本身是 `user-select: all`，点一下全选也能 Ctrl+C。
  - **registry 包**：知道最新版就钉到最新版（`add <name>@<latest>`，等价于升级该包），否则 `add <name>`
  - **本地链接 / git / tarball 依赖**：原样复用依赖里记的 spec（`add link:…`、`add github:…`）——不会把来源悄悄换成 registry
  - 命令里的 `profile` 跟随面板当前选中的 profile（含「自动」解析结果）
- 字段同时出现在模型工具 `external_plugins` 的 `action=list` 结果里（`installCommand`），agent 可直接转述或执行。

## [1.0.1] - 2026-09-20

### 修复

- **模型工具 `external_plugins` 在真实部署里从未注册**（1.0.0 的静默故障）：`createToolSpec()` 把 **JSON Schema 形态**的参数喂给 `defineTool()`（报 `parameters.type must be a value schema object`），回落时又把 author-only 的 `output.schema: { type: 'json' }` 交给 `ctx.tools.register()`（被 `assertSupportedJsonSchema` 拒绝 —— raw 形态里 `json` 非法，等价于 `{}`）。两次失败都只写一行日志，工具静默消失。
  现在两种 schema 形态彻底分开：**DSL 交 `defineTool`，raw 交 `register`**，并用回归测试钉住（`lib/tool.js` 头注释留了完整的坑位说明）。
- 参数非法时统一返回 JSON `{ ok: false, error }`，不再从 `execute` 抛错（两条路径行为一致）。

### 新增

- host 把**工具注册状态**随 `/inventory` 回给面板：注册失败会直接在「外部插件」页显示 `模型工具未注册：<state>（<原因>）`，不必再去翻 dsh 日志。

## [1.0.0] - 2026-09-20

首个公开发布。

### 新增

- **外部插件清单**：扫描 `$DSH_HOME/profiles/*/package.json`，列出该 profile 所有非官方依赖的已装版本、版本范围、是否生效为插件层（`dsh.profile.bundles`）、是 registry 包还是本地 `link:`。
- **版本检查**：`pnpm outdated --format json`，区分「范围内可更新」与「需 `--latest` 的跨大版本升级」。
- **一键更新**：单个 / 全部 / 跨大版本三种粒度，走 `dsh plugin --profile <p> update`（官方转发器），`dsh` 不可用时回落 `pnpm update`。
- **设置页 UI**：注册进 `settings.plugins.tab` 的「外部插件」tab（id `plugin-management`，order 20），含 profile 切换、刷新、逐行操作、命令与输出回显、重启提示。
- **模型工具** `external_plugins`：`action=list | update`，参数走严格校验（profile 名与包名在做命令拼接前过滤）。
- **host HTTP API**：`GET <apiPath>/inventory`、`POST <apiPath>/update`，仅接受同源请求；前缀可用行配置 `apiPath` 覆盖。
- **运行实例识别**：从 client bundle 的绝对路径反推「当前跑的 profile」，作为选择器默认值。

### 设计

- 纯 ESM JavaScript，无构建步骤、无运行时依赖；`webServer` / `tools` / `shell` / `clientModules` 全部惰性获取。
- 模型工具双路径：优先 `@deepseek-ai/dsh-tools` 的 `defineTool`（带参数校验），解析不到则本地 JSON Schema 注册。
- 命令执行双路径：优先 `ctx.shell`（沙箱/超时/输出上限由执行器负责），缺失时回落 `node:child_process`。
- 不自动重启进程：更新落地后明确提示需重启才生效。

### 测试

- 25+ 条 `node:test` 用例：profile 扫描与名称守卫、清单合并、更新命令拼装与兜底、client bundle 包装与 slot 注册、模型工具分派、以及打包契约（`main` / `dsh.bundle.patch` / `dsh.client` / `exports["./client"]` 与真实文件一致性）。
