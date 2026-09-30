<div align="center">

<img src="./assets/icon.png" alt="Pixi" width="140" height="140">

# Pixi for Visual Studio Code

**面向 Visual Studio Code 的高性能多语言 Pixi 包管理与工作区集成扩展**

[![GitHub Release](https://img.shields.io/github/v/release/SheepTAO/pixi?style=flat-square&logo=github&label=Release)](https://github.com/SheepTAO/pixi/releases)
[![VS Code Marketplace](https://img.shields.io/badge/Marketplace-VS_Code-007ACC?style=flat-square&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi)
[![Open VSX](https://img.shields.io/badge/Open_VSX-Registry-purple?style=flat-square&logo=vscodium&logoColor=white)](https://open-vsx.org/extension/sheeptao/pixi)
[![CI Status](https://img.shields.io/github/actions/workflow/status/SheepTAO/pixi/ci.yaml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/SheepTAO/pixi/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**Pixi** 将 [Pixi](https://pixi.sh) 的高性能包管理与多语言工作区工作流无缝融入 Visual Studio Code。基于彻底解耦的语言中立核心架构，提供了一体化的工程自动发现、任务运行、预激活终端、清单快捷操作以及全自动多语言工具链扫描。

> [!NOTE]
> **多语言适配进展**：目前已完整支持 **Python** 语言环境（基于 `@vscode/python-environments`，支持解释器智能切换、文件级环境路由与包依赖树管理）。核心层同时提供了对 **C/C++**、**R** 与 **Rust** 工具链的自动探测，更多语言适配正在持续演进中。

---

## Pixi Explorer 侧边栏面板

在 VS Code 活动栏（Activity Bar）中提供专用的 Pixi 管理面板，四重视图分工明确、操作直观：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                             PIXI EXPLORER                              │
├────────────────────────────────────────────────────────────────────────┤
│ ENVIRONMENTS     │ 环境全景与生命周期诊断（已安装 / 未安装 / 不兼容） │
│                  │ ├── 显式依赖 vs 传递依赖树与 Why-installed 逆向诊断  │
│                  │ └── 一键同步安装、重新安装、锁定依赖与预激活终端   │
├──────────────────┼─────────────────────────────────────────────────────┤
│ TASKS            │ 原生 Pixi Task 运行器                               │
│                  │ ├── 一键运行任务、在指定环境中运行任务              │
│                  │ └── 快捷跳转至清单文件中的任务定义                  │
├──────────────────┼─────────────────────────────────────────────────────┤
│ GLOBAL TOOLS     │ 用户级全局 CLI 工具管理（~/.pixi/bin）              │
│                  │ └── 清晰查看已安装工具、版本，一键同步、更新与卸载  │
├──────────────────┼─────────────────────────────────────────────────────┤
│ PIXI INFO        │ 系统与 CLI 状态诊断（版本、平台架构、虚拟包）      │
│                  │ └── 磁盘缓存占用实时测算、一键清理与 CLI 自身更新   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 核心特性

### 工作区与环境生命周期

- **全自动工程发现**：即时识别单工作区与多根工作区内的 `pixi.toml` 与 `pyproject.toml` 清单文件。
- **清单快捷操作栏**：在清单编辑器标题栏右上角提供一键快捷操作按钮：锁定依赖、同步安装、更新依赖与重装环境。
- **文件级环境路由**：通过 `pixi.environmentRules` 配置 Glob 路径与环境映射（例如 `tests/**=dev`），编辑特定代码时自动激活对应环境。
- **生命周期状态诊断**：智能区分已安装（Ready 可直接执行）、未安装（清单已声明，支持一键安装）与不兼容环境（系统平台不匹配）。

### 聚合式包搜索与智能依赖

- **跨源实时检索**：高性能同时检索 Conda 仓库（如 `conda-forge` 等）与 PyPI 软件源，支持输入联想与版本自动提示。
- **多维信息卡片**：直接在搜索结果中预览软件包版本、支持的平台架构、开源许可协议与功能说明，并支持一键跳转 [prefix.dev](https://prefix.dev)。
- **深度依赖诊断**：支持查看环境完整的依赖拓扑树，并通过逆向依赖分析（_“Why is this package installed?”_）快速追溯间接依赖的引入来源。

### Python 与多语言工具链集成

- **Python 环境深度打通**：无缝对接官方 `@vscode/python-environments` API，提供解释器智能切换、原生状态栏环境展示与已安装包管理。
- **多语言工具链扫描**：自动探测环境中安装的 Python 解释器、C/C++ 编译器（GCC、Clang、MSVC、CMake、Ninja、头文件路径）、R 解释器（`R`、`Rscript`）以及 Rust 工具链（`rustc`、`cargo`）。

### 原生任务、终端与全局工具

- **VS Code 原生任务绑定**：自动将 Pixi 任务注册至 VS Code 原生任务系统（`Terminal: Run Task...`），并提供交互式 QuickPick 启动器。
- **预激活集成终端**：从终端配置菜单或命令面板直接启动已预先激活指定 Pixi 环境的 VS Code 终端。
- **全局 CLI 工具管理**：轻松查看、安装、更新与卸载 `~/.pixi/bin` 下的全局命令行工具（`pixi global`）。

---

## 常用核心命令

在命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）中输入 `Pixi:` 即可搜索并执行全部命令：

| 命令名称                                  | 命令 ID               | 功能说明                                           |
| :---------------------------------------- | :-------------------- | :------------------------------------------------- |
| **Pixi: Search Packages ...**             | `pixi.searchPackages` | 交互式搜索 Conda 与 PyPI 软件包并一键添加依赖。    |
| **Pixi: Install (Sync Environments)**     | `pixi.install`        | 安装依赖并同步当前工程的所有 Pixi 环境。           |
| **Pixi: Add Package...**                  | `pixi.addPackage`     | 交互式为项目添加指定渠道与版本的依赖包。           |
| **Pixi: Update Dependencies**             | `pixi.update`         | 更新项目依赖版本并刷新 `pixi.lock`。               |
| **Pixi: Lock Dependencies**               | `pixi.lock`           | 求解依赖约束并更新 lockfile，不改变现有环境文件。  |
| **Pixi: Run Task**                        | `pixi.runTask`        | 打开快速选择菜单，搜索并执行工程内声明的任何任务。 |
| **Pixi: Open Terminal in Environment...** | `pixi.openTerminal`   | 启动一个已自动预激活指定 Pixi 环境的集成终端。     |
| **Pixi: Global Tools ...**                | `pixi.global`         | 交互式管理用户级全局 CLI 工具（安装/更新/卸载）。  |
| **Pixi: Clean Package Cache ...**         | `pixi.cleanCache`     | 清理全局 Pixi 包缓存以释放磁盘空间。               |

> [!TIP]
> 诸如下载依赖、移除软件包、跳转清单定义、在指定环境中运行任务以及查看依赖拓扑树等操作，均在 Pixi Explorer 树视图项旁提供了直观的一键图标按钮。

---

## 扩展主要配置项

| 配置项                       | 类型       | 默认值                        | 作用域 | 说明                                                                        |
| :--------------------------- | :--------- | :---------------------------- | :----- | :-------------------------------------------------------------------------- |
| `pixi.executablePath`        | `string`   | `""`                          | 机器级 | Pixi 二进制路径。留空时自动从系统 `PATH` 环境变量中探测。                   |
| `pixi.displayNameFormat`     | `string`   | `"${project}:${env}"`         | 资源级 | 环境名称展示模板。支持占位符：`${project}`、`${env}`、`${version}`。        |
| `pixi.defaultManifestFormat` | `string`   | `"ask"`                       | 资源级 | 初始化项目时的默认清单格式（`"ask"`、`"pixi"` 或 `"pyproject"`）。          |
| `pixi.autoInstallOnOpen`     | `string`   | `"prompt"`                    | 资源级 | 打开包含未安装环境的项目时的提示策略（`"prompt"`、`"always"`、`"never"`）。 |
| `pixi.environmentRules`      | `string[]` | `[]`                          | 资源级 | 将 Glob 路径模式映射到特定 Pixi 环境（例如 `tests/**=dev`）。               |
| `pixi.packages.displayMode`  | `string`   | `"grouped"`                   | 资源级 | 环境树视图中已安装包的展示模式（`"grouped"`、`"explicitOnly"`、`"all"`）。  |
| `pixi.cache.autoMeasureSize` | `boolean`  | `true`                        | 窗口级 | 是否在 Pixi Info 视图中自动测算全局缓存的磁盘占用体积。                     |
| `pixi.searchIgnorePatterns`  | `string[]` | `["**/node_modules/**", ...]` | 资源级 | 扫描工作区 Pixi 工程时忽略的 Glob 匹配模式。                                |

### 推荐工作区配置示例

在工程的 `.vscode/settings.json` 中添加：

```json
{
    "pixi.environmentRules": ["tests/**=dev", "train/**=train", "scripts/*.py=dev"],
    "pixi.defaultManifestFormat": "pixi",
    "pixi.displayNameFormat": "${project}:${env} (${version})",
    "pixi.packages.displayMode": "grouped"
}
```

---

## 公开扩展 API（Extension API）

其他 VS Code 扩展可通过本插件导出的 `PixiExtensionApi` 编程式获取工程信息、环境列表及工具链：

```typescript
import * as vscode from 'vscode';
import type { PixiExtensionApi } from 'sheeptao.pixi';

const pixi = vscode.extensions.getExtension<PixiExtensionApi>('sheeptao.pixi')?.exports;
if (pixi) {
    const projectPaths = pixi.getProjectPaths();
    const envs = pixi.getAllEnvironments();
    const packages = await pixi.getPackages('default', projectPaths[0]);

    // 活动环境切换与事件监听
    const activeEnv = await pixi.getActiveEnvironment();
    await pixi.setActiveEnvironment(undefined, 'default');

    pixi.onDidChangeActiveEnvironment((e) => {
        console.log('活动环境已变更:', e.environment?.pixiEnvName);
    });
}
```

---

## 环境要求与快速上手

1. 在系统上安装 [Pixi](https://pixi.sh)。
2. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi) 或 [Open VSX](https://open-vsx.org/extension/sheeptao/pixi) 安装 **Pixi** 扩展。
3. _（Python 开发推荐）_ 安装官方 [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) 扩展以启用解释器切换与包管理。
4. 打开任何包含 `pixi.toml` 或 `pyproject.toml` 的工作区目录即可自动激活。

---

## 故障排查

- **查看运行日志**：打开 `查看` → `输出`（Output），在右侧下拉菜单中选择 `Pixi`。
- **找不到 pixi 二进制**：确认 `pixi` 命令已加入系统 `PATH`，或在设置中手动指定 `pixi.executablePath`。
- **未列出任何环境**：确认工作区包含 `pixi.toml`，并运行一次 `pixi.install` 初始化环境前缀目录。

---

## 致谢与开源许可

- 特别鸣谢 [Renan Santos](https://github.com/renan-r-santos) 及 [pixi-code](https://github.com/renan-r-santos/pixi-code) 贡献者们打造的优秀初始基础。
- 感谢 [Prefix.dev](https://prefix.dev) 团队打造的卓越 [Pixi](https://pixi.sh) 包管理生态。
- 本项目遵循 [MIT 许可证](LICENSE)。
