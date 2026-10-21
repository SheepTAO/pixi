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

**Pixi for Visual Studio Code** provides workspace integration for [Pixi](https://pixi.sh) projects, including visual environment management, Conda and PyPI package search, task execution, integrated terminals, and Python / Jupyter environment support.

---

## Quick Start

1. **Install Pixi**: Make sure [Pixi CLI](https://pixi.sh) is installed on your system.
2. **Install Extension**: Install **Pixi** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi) or [Open VSX](https://open-vsx.org/extension/sheeptao/pixi).
3. **Open Project**: Open any folder containing a `pixi.toml` or `pyproject.toml`. Environments and tasks are detected automatically.

### Requirements & Compatibility

- **Minimum Version**: **`>= 0.60.0`** (supports all daily workflows: environments, packages, tasks, terminals, Python, and search).
- **Recommended Version**: **`>= 0.79.0`** (or `latest`) for complete access to modern workspace CLI features:

| Feature                            | Minimum Pixi | Fallback on Older Pixi (< 0.79.0)                    |
| :--------------------------------- | :----------- | :--------------------------------------------------- |
| **Workspace Dependencies**         | `0.79.0+`    | Add via feature scope or edit manifest               |
| **Activation Environment Config**  | `0.77.0+`    | Configure manually in manifest `[activation]`        |
| **Preview Flags**                  | `0.77.1+`    | Configure manually in manifest `[workspace.preview]` |
| **Host Platform Auto-Detection**   | `0.71.0+`    | Select target platforms manually from Conda presets  |
| **Machine Workspace Registration** | `0.70.0+`    | Multi-root project discovery works automatically     |

_Note: You can upgrade Pixi at any time by running `pixi self-update` in your terminal or via **Pixi: Update Pixi CLI ...** in VS Code._

---

## Features

### Visual Environments & Workspaces

- **Project Auto-Discovery**: Instantly recognizes `pixi.toml` and `pyproject.toml` across single-root and multi-root workspaces.
- **Dual Perspective Tree**: Toggle between **Environment View** (runtime status, installed packages, toolchains) and **Feature View** (declared features, dependencies).
- **One-Click Actions**: Install, synchronize, update, lock, or export environments (Conda YAML / Explicit specs) directly from the Activity Bar.

### Unified Package Search & Dependencies

- **Dual-Source Search**: Search Conda (`conda-forge`) and PyPI packages with autocompletion.
- **Dependency Diagnostics**: Inspect full resolved dependency trees and reverse search (_"Why is this package installed?"_).
- **Locked Inlay Hints**: View resolved package versions inline in manifests (`: 1.26.4`) with rich hover cards and lockfile navigation.

### Tasks & Pre-Activated Terminals

- **Run Tasks**: Run tasks from the Activity Bar, Command Palette, or manifest CodeLens and hover previews.
- **Smart Grouping**: Group tasks by prefix (`test-*`, `build-*`) or environment to keep large projects organized.
- **Integrated Terminals**: Launch terminals pre-activated in any Pixi environment with one click.
- **Global Tools**: Inspect, install, update, and manage standalone CLI tools in `~/.pixi/bin`.

### Python & Multi-Language Support

- **Python & Jupyter**: Automatic interpreter selection and Jupyter Notebook kernel registration via `@vscode/python-environments`.
- **Multi-Language Toolchains**: Auto-detects compilers and toolchains in active environments for C/C++ (GCC, Clang, CMake), R, and Rust.

---

## Commands

QuickPick menus provide access to common workflows. Press `Ctrl+Shift+P` / `Cmd+Shift+P` and type `Pixi:`:

| Command Hub                                | Description                                                                          |
| :----------------------------------------- | :----------------------------------------------------------------------------------- |
| **Pixi: Workspace ...**                    | Manage workspace properties, shared dependencies, channels, platforms, and lockfile. |
| **Pixi: Environment ...**                  | Create, delete, reinstall, configure, export, and manage environments and features.  |
| **Pixi: Search Packages ...**              | Real-time search across Conda and PyPI with platform, license, and doc previews.     |
| **Pixi: Add Package ...**                  | Add dependencies to specific environments, features, or workspace-wide scope.        |
| **Pixi: Remove Package ...**               | Remove packages with automatic feature/environment scope resolution.                 |
| **Pixi: Run Task ...**                     | Search and run any defined project task with optional custom CLI arguments.          |
| **Pixi: Open Terminal in Environment ...** | Open an integrated terminal pre-activated in the selected environment.               |
| **Pixi: Configuration Management ...**     | Inspect and edit Pixi settings across workspace/user/system scopes.                  |
| **Pixi: Authentication ...**               | Log in, log out, copy tokens, or check status (`pixi auth`).                         |
| **Pixi: Global Tools ...**                 | Manage user-level CLI packages, aliases, and dependency trees.                       |

---

## Key Settings

Customize extension behavior in your VS Code `settings.json`:

| Setting                                 | Default                          | Description                                                                          |
| :-------------------------------------- | :------------------------------- | :----------------------------------------------------------------------------------- |
| `pixi.executablePath`                   | `""`                             | Path to `pixi` binary (auto-discovered from `PATH` by default).                      |
| `pixi.executionMode`                    | `"smart"`                        | Command output mode: `"smart"`, `"terminal"`, or `"notification"`.                   |
| `pixi.environmentRules`                 | `[]`                             | Route files/folders to environments (e.g. `["tests/**=dev", "train/**=gpu"]`).       |
| `pixi.environments.showToolchains`      | `true`                           | Display detected toolchains (`Python`, `C++`, `Rust`, `R`) in environment tree.      |
| `pixi.environments.showWorkspaceHeader` | `true`                           | Display pinned workspace overview item (name, version, manifest) in single projects. |
| `pixi.toolchains.scanLanguages`         | `["python", "cpp", "rust", "r"]` | Languages to scan for toolchains (clear to `[]` to disable detection).               |
| `pixi.terminal.autoActivateOnCreate`    | `false`                          | Automatically activate default Pixi environment in standard integrated terminals.    |
| `pixi.lockfile.checkOnSave`             | `false`                          | Automatically detect lockfile drift when saving manifests.                           |
| `pixi.tasks.groupBy`                    | `"prefix"`                       | Organize task tree by `"prefix"`, `"environment"`, or `"none"`.                      |
| `pixi.tasks.manifestActions`            | `"hover"`                        | Manifest task action style: `"hover"`, `"compact"`, `"full"`, or `"off"`.            |
| `pixi.dependencies.inlayHints`          | `true`                           | Show resolved package versions inline in `pixi.toml` and `pyproject.toml`.           |
| `pixi.manifest.dependencyHover`         | `true`                           | Display rich package hover cards in manifest files.                                  |
| `pixi.packages.checkForUpdates`         | `false`                          | Automatically detect package updates and show upgrade hints in tree and manifests.   |

_Tip: Search `@ext:sheeptao.pixi` in VS Code Settings (`Ctrl+,` / `Cmd+,`) to browse all available options._

---

## Troubleshooting

- **Check Output Logs**: Open `View` → `Output` and select **Pixi** from the dropdown. Set log level via **Developer: Set Log Level...** → **Pixi** → **Debug** for verbose traces.
- **Binary Not Found**: Verify `pixi` is available in your system `PATH`, or set `pixi.executablePath` in Settings.
- **Environments Not Showing**: Ensure `pixi.toml` exists and run **Pixi: Install (Sync Environments)** to initialize environment prefixes.

---

## Acknowledgements & License

- Special thanks to [Renan Santos](https://github.com/renan-r-santos) and contributors of [pixi-code](https://github.com/renan-r-santos/pixi-code) for creating the original foundation.
- Thanks to the [Prefix.dev](https://prefix.dev) team for building the [Pixi](https://pixi.sh) package manager and ecosystem.
- Licensed under the [MIT License](LICENSE).
