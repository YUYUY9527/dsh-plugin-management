# dsh-plugin-management · 外部插件管理器

[English](README.en.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的**外部插件管理器**：
在「设置 → 插件 → 外部插件」里看清当前 profile 装了哪些第三方插件、各自是什么版本、有没有更新，然后**一键更新**。

> 定位：官方「插件」设置页回答的是「哪些插件**加载**了」（Loader 条目、启用状态、fiber 相位）；
> 本插件回答的是「哪些外部包**装着**」（npm 版本、能否更新、是否真的生效为插件层）。两者互补。

---

## 它解决什么

`dsh plugin --profile <p> add <pkg>` 把插件装进 profile 后，日常会遇到三个问题：

1. **装了记不住**：`~/.dsh/profiles/<p>/package.json` 里躺着一堆包，谁还在用、谁已经废弃，没人知道。
2. **装了没生效**：依赖在 `dependencies` 里，却不在 `dsh.profile.bundles` 里 —— 装了个寂寞（不声明 `dsh.bundle.patch` 的库）或者被后来改动挤掉了。
3. **更新靠记忆**：想知道 `pnpm outdated` 的结果、想升级，得自己进 profile 目录敲命令。

本插件把这三件事变成一页 UI + 一个模型工具。

## 功能

| 能力 | 说明 |
| --- | --- |
| 外部插件清单 | 列出该 profile `dependencies` 里所有**非** `@deepseek-ai/*` 的包：已装版本、版本范围、是否生效为插件层（`dsh.profile.bundles`）、是 registry 包还是本地 `link:` |
| 版本检查 | `pnpm outdated --format json`，区分「直接可更新（范围内）」与「可跨大版本升级（需要 `--latest`）」 |
| 一键更新 | 单个插件 / 全部可更新插件 / 跨大版本升级，三种粒度 |
| 结果可见 | 回显真实执行的命令、退出码、stdout/stderr 尾部，并提示**需要重启 dsh 才会加载新版本** |
| profile 切换 | 自动识别「当前正在运行的是哪个 profile」，也可手动切到别的 profile |
| 给 agent 用 | 注册模型工具 `external_plugins`（`action: list \| update`），agent 自己就能查与更新 |
| 双语 | 界面文案跟随 `locale`（zh / en） |

## 安装

装完**重启 dsh** 生效（bundle 装配在启动时完成）。`add` 后面的 spec 会**原样转发给 pnpm**，所以 pnpm 支持的写法都能用：

```bash
# —— 公网获取（使用者 / 分发）——
# ① 锁定版本，推荐：git tag
dsh plugin --profile web add github:YUYUY9527/dsh-plugin-management#v1.0.0

# ② 跟随最新代码
dsh plugin --profile web add github:YUYUY9527/dsh-plugin-management

# ③ Release 包 URL：只需能上 HTTPS，本机不需要 git
dsh plugin --profile web add https://github.com/YUYUY9527/dsh-plugin-management/releases/download/v1.0.0/dsh-plugin-management-1.0.0.tgz

# ④ npm registry（尚未发布，发布后对所有人生效）
dsh plugin --profile web add dsh-plugin-management

# —— 本地目录（开发 / 自用，改完代码重启即可）——
dsh plugin --profile web add D:\fubin\dev\mini-tools\dsh\dsh-plugin-management
```

`--profile` 必须是**你实际在跑的那个 profile**（`dsh web` 就是 `web`）。
加完可以立刻检查装配结果：

```bash
dsh --profile web --dump-config | grep dsh-plugin-management
```

公网各方式的取舍、npm 发布步骤与排查见 [INSTALL.md](INSTALL.md)。

## 使用

### 界面

重启 dsh 后打开 **设置 → 插件**，会多出一个 **「外部插件」** tab（排在官方 `configurable` / `all` 之后）：

- 顶部：profile 选择器（`自动` = 当前运行的 profile）、`刷新`、`一键更新 (N)`
- 每行：包名、已装版本 · 版本范围、状态徽标（可更新到 x / 可升级到 x / 已是最新 / 本地链接 / 非插件层 / 已废弃）
- 每行操作：`更新`（范围内）、`升级到最新`（`--latest`，会改写 `package.json` 的版本范围）
- 底部：更新结果（含完整命令与输出）与重启提示

打开页面会先出本地清单（快），随后自动补一次联网版本检查。

### 模型工具

```text
external_plugins action=list                       # 看清单（默认联网核对最新版本）
external_plugins action=list check=false           # 只看本地已装版本，不联网
external_plugins action=update profile=web         # 更新该 profile 全部外部插件
external_plugins action=update names=["dsh-tinyfish-search"]
external_plugins action=update latest=true         # 跨大版本升级
```

### HTTP 接口（面板与其它前端复用）

默认前缀 `/dsh-plugin-management/api`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/inventory?profile=&check=1&refresh=1` | 清单；`check=1` 联网核对最新版本，`refresh=1` 强制重扫 profile 目录 |
| `POST` | `/update` | body `{ profile?, names?, latest? }`，跑更新并返回命令与输出 |

跨站请求会被拒（只接受同源），包名/profile 名都经过严格字符校验后才拼进命令。

## 它怎么判断

```text
$DSH_HOME/profiles/<profile>/
  package.json
    dependencies         →  谁装着（外部插件 = 非 @deepseek-ai/ 开头的包）
    dsh.profile.bundles  →  谁生效为插件层
  node_modules/<pkg>/package.json
    version              →  实际装的是哪个版本
    dsh.bundle.patch     →  它到底是不是一个插件层（bundle）
```

- **外部插件**：`dependencies` 里非 `@deepseek-ai/*` 的包。
- **插件层**：同时出现在 `dsh.profile.bundles` 里 —— 这才是真正被 Loader 装配的。
- **本地链接**：`link:` / `file:` / `workspace:` / `portal:` 协议，不来自 registry，因此不参与更新。
- **当前 profile**：从运行实例的 client bundle 绝对路径（`<home>/profiles/<name>/node_modules/...`）反推，比猜目录 mtime 可靠。

更新统一走 **`dsh plugin --profile <p> update ...`**（官方转发器，装完还会把 `dsh.bundle` 声明变化重新对齐进 `dsh.profile.bundles`）；
若 `dsh` 不在 PATH，自动回落 `pnpm update ...`（cwd = profile 目录）。

## 配置

行配置只有一项（都可不填）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-plugin-management
  config:
    apiPath: /dsh-plugin-management/api   # 仅在路由撞车（同名 kind+path 会抛错）时改
```

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-management   # 官方路径
```

临时禁用而不卸载：在 profile 的 `cordis.patch.yml` 里给该行加 `disabled: true`。

## 设计取舍

- **纯 JavaScript，零构建**：`lib/*.js` 就是源码也是产物，`github:` 安装不需要本机有构建环境（pnpm 默认拦截 git 包的 build 脚本，TS 插件很容易卡在这一步）。
- **没有硬依赖**：`webServer` / `tools` / `shell` / `clientModules` 全部惰性获取。缺 `webServer` 就没有面板，缺 `tools` 就没有模型工具，但插件本身永远能加载。
- **模型工具的双路径**：能解析到 `@deepseek-ai/dsh-tools` 时用官方 `defineTool`（带参数校验），解析不到就用本地 JSON Schema 注册 —— 外挂包不该因为一个可选包而整体挂掉。
- **不做自动重启**：更新落地 ≠ 生效。插件把「需重启」明确写在结果里，而不是替用户重启进程。

## 已知限制

- 只管理**当前 profile 的第三方依赖**；官方 `@deepseek-ai/*` 包与 profile 模板自带的 in-box bundle 不在管理范围（它们随 dsh 安装走）。
- 不做安装/卸载 UI（那是 `dsh plugin add/remove` 的职责）；本插件专注「看见 + 更新」。
- 更新不校验版本兼容性：跨大版本升级前请自行确认目标包支持你当前的 dsh。

## 维护指南（dsh 升级后看哪里）

本插件依赖 dsh 的**公开约定**，而不是内部实现。dsh 升级后如果哪块失效，按这张表定位，通常只改一处：

| 依赖的约定 | 写在哪 | 失效表现 | 怎么改 |
| --- | --- | --- | --- |
| profile 布局 `$DSH_HOME/profiles/<name>/package.json` + `dsh.profile.bundles` | `lib/scan.js` | 清单为空 / profile 列表为空 | 对齐 `@deepseek-ai/dsh-app-boot` 的 `PROFILES_DIR` / `resolveProfileDir` |
| `$DSH_HOME` 解析优先级 | `lib/scan.js` `resolveDshHome()` | home 找错 | 对齐 `@deepseek-ai/dsh-home-paths` |
| 设置 slot `settings.plugins.tab` | `lib/client.js` 顶部 `TAB_SLOT` | 面板不出现（但工具还正常） | 查 `Slots.listSubTree`，改成新的 slot 名（一行常量） |
| `dsh.client` + `exports["./client"]` 客户端发现约定 | `package.json` | 面板不出现，控制台无此 bundle | 对齐 `@deepseek-ai/dsh-client-modules` 的 `resolveMeta` |
| `webServer.register({ kind, path, handler })` | `lib/index.js` | API 404 | 对齐 webServer 服务签名 |
| `pnpm outdated --format json` 输出形状 | `lib/inventory.js` `checkOutdated()` | `checkError` 有值 | 按新输出调整解析（已是容错解析：非 JSON 即报错而非崩） |
| `dsh plugin --profile <p> update` | `lib/inventory.js` `update()` | 报 dsh 不可用 | 已内置 `pnpm update` 兜底 |
| `ctx.shell` 执行器 | `lib/exec.js` | 命令跑不动 | 已内置 `child_process` 兜底 |

改完跑 `npm test`：25+ 条用例覆盖扫描、清单合并、命令拼装、兜底路径与打包契约，能在不看 UI 的情况下拦住大多数回归。

### 发版（维护者）

**npm 没有 "pending publisher"**：可信发布配置只能挂到**已存在**的包上（[npm-trust 文档](https://www.gsp.com/cgi-bin/man.cgi?topic=npm-trust)：*Package must exist*），staged publishing 同样要求包已存在。所以顺序是「先人工发一次 → 再切成可信发布」。

**第 0 步 · 人工发首个版本**（bypass-2FA 的 token 已被 npm 禁止直接发布，必须用 2FA 验证码）

```bash
npm login --registry https://registry.npmjs.org/
npm publish --registry https://registry.npmjs.org/ --otp=<6位验证码>
```

**第 1 步 · 配置 Trusted Publisher**（一次性；配置动作本身需要网页 2FA 交互）

打开 https://www.npmjs.com/package/dsh-plugin-management/access → **Trusted Publisher** → GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization or user | `YUYUY9527` |
| Repository | `dsh-plugin-management` |
| Workflow filename | `publish.yml` |
| Environment | 留空（若填了，每次发布还要过 GitHub environment 审批） |

可选加固：把该配置设为 **stage-only** —— 只接受 `npm stage publish`，直接 `npm publish` 会被拒。CI 只把 tarball 送进 stage 队列，再由你在网页上用 2FA 批准才真正上架（[staged publishing](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/)，需 npm CLI ≥ 11.15 / Node ≥ 22.14）。

**第 2 步 · 之后发版**

```bash
npm version patch && git push
git tag v1.0.1 && git push origin v1.0.1
```

`.github/workflows/publish.yml` 会跑 `npm run check` + `npm test`，然后以 OIDC + provenance 发布，本地不需要任何 token。
同一个包可以配多个可信发布者（[2026-09 起支持](https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm)），例如同时允许 release 工作流与手工 dispatch。

## 开发

```bash
npm test        # 无需 npm install：零运行时依赖，测试用 Node 内置 test runner
npm run check   # 全部 lib 文件语法检查
```

仓库结构：

```text
lib/scan.js        profile 扫描与名称守卫（纯 Node，可单测）
lib/exec.js        命令执行（ctx.shell 优先，child_process 兜底）
lib/inventory.js   清单 / 版本检查 / 更新 的业务实现
lib/tool.js        模型工具定义（参数 DSL → JSON Schema）
lib/index.js       host 入口：HTTP API + 工具注册
lib/client.js      client bundle：设置页「外部插件」tab
test/*.test.mjs    单测（含打包契约）
cordis.patch.yml   bundle 补丁层：插入一行插件
```

## License

[MIT](LICENSE)
