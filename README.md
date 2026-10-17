<div align="center">

<img src="./assets/icon.png" alt="Pixi" width="140" height="140">

# Pixi for Visual Studio Code

**Fast multi-language package management and workspace integration for Pixi in Visual Studio Code**

[![GitHub Release](https://img.shields.io/github/v/release/SheepTAO/pixi?style=flat-square&logo=github&label=Release)](https://github.com/SheepTAO/pixi/releases)
[![VS Code Marketplace](https://img.shields.io/badge/Marketplace-VS_Code-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi)
[![Open VSX](https://img.shields.io/badge/Open_VSX-Registry-purple?style=flat-square&logo=vscodium&logoColor=white)](https://open-vsx.org/extension/sheeptao/pixi)
[![CI Status](https://img.shields.io/github/actions/workflow/status/SheepTAO/pixi/ci.yaml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/SheepTAO/pixi/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

</div>

---

**Pixi** brings fast, reproducible package management and polyglot workspace workflows to Visual Studio Code. Built upon a decoupled, language-agnostic core architecture, it provides unified project discovery, task execution, terminal profiles, manifest actions, and automatic multi-language toolchain scanning.

> [!NOTE]
> **Language Adapter Status**: **Python** is fully supported with first-class environment integration via `@vscode/python-environments` (interpreter resolution, dynamic file-level environment routing, and package tree management). Automatic toolchain detection is also available for **C/C++**, **R**, and **Rust**, with additional language integrations planned.

---

## Pixi Explorer Side Panel

A dedicated Activity Bar container providing complete visibility and control over your Pixi workspace:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                             PIXI EXPLORER                              │
├────────────────────────────────────────────────────────────────────────┤
│ ENVIRONMENTS     │ Installed / Uninstalled / Incompatible              │
│                  │ ├── Explicit vs Transitive Dependencies             │
│                  │ └── 1-click Install, Reinstall, Lock & Terminal     │
├──────────────────┼─────────────────────────────────────────────────────┤
│ TASKS            │ Native Pixi Tasks Lifecycle                         │
│                  │ ├── Add & Remove Tasks via Guided UI Wizards        │
│                  │ ├── 1-click Run & Run in Custom Environment         │
│                  │ └── Jump to Task Definition in Manifest             │
├──────────────────┼─────────────────────────────────────────────────────┤
│ GLOBAL TOOLS     │ User-level CLI Apps (~/.pixi/bin)                   │
│                  │ └── Inspect, Install, Sync, Update & Uninstall      │
├──────────────────┼─────────────────────────────────────────────────────┤
│ PIXI INFO        │ CLI Version, System Platform, Virtual Packages      │
│                  │ ├── Authentication Storage & Stored Credentials     │
│                  │ └── Cache Disk Measurement & 1-click Cleanup        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

### Workspace & Environment Lifecycle

- **Automatic Project Discovery**: Instantly detects `pixi.toml` and `pyproject.toml` manifests across single-root and multi-root workspaces.
- **Dual Perspective Tree View**: Toggle between **Environment View** (runtime status, toolchains, installed packages) and **Feature View** (declared features, reusable dependencies, environment references) with 1-click (`$(organization)`).
- **Environment, Feature, Platform & System Requirements Hubs**: Centralized command hubs (`Pixi: Environment ...`, `Pixi: Feature ...`, `Pixi: Channel ...`, `Pixi: Platform ...`, and `Pixi: System Requirements ...`) to create, install, reinstall, configure environment features (`--force`), manage target platforms (including 1-click host auto-detection for OS, arch, and GPU CUDA virtual packages), channels, solve groups (`--solve-group`), and system hardware constraints (CUDA, glibc, Linux, macOS, Windows, archspec, UNIX) natively without writing raw TOML.
- **Solve Groups & Workspace Dependencies**: Native support for Pixi solve groups to co-solve environments, display solve groups and disk sizes in the sidebar, and manage workspace-level shared dependencies (`[workspace.dependencies]`) via `pixi workspace dependencies`.
- **Conda & PyPI Environment Import**: Import external Conda `environment.yml` or PyPI `requirements.txt` files directly into existing or new environments via `pixi import`.
- **Machine Registry & Monorepo Discovery**: Support for machine-wide workspace registration (`pixi workspace register`, `pixi workspace register list/remove`), cleaning disassociated registries (`pixi clean --workspaces-registry`), and auto-discovering registered sub-projects across monorepo workspaces.
- **Dual Environment Export**: Export environment specifications to standard Conda environment YAML (`pixi workspace export conda-environment`) or Conda Explicit Specification (`@EXPLICIT` via `pixi workspace export conda-explicit-spec`) for bit-for-bit reproducible deployments.
- **Unified Configuration Hub**: Native management for Pixi configuration across workspace local, user global, and system scopes (`pixi config list`, `set`, `unset`, `append`, `prepend`, `edit`).
- **Granular Cache & Cleanup Tools**: Native cache size calculation via `pixi info --extended`, granular cache cleaning for Conda packages, PyPI wheels, repodata index, temporary exec environments, and build backends (`pixi clean cache`), plus activation script cache cleanup (`pixi clean --activation-cache`).
- **Private Channel & Registry Authentication**: First-class support for `pixi auth` (login, logout, copy tokens, status). Authenticate with prefix.dev (token / OAuth), anaconda.org, or custom enterprise registries directly from the command hub or PIXI INFO panel.
- **Locked Dependency Inlay Hints & Navigation**: Displays actual locked package versions inline in manifests (`: 1.26.4`), rich hover inspection cards (build, channel, license, multi-environment matrix diffs), and `Ctrl`/`Cmd` + Click navigation directly to package entries in `pixi.lock`.
- **Offline Schema Validation & Manifest IntelliSense**: Bundles official Pixi JSON schema definitions locally for 100% offline autocompletion of manifest sections (`[workspace]`, `[tasks]`, `[dependencies]`, etc.), properties, channels, platforms, and rich hover documentation.
- **Manifest Editor Actions**: 1-click title bar buttons for manifest files to Lock, Install, Update, or Reinstall dependencies.
- **File-Level Environment Routing**: Map glob patterns directly to specific Pixi environments via `pixi.environmentRules` (e.g. `tests/**=dev`).
- **Lifecycle Diagnostics**: Categorizes environments into Installed (ready & executable), Uninstalled (declared in manifest, 1-click installable), and Incompatible (platform mismatch).

### Aggregated Package Search & Discovery

- **Dual-Source Search**: High-performance real-time search across Conda repositories (`conda-forge`, etc.) and PyPI with live autocompletion.
- **Rich Package Inspection**: View package versions, target platforms, licenses, descriptions, and jump directly to package pages on [prefix.dev](https://prefix.dev).
- **Dependency Diagnostics**: Inspect full dependency trees and diagnose package origin with reverse dependency tree inspection (_"Why is this package installed?"_).

### Python & Multi-Language Toolchains

- **Deep Python & Jupyter Integration**: Connects with `@vscode/python-environments` for seamless interpreter switching, status bar indicators, package inspection, and clean Pixi environment grouping in Jupyter notebook kernel selection with `ipykernel` safeguard detection.
- **Multi-Language Toolchain Scanner**: Automatically scans installed environments for Python, C/C++ compilers (GCC, Clang, MSVC, CMake, Ninja, header paths), R (`R`, `Rscript`), and Rust (`rustc`, `cargo`).

### Native Tasks, Terminals & Global Tools

- **Interactive Task Lifecycle**: Create new runnable tasks via guided wizards (name, shell command, environment, `--depends-on` task dependencies) and remove tasks directly from side panel actions or command palette.
- **Manifest Task Actions (Hover & CodeLens)**: Non-intrusive hover tooltips with full command previews and instant execution links, plus customizable CodeLens modes (compact, full, header-only, or off).
- **Intelligent Task Grouping**: Organize workspace tasks in the side panel by namespace prefix (`data-*`, `gui-*`), by target environment, or in a flat list with 1-click grouping switcher.
- **Native VS Code Tasks**: Auto-registers Pixi tasks as native VS Code tasks (`Terminal: Run Task...`) with a dedicated QuickPick runner and support for custom command-line arguments.
- **Pre-Configured Terminals**: Launch interactive terminal sessions with the target Pixi environment pre-activated.
- **Global Tools Management**: Easily inspect, install, update, and uninstall user-level CLI packages installed in `~/.pixi/bin`, inject extra dependencies (`pixi global add/remove`), expose custom executable aliases (`pixi global expose`), and view global dependency trees (`pixi global tree`).

---

## Essential Commands

Launch any command via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) by typing `Pixi:`:

| Command                                          | Identifier                     | Description                                                                                                             |
| :----------------------------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **Pixi: Initialize Project ...**                 | `pixi.init`                    | Initialize a new Pixi project (`pixi.toml` or `pyproject.toml`) or bootstrap from Conda `environment.yml` (`--import`). |
| **Pixi: Environment ...**                        | `pixi.environment`             | Interactive hub to create/delete environments, configure environment features, install, or open shells.                 |
| **Pixi: Feature ...**                            | `pixi.feature`                 | Interactive hub to create/remove features, add packages to a feature, or jump to feature definitions.                   |
| **Pixi: Channel ...**                            | `pixi.channel`                 | Interactive hub to add Conda presets/mirrors (prepend/append) or remove channels at workspace or feature scope.         |
| **Pixi: Platform ...**                           | `pixi.platform`                | Configure target platforms via check/uncheck picker at workspace or feature scope.                                      |
| **Pixi: Auto-detect & Add Host Platform**        | `pixi.platform.autoDetect`     | Auto-detect current host machine (OS, arch, GPU CUDA, glibc) and add as a rich target platform.                         |
| **Pixi: System Requirements ...**                | `pixi.systemRequirements`      | Configure project hardware & OS requirements (CUDA, libc, Linux, macOS, archspec, UNIX) with version presets.           |
| **Pixi: Authentication ...**                     | `pixi.auth`                    | Interactive hub to login, logout, copy tokens, or inspect authentication entries (`pixi auth`).                         |
| **Pixi: Search Packages ...**                    | `pixi.searchPackages`          | Search Conda & PyPI packages to inspect platforms, licenses, metadata, and docs.                                        |
| **Pixi: Add Package ...**                        | `pixi.addPackage`              | Add packages to features, inline environments, or global scope with channel/version picking.                            |
| **Pixi: Remove Package ...**                     | `pixi.removePackage`           | Remove packages from manifest with automatic feature/environment scope resolution.                                      |
| **Pixi: Install (Sync Environments)**            | `pixi.install`                 | Install dependencies and synchronize all project environments.                                                          |
| **Pixi: Reinstall ...**                          | `pixi.reinstall`               | Interactive menu to rebuild all environments or a specific environment.                                                 |
| **Pixi: Reinstall Package ...**                  | `pixi.reinstallPackage`        | Reinstall a specific package in an environment via `pixi reinstall <pkg> -e <env>`.                                     |
| **Pixi: Update / Upgrade ...**                   | `pixi.update`                  | Unified menu to check outdated packages (dry-run), update dependencies, or upgrade manifest.                            |
| **Pixi: Upgrade Dependencies ...**               | `pixi.upgrade`                 | Bump manifest version constraints for packages using configurable pinning strategies (`semver`, `minor`, etc.).         |
| **Pixi: Rename Workspace ...**                   | `pixi.setProjectName`          | Get or update the workspace name in project manifest via `pixi workspace name`.                                         |
| **Pixi: Bump / Set Workspace Version ...**       | `pixi.bumpVersion`             | Bump patch, minor, major, or set custom project version in `[workspace]` via `pixi workspace version`.                  |
| **Pixi: Manage Workspace Dependencies ...**      | `pixi.workspaceDependencies`   | View, add, or remove shared workspace dependencies in `[workspace.dependencies]` table.                                 |
| **Pixi: Import Environment File ...**            | `pixi.import`                  | Import Conda `environment.yml` or PyPI `requirements.txt` into an existing workspace environment.                       |
| **Pixi: Set Workspace Description ...**          | `pixi.setDescription`          | Get or update the workspace description in project manifest via `pixi workspace description`.                           |
| **Pixi: Set Minimum Pixi Requirement ...**       | `pixi.setRequiresPixi`         | Set, unset, or verify the minimum required Pixi version (`requires-pixi`) via `pixi workspace requires-pixi`.           |
| **Pixi: Manage Workspace Preview Flags ...**     | `pixi.managePreviewFlags`      | Inspect, enable, or disable workspace preview flags (such as `pixi-build`) via `pixi workspace preview`.                |
| **Pixi: Manage Environment Activation ...**      | `pixi.manageActivation`        | Configure environment activation scripts and environment variables via `pixi workspace activation`.                     |
| **Pixi: Configuration Management ...**           | `pixi.config`                  | Interactive hub to inspect, set, unset, append/prepend settings, or edit config files (`pixi config`).                  |
| **Pixi: Register Workspace in Registry ...**     | `pixi.workspace.register`      | Register project path in machine-wide workspace registry (`pixi workspace register`).                                   |
| **Pixi: Unregister Workspace from Registry ...** | `pixi.workspace.unregister`    | Remove workspace from machine-wide registry (`pixi workspace register remove`).                                         |
| **Pixi: Run in Temporary Environment ...**       | `pixi.exec`                    | Run arbitrary tools and commands inside a disposable temporary environment via `pixi exec`.                             |
| **Pixi: Export Environment ...**                 | `pixi.exportEnvironment`       | Export environment to Conda YAML (`environment.yaml`) or Conda Explicit Spec (`@EXPLICIT`).                             |
| **Pixi: Lock Dependencies**                      | `pixi.lock`                    | Solve dependencies and update the lockfile without modifying environments.                                              |
| **Pixi: Check Lockfile Drift**                   | `pixi.checkLockfile`           | Verify if `pixi.lock` is up-to-date with project manifest (`pixi lock --check`) with 1-click update action.             |
| **Pixi: Clean ...**                              | `pixi.clean`                   | Interactive menu to clean project environments, single env, activation cache, build cache, or registry.                 |
| **Pixi: Clean Package Cache ...**                | `pixi.cleanCache`              | Granular cleanup menu for global Conda, PyPI, repodata, exec, or build package caches.                                  |
| **Pixi: Add Task ...**                           | `pixi.tasks.addTask`           | Guided wizard to create a new task in manifest with optional description (`--description`) and dependencies.            |
| **Pixi: Add Task Alias ...**                     | `pixi.tasks.addAlias`          | Create composite alias tasks running multiple tasks sequentially via `pixi task alias`.                                 |
| **Pixi: Run Task ...**                           | `pixi.runTask`                 | QuickPick menu to search and run any task defined in the project.                                                       |
| **Pixi: Run Task with Arguments ...**            | `pixi.runTaskWithArgs`         | Run a task with custom command-line arguments.                                                                          |
| **Pixi: Open Terminal in Environment ...**       | `pixi.openTerminal`            | Open an integrated terminal pre-activated in a selected environment.                                                    |
| **Pixi: Open Manifest**                          | `pixi.openManifest`            | Open the project manifest file (`pixi.toml` or `pyproject.toml`).                                                       |
| **Pixi: Open Lockfile**                          | `pixi.openLockfile`            | Open `pixi.lock` and inspect resolved package records.                                                                  |
| **Pixi: Show Dependency Tree**                   | `pixi.showDependencyTree`      | Inspect the full resolved dependency hierarchy for an environment or package.                                           |
| **Pixi: Why is This Installed? (Reverse Tree)**  | `pixi.whyPackage`              | Trace reverse dependency chains explaining why a package is installed.                                                  |
| **Pixi: Global Tools ...**                       | `pixi.global`                  | Interactive menu to install, list, inject dependencies, expose aliases, and uninstall global CLI tools.                 |
| **Pixi: Add Dependency to Global Tool ...**      | `pixi.global.addDependency`    | Add extra packages to an existing global tool environment (`pixi global add -e <tool> <pkgs>`).                         |
| **Pixi: Remove Dependency from Global Tool ...** | `pixi.global.removeDependency` | Remove extra packages from a global tool environment (`pixi global remove -e <tool> <pkgs>`).                           |
| **Pixi: Expose Binary Mapping ...**              | `pixi.global.expose`           | Expose or alias an executable from a global environment (`pixi global expose add`).                                     |
| **Pixi: View Global Tool Dependency Tree**       | `pixi.global.tree`             | Inspect dependency hierarchy of a globally installed CLI tool (`pixi global tree <tool>`).                              |
| **Pixi: Update Pixi CLI ...**                    | `pixi.selfUpdate`              | Check for updates, preview release notes (dry-run), or install target Pixi version.                                     |

> [!TIP]
> Contextual and view-specific actions (such as switching Environment/Feature or Task grouping modes via view title buttons, creating/removing features and environments, adding/removing tasks or packages, jumping to manifest declarations, and running tasks in custom environments) are also directly available via inline icon buttons and right-click context menus in the Pixi Explorer tree views and editor title bar.

---

## Extension Settings

| Setting                                        | Type       | Default                 | Scope    | Description                                                                                             |
| :--------------------------------------------- | :--------- | :---------------------- | :------- | :------------------------------------------------------------------------------------------------------ |
| `pixi.executablePath`                          | `string`   | `""`                    | Machine  | Path to the Pixi binary. Discovered from system `PATH` if empty.                                        |
| `pixi.displayNameFormat`                       | `string`   | `"${project}:${env}"`   | Resource | Display format for environments. Placeholders: `${project}`, `${env}`, `${version}`.                    |
| `pixi.defaultManifestFormat`                   | `string`   | `"ask"`                 | Resource | Default manifest format for project initialization (`"ask"`, `"pixi"`, or `"pyproject"`).               |
| `pixi.autoInstallOnOpen`                       | `string`   | `"prompt"`              | Resource | Behavior when opening projects with uninstalled environments (`"prompt"`, `"always"`, `"never"`).       |
| `pixi.executionMode`                           | `string`   | `"smart"`               | Resource | Execution mode for package/environment tasks (`"smart"`, `"terminal"`, `"notification"`).               |
| `pixi.environmentRules`                        | `string[]` | `[]`                    | Resource | Map glob patterns to environment names (e.g. `tests/**=dev`, `train/**=gpu`).                           |
| `pixi.terminal.defaultEnvironment`             | `string`   | `""`                    | Resource | Default environment name to activate when opening a Pixi terminal (prompts if empty).                   |
| `pixi.terminal.activationMode`                 | `string`   | `"shellHook"`           | Resource | Mechanism used to activate Pixi terminal (`"shellHook"` via environment variables, or `"shell"`).       |
| `pixi.packageSearch.maxResults`                | `integer`  | `5`                     | Resource | Maximum number of Conda packages to display in search and package add pickers.                          |
| `pixi.packages.displayMode`                    | `string`   | `"grouped"`             | Resource | Package tree display mode (`"grouped"`, `"explicitOnly"`, or `"all"`).                                  |
| `pixi.environments.viewMode`                   | `string`   | `"environment"`         | Resource | Environments view grouping mode (`"environment"` or `"feature"`).                                       |
| `pixi.environments.systemRequirementsPosition` | `string`   | `"bottom"`              | Resource | Placement of System Requirements in Environments view (`"bottom"`, `"top"`, `"hidden"`).                |
| `pixi.cache.autoMeasureSize`                   | `boolean`  | `true`                  | Window   | Automatically compute Pixi cache disk usage in Pixi Info.                                               |
| `pixi.tasks.groupBy`                           | `string`   | `"prefix"`              | Resource | Task grouping mode in Tasks view (`"prefix"`, `"environment"`, `"none"`).                               |
| `pixi.tasks.prefixSeparators`                  | `string[]` | `["-", "_", ":", "::"]` | Resource | Delimiters used to parse namespace prefixes from task names.                                            |
| `pixi.tasks.minGroupSize`                      | `integer`  | `2`                     | Resource | Minimum tasks required to form a prefix group folder (isolated tasks stay flat).                        |
| `pixi.tasks.maxDepth`                          | `integer`  | `1`                     | Resource | Maximum nesting depth for prefix-based task groups (1–3).                                               |
| `pixi.tasks.manifestActions`                   | `string`   | `"hover"`               | Resource | Display style for task actions in manifests (`"hover"`, `"compact"`, `"full"`, `"header"`, `"off"`).    |
| `pixi.dependencies.inlayHints`                 | `boolean`  | `true`                  | Resource | Show locked dependency versions as inline hints in manifests (`pixi.toml`, `pyproject.toml`).           |
| `pixi.manifest.schemaSupport`                  | `boolean`  | `true`                  | Resource | Enable offline schema-based autocompletion and hover documentation in `pixi.toml` and `pyproject.toml`. |

### Example Configuration

Add this to your project's `.vscode/settings.json`:

```json
{
    "pixi.environmentRules": ["tests/**=dev", "train/**=train", "scripts/*.py=dev"],
    "pixi.defaultManifestFormat": "pixi",
    "pixi.displayNameFormat": "${project}:${env} (${version})",
    "pixi.packages.displayMode": "grouped",
    "pixi.tasks.groupBy": "prefix"
}
```

---

## Public Extension API

Other VS Code extensions can programmatically access Pixi's workspaces, environments, and toolchains:

```typescript
import * as vscode from 'vscode';
import type { PixiExtensionApi } from 'sheeptao.pixi';

const pixi = vscode.extensions.getExtension<PixiExtensionApi>('sheeptao.pixi')?.exports;
if (pixi) {
    const projectPaths = pixi.getProjectPaths();
    const envs = pixi.getAllEnvironments();
    const packages = await pixi.getPackages('default', projectPaths[0]);

    // Active environment management
    const activeEnv = await pixi.getActiveEnvironment();
    await pixi.setActiveEnvironment(undefined, 'default');

    pixi.onDidChangeActiveEnvironment((e) => {
        console.log('Active environment changed:', e.environment?.pixiEnvName);
    });
}
```

---

## Requirements & Quick Start

1. Install [Pixi](https://pixi.sh) (>= 0.80.0) on your system.
2. Install **Pixi** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi) or [Open VSX](https://open-vsx.org/extension/sheeptao/pixi).
3. _(Optional for Python)_ Install the official [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension for Python interpreter and package integration.
4. Open any workspace containing a `pixi.toml` or `pyproject.toml`.

---

## Troubleshooting

- **Check Output Logs**: Open `View` → `Output` and select `Pixi` from the dropdown. To view detailed diagnostic logs (file scanning, background processes), run **Developer: Set Log Level...** from the Command Palette, select **Pixi**, and set to **Trace** or **Debug**.
- **Binary Not Found**: Verify `pixi` is available in your system `PATH`, or set `pixi.executablePath`.
- **Environments Not Showing**: Ensure `pixi.toml` exists and run `pixi.install` to initialize environment prefixes.

---

## Acknowledgements & License

- Special thanks to [Renan Santos](https://github.com/renan-r-santos) and contributors of [pixi-code](https://github.com/renan-r-santos/pixi-code) for creating the original foundation.
- Thanks to the [Prefix.dev](https://prefix.dev) team for building the incredible [Pixi](https://pixi.sh) package manager and ecosystem.
- Licensed under the [MIT License](LICENSE).
