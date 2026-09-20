# dsh-plugin-management

English | [中文](README.md)

An **external plugin manager** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
see which third-party plugins a profile has installed, what versions they are on, whether updates exist —
and update them with one click from **Settings → Plugins → External plugins**.

> The shipped *Plugins* settings page answers "which plugins are **loaded**" (Loader entries, enablement, fiber phase).
> This plugin answers "which external packages are **installed**" (npm version, updatability, whether the dependency is really an active plugin layer). They complement each other.

## Features

| Capability | Detail |
| --- | --- |
| Inventory | Every non-`@deepseek-ai/*` dependency of the profile: installed version, range, whether it is an active `dsh.profile.bundles` layer, registry package or local `link:` |
| Update check | `pnpm outdated --format json`, distinguishing in-range updates from major upgrades (which need `--latest`) |
| One-click update | per plugin, all updatable plugins, or major upgrade |
| Visible result | full command, exit code, stdout/stderr tail, plus a **restart required** notice |
| Profile switch | auto-detects the profile actually running, switchable by hand |
| Model tool | registers `external_plugins` (`action: list \| update`) so an agent can inspect and update by itself |
| Bilingual | UI copy follows the active `locale` (zh / en) |

## Install

```bash
# A. local directory (development / self-use)
dsh plugin --profile web add /path/to/dsh-plugin-management

# B. GitHub (plain JS, no build step — git installs cannot be blocked by pnpm's build gate)
dsh plugin --profile web add github:YUYUY9527/dsh-plugin-management

# C. npm (when published)
dsh plugin --profile web add dsh-plugin-management
```

Use the profile you actually run (`dsh web` → `web`), then **restart dsh** (bundles are composed at boot).

Verify the bundle was registered:

```bash
dsh --profile web --dump-config | grep dsh-plugin-management
```

See [INSTALL.md](INSTALL.md) (Chinese) for verification and troubleshooting.

## Usage

**Settings → Plugins → "External plugins" tab.** The header has a profile selector, `Refresh` and `Update all (N)`;
each row shows the package, installed version · range, status badges, and its own `Update` / `Upgrade` buttons.
The panel first renders the local inventory (fast) and then adds a registry version check.

**Model tool:**

```text
external_plugins action=list
external_plugins action=list check=false
external_plugins action=update profile=web
external_plugins action=update names=["dsh-tinyfish-search"] latest=true
```

**HTTP API** (default prefix `/dsh-plugin-management/api`, same-origin only):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/inventory?profile=&check=1&refresh=1` | inventory; `check=1` queries the registry |
| `POST` | `/update` | body `{ profile?, names?, latest? }`; runs the update |

## How it decides

```text
$DSH_HOME/profiles/<profile>/package.json
  dependencies         → installed packages   (external = not "@deepseek-ai/*")
  dsh.profile.bundles  → active plugin layers
$DSH_HOME/profiles/<profile>/node_modules/<pkg>/package.json
  version              → installed version
  dsh.bundle.patch     → is it a real bundle?
```

Updates go through **`dsh plugin --profile <p> update ...`** (the official forwarder, which also reconciles
`dsh.profile.bundles` against the installed state), falling back to **`pnpm update ...`** when `dsh` is not on PATH.

## Configuration

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-plugin-management
  config:
    apiPath: /dsh-plugin-management/api   # only needed if another route collides
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-management
```

## Design notes

- **Plain JavaScript, zero build** — `lib/*.js` is both source and artifact, so `github:` installs need no local build toolchain.
- **No hard dependencies** — `webServer` / `tools` / `shell` / `clientModules` are all fetched lazily; a missing service costs one capability, never the whole plugin.
- **Two tool paths** — the official `defineTool` (with argument validation) when `@deepseek-ai/dsh-tools` resolves, a local JSON Schema registration otherwise.
- **No auto-restart** — updating files is not the same as loading them; the panel says so instead of restarting your process.

## Maintenance after a dsh upgrade

The plugin depends on documented dsh conventions, not internals. [README.md](README.md#维护指南dsh-升级后看哪里)
carries a table mapping each convention to the single place that would need to change
(profile layout, `$DSH_HOME` precedence, the `settings.plugins.tab` slot, the `dsh.client` discovery contract,
`webServer.register`, `pnpm outdated` output, `dsh plugin update`, `ctx.shell`).
`npm test` runs 25+ unit tests — including packaging-contract tests — without installing anything.

## License

[MIT](LICENSE)
