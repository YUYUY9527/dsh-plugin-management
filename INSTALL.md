# 安装手册 · dsh-plugin-management

> 给第一次接触的人 / agent 看。装完用第 4 节验证，装不上看第 5 节排查，想撤看第 6 节。
> 前置：本机有 `dsh`（`dsh --version` 有输出）与 `pnpm`（`dsh plugin` 内部要转发给它）。

---

## 1. 这是什么（30 秒）

一个 dsh 插件包。装进某个 profile 后：
**设置 → 插件** 多一个「外部插件」tab，列出该 profile 装的所有第三方插件（版本 / 有没有更新 / 是否真的生效为插件层），并支持一键更新。

---

## 2. 三种安装方式

### 方式 A：本地目录（开发 / 自用，推荐）

```powershell
dsh plugin --profile web add D:\fubin\dev\mini-tools\dsh\dsh-plugin-management
```

- `--profile web` 必须是**你实际在跑的 profile**（`dsh web` → `web`；跑的是别的名字就换成别的）。
- pnpm 会以 `link:` 形式接入本地目录，所以**改完代码不用重装，重启即可生效**。
- 纯 JS、无构建步骤，不需要 npm install。

### 方式 B：GitHub（发布 / 分享）

```bash
dsh plugin --profile web add github:YUYUY9527/dsh-plugin-management
```

> git 安装不需要本机有 TypeScript / 构建链——本包 `lib/*.js` 就是产物。
> 这也是刻意选纯 JS 的原因：pnpm 默认会拦截 git 包的 `prepare` 构建脚本，TS 插件常常卡在这一步。

### 方式 C：npm（若已发布到 registry）

```bash
dsh plugin --profile web add dsh-plugin-management
```

### 方式 D：Release 包（固定版本 / 走内网分发）

从 [Releases](https://github.com/YUYUY9527/dsh-plugin-management/releases) 下载 `dsh-plugin-management-<版本>.tgz`，然后：

```powershell
dsh plugin --profile web add D:\下载目录\dsh-plugin-management-1.0.0.tgz
```

适合需要**锁定版本**或走内网分发的场景；tgz 里已包含 `lib/`、`cordis.patch.yml` 与文档，无需构建。

### 装完必做：重启 dsh

bundle 的装配在**启动时**完成（读 `dsh.profile.bundles`，逐个应用其 `cordis.patch.yml`）。
不重启，插件不会加载。

---

## 3. 装配结果自检

`dsh plugin add` 成功后会顺手把包名写进 `dsh.profile.bundles`（因为它声明了 `dsh.bundle.patch`）。
直接看文件最直观：

```powershell
Get-Content "$env:DSH_HOME\profiles\web\package.json" -Raw
```

应该能看到：

```json
{
  "dependencies": { "dsh-plugin-management": "link:D:/.../dsh-plugin-management" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-management"] } }
}
```

再看组合后的树是否包含这一行：

```powershell
dsh --profile web --dump-config | Select-String dsh-plugin-management
# - id: dsh-plugin-management
#   name: dsh-plugin-management
#   config: {}
```

---

## 4. 验证是否装好（重启后）

1. **看 UI**：打开 **设置 → 插件**，应有「外部插件」tab（在官方 `configurable` / `all` 之后）。
   点进去应列出该 profile 的外部插件，并能看到「可更新到 x.y.z / 已是最新」。
2. **问 agent**（模型工具）：
   ```text
   external_plugins action=list
   ```
3. **看日志**：启动日志里若有 `dsh-plugin-management` 相关告警，多半是 `webServer` 路由撞车（见下）。

---

## 5. 排查表

| 症状 | 原因与解法 |
| --- | --- |
| 装完重启后设置里没有「外部插件」tab | ① 装错 profile：`--profile` 必须与启动命令一致（`dsh web` → `web`）② 没重启 ③ `package.json` 的 `dsh.client.platform` 或 `exports["./client"]` 被改动（两者缺一，client bundle 不会被发现） |
| tab 在，但一直「读取中…」或报 `HTTP 404` | `webServer` 没挂载，或 `apiPath` 与别的插件路由撞了（同名 `kind+path` 直接抛错）。改 `config.apiPath` 后重启 |
| 报 `duplicate route` / 启动失败 | 同上：两个插件注册了同一个前缀路由，改 `apiPath` |
| 「版本检查失败：…」 | `pnpm outdated` 失败：pnpm 不在 PATH、registry 不可达、或 profile 目录里没有 lockfile。清单本身仍可用，只是没有「最新版本」列 |
| 点「更新」报 `dsh: not recognized` | 插件会自动回落 `pnpm update`；若两者都不行，说明 `dsh` 与 `pnpm` 都不在该进程 PATH 里，用完整路径重启 dsh，或手动在 profile 目录跑 `pnpm update <pkg>` |
| 更新成功但界面/功能没变 | **正常**：文件已替换，但进程里还是旧代码。重启 dsh |
| 报 `duplicate loader entry id` | profile 的 `cordis.patch.yml` 里同 id 出现了两次（手动 patch 重复粘贴过）。删掉重复项，保持文件是单一顶层值 |
| 列表里少了我装的插件 | 它不在该 profile 的 `dependencies` 里（例如装在别的 profile），或是官方 `@deepseek-ai/*` 包（本插件只列外部包） |
| 某行显示「非插件层」 | 依赖装上了，但没进 `dsh.profile.bundles`：该包没有声明 `dsh.bundle.patch`（是普通库），或被后来层的 patch 挤掉了 |
| 某行显示「本地链接」 | 依赖写的是 `link:` / `file:` / `workspace:`，不来自 registry，因此不提供更新 |

---

## 6. 卸载 / 回滚

```bash
# 官方路径：从依赖与 bundles 里摘掉
dsh plugin --profile web remove dsh-plugin-management
```

重启后 tab 消失即卸载完成。

**只想临时关掉**（保留包与数据）：在 profile 的 `cordis.patch.yml` 里加一行禁用，重启即可：

```yaml
- id: dsh-plugin-management
  disabled: true
```

---

## 7. 给 agent 的一句话

> 本环境装有 dsh-plugin-management：`external_plugins` 工具可查当前 profile 的外部插件清单（版本 / 是否可更新 / 是否生效为插件层），
> 也可直接更新（`action=update`，`latest=true` 走跨大版本）。用户在「设置 → 插件 → 外部插件」有等价 UI。
> 更新后**必须重启 dsh** 才加载新版本。
