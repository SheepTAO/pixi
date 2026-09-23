<div align="center">

<img src="./assets/icon.png" alt="Pixi Python" width="140" height="140">

# Pixi Python for VS Code

**Seamless Pixi Python Environment & Package Management for Visual Studio Code**

[![GitHub Release](https://img.shields.io/github/v/release/SheepTAO/pixi-python?style=flat-square&logo=github&label=Release)](https://github.com/SheepTAO/pixi-python/releases)
[![VS Code Marketplace](https://img.shields.io/badge/Marketplace-VS_Code-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi-python)
[![Open VSX](https://img.shields.io/badge/Open_VSX-Registry-purple?style=flat-square&logo=vscodium&logoColor=white)](https://open-vsx.org/extension/sheeptao/pixi-python)
[![CI Status](https://img.shields.io/github/actions/workflow/status/SheepTAO/pixi-python/ci.yaml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/SheepTAO/pixi-python/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

</div>

---

**Pixi Python** integrates [Pixi](https://pixi.sh) environments with VS Code's official [Python Environments extension](https://github.com/microsoft/vscode-python-environments), allowing your Pixi environments to appear natively alongside conda, venv, and other environments.

> [!NOTE]
> **Pixi Python** is an actively maintained fork based on [renan-r-santos/pixi-code](https://github.com/renan-r-santos/pixi-code) (v0.2.0), featuring per-file environment auto-resolution, native package inspection, dual-marketplace continuous delivery, and robust multi-platform compatibility.

---

## ✨ Features

- **Automatic Environment Discovery**: Instantly detects Pixi projects with `pixi.toml` or `pyproject.toml`, discovering and diagnosing all declared environments with actionable warning indicators.
- **Environment & Dependency Lifecycle**: Create and delete environments (`pixi workspace environment add/remove`, `pixi clean`), sync environments (`pixi install`), update dependencies (`pixi update`), and add/remove packages with target environment selection and full Conda/PyPI channel support.
- **Dynamic Per-File Environment Resolution**: Map file/directory patterns (e.g. `tests/**` → `dev`) to automatically switch Python interpreters for different files.
- **Native Pixi Tasks Integration**: Auto-discovers Pixi tasks as native VS Code Tasks (`Terminal: Run Task...`) and provides a quick Command Palette runner (`Pixi: Run Task`).
- **Unified Terminal Profile**: Launch interactive terminals pre-activated in any Pixi environment directly from the terminal profile menu or Command Palette.
- **Native Package Inspection & Management**: Full package tree view with explicit (direct) vs transitive (indirect) dependency distinction and package channels (`conda` / `pypi`), with native install/uninstall support.
- **Editor Toolbar Sync**: Quick sync and update action buttons directly in the editor header when editing `pixi.toml` or `pyproject.toml`.
- **Pixi Features Support**: Discovers and exposes Pixi features (dev, test, lint, etc.) as distinct selectable environments.
- **Interpreter & Terminal Integration**: Automatic interpreter selection for editing, running, debugging, and terminal activation.
- **Tripartite Environment Hierarchy & Status Diagnostics**: Discovers and categorizes environments into Ready (installed & executable), Cache (compatible with host platform, uninstalled on disk, 1-click installable), and Unavailable (incompatible platform or missing python). Keeps usable environments at root and quarantines unavailable environments into a collapsed group.

---

## ⚙️ Extension Settings

| Setting                            | Type       | Default                       | Scope    | Description                                                                                                |
| :--------------------------------- | :--------- | :---------------------------- | :------- | :--------------------------------------------------------------------------------------------------------- |
| `pixi-python.displayNameFormat`    | `string`   | `"${project}:${env}"`         | Resource | Template for environment names. Placeholders: `${project}`, `${env}`, `${python}`.                         |
| `pixi-python.environmentRules`     | `string[]` | `[]`                          | Resource | Map glob patterns to Pixi environment names (e.g. `tests/**=dev`). Also supports object format in JSON.    |
| `pixi-python.pixiExecutable`       | `string`   | `""`                          | Machine  | Path to the Pixi binary. Supports `${workspaceFolder}` and relative paths. Uses `PATH` discovery if empty. |
| `pixi-python.searchIgnorePatterns` | `string[]` | `["**/node_modules/**", ...]` | Resource | Glob patterns to exclude when scanning the workspace for Pixi projects.                                    |

### Example Configuration

Add this to your project's `.vscode/settings.json` (or add items directly in the VS Code Settings UI):

```json
{
    "pixi-python.environmentRules": ["tests/**=dev", "train/**=train", "scripts/*.py=dev"]
}
```

_(Object format `{"tests/**": "dev"}` is also supported for backward compatibility)_

---

## ⌨️ Commands

| Command                                   | Identifier                         | Description                                                                              |
| :---------------------------------------- | :--------------------------------- | :--------------------------------------------------------------------------------------- |
| **Pixi: Create Environment...**           | `pixi-python.createEnvironment`    | Create a new Pixi environment (or initialize project with Python version selection).     |
| **Pixi: Delete Environment...**           | `pixi-python.deleteEnvironment`    | Delete or clean a Pixi environment from disk and manifest with safety confirmation.      |
| **Pixi: Install (Sync Environments)**     | `pixi-python.install`              | Install all dependencies and sync environments for the selected Pixi project.            |
| **Pixi: Update Dependencies**             | `pixi-python.update`               | Update dependencies and lockfile according to project constraints.                       |
| **Pixi: Add Package...**                  | `pixi-python.addPackage`           | Add packages with interactive channel selection (`Conda` vs `PyPI`) and target.          |
| **Pixi: Remove Package...**               | `pixi-python.removePackage`        | Interactively pick and remove an installed package (auto-detects Conda vs PyPI).         |
| **Pixi: Run Task**                        | `pixi-python.runTask`              | QuickPick menu to search and run any task defined in the Pixi project.                   |
| **Pixi: Run Task in Environment...**      | `pixi-python.runTaskInEnvironment` | Select a task and choose a specific Pixi environment to run it in.                       |
| **Pixi: Open Terminal in Environment...** | `pixi-python.openTerminal`         | Open a dedicated VS Code terminal inside a selected Pixi environment.                    |
| **Pixi: Initialize Project...**           | `pixi-python.init`                 | Initialize a new Pixi project in the workspace folder (`pixi.toml` or `pyproject.toml`). |

---

## 📦 Requirements & Installation

1. Install [Pixi](https://pixi.sh) on your system.
2. Ensure the official [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension is installed.
3. Install **Pixi Python** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi-python) or [Open VSX](https://open-vsx.org/extension/sheeptao/pixi-python).
4. Open any project containing a `pixi.toml` or `pyproject.toml`.

---

## 🛠️ Limitations

- **Environment & Package Mutation**: Adding, updating, or removing packages and environments is intentionally managed directly through Pixi's declarative manifests (`pixi.toml`) or CLI (`pixi add`, `pixi run`).

---

## 🔍 Troubleshooting

- **Check Logs**: Open `View` → `Output` and select `Pixi Environment Manager` from the dropdown.
- **Binary Not Found**: Verify `pixi` is in your system `PATH`, or configure `pixi-python.pixiExecutable`.
- **Environments Not Showing**: Ensure `pixi.toml` exists and run `pixi install` to initialize environment prefixes.

---

## 📄 Acknowledgements & License

- Special thanks to [Renan Santos](https://github.com/renan-r-santos) and contributors of [pixi-code](https://github.com/renan-r-santos/pixi-code) for creating the original foundation.
- Licensed under the [MIT License](LICENSE).
