<div align="center">

<img src="./assets/icon.png" alt="Pixi" width="140" height="140">

# Pixi for Visual Studio Code

**Fast multi-language package management and workspace integration for Pixi in Visual Studio Code**

[![GitHub Release](https://img.shields.io/github/v/release/SheepTAO/pixi?style=flat-square&logo=github&label=Release)](https://github.com/SheepTAO/pixi/releases)
[![VS Code Marketplace](https://img.shields.io/badge/Marketplace-VS_Code-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi)
[![Open VSX](https://img.shields.io/badge/Open_VSX-Registry-purple?style=flat-square&logo=vscodium&logoColor=white)](https://open-vsx.org/extension/sheeptao/pixi)
[![CI Status](https://img.shields.io/github/actions/workflow/status/SheepTAO/pixi/ci.yaml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/SheepTAO/pixi/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**Pixi** brings seamless [Pixi](https://pixi.sh) package management and environment workflows to Visual Studio Code. Built upon a decoupled, language-agnostic core architecture, it provides unified project discovery, task execution, terminal profiles, manifest actions, and automatic multi-language toolchain scanning.

> [!NOTE]
> **Language Adapter Status**: Currently, **Python** is fully supported with first-class environment integration via `@vscode/python-environments` (interpreter resolution, dynamic file-level environment routing, and package tree management). Automatic toolchain detection is also available for **C/C++**, **R**, and **Rust**, with additional language integrations planned.

---

## ✨ Features

- **Language-Agnostic Core Architecture**: Cleanly decouples Pixi core workspace operations (manifest lifecycle, environments, dependencies, tasks, terminals) from specific language adapters.
- **First-Class Python Integration**: Seamlessly integrates with `@vscode/python-environments`, providing interpreter switching, status bar indicators, and package inspection.
- **Polyglot Toolchain Detection**: Automatically scans installed environments for multi-language toolchains (Python, C/C++ compilers and header paths, R, Rust) to power language tooling and extension workflows.
- **Automatic Workspace Discovery**: Instantly detects Pixi projects with `pixi.toml` or `pyproject.toml`, discovering and diagnosing all declared environments.
- **Manifest Lifecycle & Editor Actions**: One-click action buttons in the editor title bar for `pixi.toml` and `pyproject.toml` (Lock 🔒, Install ⬇️, Update 🔄, Reinstall 🔁).
- **Environment & Dependency Management**: Create and delete environments (`pixi workspace environment add/remove`, `pixi clean`), sync environments (`pixi install`), solve dependencies (`pixi lock`), and add/remove packages with full Conda and PyPI channel support.
- **Native Pixi Tasks Integration**: Auto-discovers Pixi tasks as native VS Code Tasks (`Terminal: Run Task...`) and provides a QuickPick runner (`Pixi: Run Task`).
- **Unified Terminal Profiles**: Launch interactive terminals pre-activated in any Pixi environment directly from the terminal profile menu or Command Palette.
- **Dynamic Per-File Environment Rules**: Map file and directory patterns (e.g. `tests/**` → `dev`, `train/**` → `train`) to automatically switch active environments and interpreters.
- **Extensible Public Extension API**: Exports `PixiExtensionApi` for third-party extensions to query Pixi projects, environments, toolchains, packages, and subscribe to change events.
- **Lifecycle Status Diagnostics**: Categorizes environments into Installed (ready & executable), Uninstalled (declared in manifest, 1-click installable), and Incompatible (platform mismatch).

---

## ⚙️ Extension Settings

| Setting                     | Type       | Default                       | Scope    | Description                                                                                                |
| :-------------------------- | :--------- | :---------------------------- | :------- | :--------------------------------------------------------------------------------------------------------- |
| `pixi.executablePath`       | `string`   | `""`                          | Machine  | Path to the Pixi binary. Supports `${workspaceFolder}` and relative paths. Uses `PATH` discovery if empty. |
| `pixi.displayNameFormat`    | `string`   | `"${project}:${env}"`         | Resource | Template for environment names. Placeholders: `${project}`, `${env}`, `${python}`.                         |
| `pixi.environmentRules`     | `string[]` | `[]`                          | Resource | Map glob patterns to Pixi environment names (e.g. `tests/**=dev`). Also supports object format in JSON.    |
| `pixi.searchIgnorePatterns` | `string[]` | `["**/node_modules/**", ...]` | Resource | Glob patterns to exclude when scanning the workspace for Pixi projects.                                    |

### Example Configuration

Add this to your project's `.vscode/settings.json`:

```json
{
    "pixi.environmentRules": ["tests/**=dev", "train/**=train", "scripts/*.py=dev"]
}
```

---

## ⌨️ Commands

| Command                                   | Identifier                  | Description                                                                                                      |
| :---------------------------------------- | :-------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **Pixi: Lock Dependencies**               | `pixi.lock`                 | Solve and update lockfile (`pixi.lock`) without modifying environments.                                          |
| **Pixi: Install (Sync Environments)**     | `pixi.install`              | Install all dependencies and sync environments for the selected Pixi project.                                    |
| **Pixi: Reinstall Environment...**        | `pixi.reinstall`            | Re-install a specific environment or all environments from scratch.                                              |
| **Pixi: Update Dependencies**             | `pixi.update`               | Update dependencies and lockfile according to project constraints.                                               |
| **Pixi: Clean...**                        | `pixi.clean`                | Clean specific environments, all environments in project, or global package cache.                               |
| **Pixi: Create Environment...**           | `pixi.createEnvironment`    | Create a new Pixi environment in the project (or initialize a new project).                                      |
| **Pixi: Delete Environment...**           | `pixi.deleteEnvironment`    | Delete or clean a Pixi environment from disk and manifest with safety confirmation.                              |
| **Pixi: Initialize Project...**           | `pixi.init`                 | Initialize a new Pixi project in the workspace folder (`pixi.toml` or `pyproject.toml`).                         |
| **Pixi: Add Package...**                  | `pixi.addPackage`           | Add dependencies with interactive source selection (Conda, PyPI, Custom Index/Mirror, Local Path/Editable, Git). |
| **Pixi: Remove Package...**               | `pixi.removePackage`        | Interactively pick and remove an installed package (auto-detects Conda vs PyPI).                                 |
| **Pixi: Add Channel...**                  | `pixi.addChannel`           | Add a Conda channel or mirror URL to the project manifest with priority placement.                               |
| **Pixi: Remove Channel...**               | `pixi.removeChannel`        | Interactively pick and remove a configured Conda channel from the project manifest.                              |
| **Pixi: Run Task**                        | `pixi.runTask`              | QuickPick menu to search and run any task defined in the Pixi project.                                           |
| **Pixi: Run Task in Environment...**      | `pixi.runTaskInEnvironment` | Select a task and choose a specific Pixi environment to run it in.                                               |
| **Pixi: Open Terminal in Environment...** | `pixi.openTerminal`         | Open a dedicated VS Code terminal inside a selected Pixi environment.                                            |
| **Pixi: Global Tools ...**                | `pixi.global`               | Interactive management for global CLI tools (install, list, sync, update, uninstall, open manifest).             |

---

## 🔌 Public Extension API

Other VS Code extensions (e.g. language tools, Linters, or custom IDE workflows) can consume Pixi's API:

```typescript
import * as vscode from 'vscode';
import type { PixiExtensionApi } from 'sheeptao.pixi';

const pixi = vscode.extensions.getExtension<PixiExtensionApi>('sheeptao.pixi')?.exports;
if (pixi) {
    const projectPaths = pixi.getProjectPaths();
    const envs = pixi.getAllEnvironments();
    const packages = await pixi.getPackages('default', projectPaths[0]);

    pixi.onDidChangeEnvironments(() => {
        console.log('Pixi environments changed');
    });
}
```

---

## 📦 Requirements & Installation

1. Install [Pixi](https://pixi.sh) on your system.
2. Install **Pixi** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi) or [Open VSX](https://open-vsx.org/extension/sheeptao/pixi).
3. _(Optional for Python)_ Install the official [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension for Python interpreter and package integration.
4. Open any workspace containing a `pixi.toml` or `pyproject.toml`.

---

## 🔍 Troubleshooting

- **Check Logs**: Open `View` → `Output` and select `Pixi` from the dropdown.
- **Binary Not Found**: Verify `pixi` is in your system `PATH`, or configure `pixi.executablePath`.
- **Environments Not Showing**: Ensure `pixi.toml` exists and run `pixi install` to initialize environment prefixes.

---

## 📄 Acknowledgements & License

- Special thanks to [Renan Santos](https://github.com/renan-r-santos) and contributors of [pixi-code](https://github.com/renan-r-santos/pixi-code) for creating the original foundation.
- Thanks to the [Prefix.dev](https://prefix.dev) team for building the incredible [Pixi](https://pixi.sh) package manager and ecosystem.
- Licensed under the [MIT License](LICENSE).
