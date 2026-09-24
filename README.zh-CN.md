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

**Pixi** 将 [Pixi](https://pixi.sh) 的包管理与环境工作流无缝集成至 Visual Studio Code。基于彻底解耦的语言通用核心架构设计，扩展提供了统一的工程发现、任务运行、终端集成、清单操作以及全自动多语言工具链扫描支持。

> [!NOTE]
> **多语言适配进展**：目前本扩展已完整支持 **Python** 语言环境（基于 `@vscode/python-environments`，提供解释器切换、动态文件级环境规则绑定及包依赖树视图管理）。同时核心层已提供对 **C/C++**、**R** 与 **Rust** 工具链的自动检测，更多语言支持正在规划与演进中。

---

## ✨ 功能特性

- **语言中立的核心架构**：将 Pixi 核心工作区逻辑（清单生命周期、环境、依赖、任务、终端）与具体编程语言适配器彻底解耦。
- **深度 Python 环境集成**：与 VS Code 的 Python 环境扩展 (`@vscode/python-environments`) 深度打通，提供解释器智能切换、状态栏环境信息展示与包依赖树视图管理。
- **多语言工具链自动检测**：自动扫描环境中安装的多语言工具链（Python 解释器、C/C++ 编译器/头文件/CMake/Ninja、R 解释器、Rust 编译器与 Cargo），为多语言工作流赋能。
- **全自动工作区工程发现**：即时识别工作区内的 `pixi.toml` 或 `pyproject.toml`，自动发现并诊断所有声明的环境。
- **清单快捷操作栏**：在 `pixi.toml` 和 `pyproject.toml` 编辑器右上角提供一键快捷操作按钮（锁定依赖 🔒、同步安装 ⬇️、更新依赖 🔄、重装环境 🔁）。
- **环境与依赖全生命周期管理**：新建与删除环境（`pixi workspace environment add/remove`、`pixi clean`）、同步安装（`pixi install`）、依赖求解（`pixi lock`）、交互式添加/移除 Conda 及 PyPI 依赖包。
- **原生 Pixi Task 集成**：自动将 Pixi tasks 注册为 VS Code 原生任务（可通过 `Terminal: Run Task...` 调用），并提供专用的快速搜索启动菜单（`Pixi: Run Task`）。
- **统一终端 Profiles**：直接从终端配置菜单或命令面板打开已预激活指定 Pixi 环境的集成终端。
- **动态按文件自动切换环境**：通过 Glob 规则将文件/目录路径与环境绑定（例如 `tests/**` → `dev`，`train/**` → `train`），在打开对应代码时自动切换活动环境与解释器。
- **公开的扩展 Extension API**：导出 `PixiExtensionApi`，供第三方扩展轻松获取 Pixi 工程、环境列表、工具链及包信息，并监听变更事件。
- **生命周期状态诊断**：环境分为已安装（Installed）、未安装（Uninstalled，清单已声明，支持一键点击安装）以及不兼容（Incompatible，与当前系统平台不匹配）。

---

## ⚙️ 扩展配置项

| 配置项                      | 类型       | 默认值                        | 作用域 | 说明                                                                                              |
| :-------------------------- | :--------- | :---------------------------- | :----- | :------------------------------------------------------------------------------------------------ |
| `pixi.executablePath`       | `string`   | `""`                          | 机器级 | Pixi 可执行文件路径。支持 `${workspaceFolder}` 及相对路径。为空时自动从系统 `PATH` 探测。         |
| `pixi.displayNameFormat`    | `string`   | `"${project}:${env}"`         | 资源级 | 环境名称展示模板。支持占位符：`${project}`、`${env}`、`${python}`。                               |
| `pixi.environmentRules`     | `string[]` | `[]`                          | 资源级 | 将 Glob 模式映射到 Pixi 环境名称（例如 `tests/**=dev`）。支持在设置面板通过 "Add Item" 交互添加。 |
| `pixi.searchIgnorePatterns` | `string[]` | `["**/node_modules/**", ...]` | 资源级 | 扫描工作区 Pixi 工程时忽略的 Glob 目录模式。                                                      |

### 配置示例

在项目的 `.vscode/settings.json` 中添加：

```json
{
    "pixi.environmentRules": ["tests/**=dev", "train/**=train", "scripts/*.py=dev"]
}
```

---

## ⌨️ 命令列表

| 命令名称                                  | 命令 ID                     | 功能说明                                                                 |
| :---------------------------------------- | :-------------------------- | :----------------------------------------------------------------------- |
| **Pixi: Lock Dependencies**               | `pixi.lock`                 | 求解并更新锁文件（`pixi.lock`），不修改现有环境。                        |
| **Pixi: Install (Sync Environments)**     | `pixi.install`              | 安装所有依赖并同步工程的所有环境。                                       |
| **Pixi: Reinstall Environment...**        | `pixi.reinstall`            | 从头重新安装指定环境或所有环境。                                         |
| **Pixi: Update Dependencies**             | `pixi.update`               | 依据工程约束更新依赖并刷新锁文件。                                       |
| **Pixi: Clean...**                        | `pixi.clean`                | 清理指定环境、项目所有环境，或清理系统级全局包缓存。                     |
| **Pixi: Create Environment...**           | `pixi.createEnvironment`    | 在当前项目中新建环境（或在空白文件夹中初始化项目）。                     |
| **Pixi: Delete Environment...**           | `pixi.deleteEnvironment`    | 从磁盘清理或从清单中移除 Pixi 环境（具备安全确认弹窗）。                 |
| **Pixi: Initialize Project...**           | `pixi.init`                 | 在当前文件夹初始化 Pixi 项目（可选择 `pixi.toml` 或 `pyproject.toml`）。 |
| **Pixi: Add Package...**                  | `pixi.addPackage`           | 交互式添加包（支持 Conda 与 PyPI 渠道选择及目标环境指定）。              |
| **Pixi: Remove Package...**               | `pixi.removePackage`        | 交互式选择并移除已安装包（自动识别 Conda 或 PyPI 渠道）。                |
| **Pixi: Run Task**                        | `pixi.runTask`              | 快速搜索并运行当前工程中定义的任意 Pixi task。                           |
| **Pixi: Run Task in Environment...**      | `pixi.runTaskInEnvironment` | 选择一个 task 并指定在特定 Pixi 环境中运行。                             |
| **Pixi: Open Terminal in Environment...** | `pixi.openTerminal`         | 在指定的 Pixi 环境中打开一个预激活终端。                                 |

---

## 🔌 公开扩展 API

其他 VS Code 扩展（如语言插件、代码格式化工具或自动化流）可直接消费 Pixi 的公共 API：

```typescript
import * as vscode from 'vscode';
import type { PixiExtensionApi } from 'sheeptao.pixi';

const pixi = vscode.extensions.getExtension<PixiExtensionApi>('sheeptao.pixi')?.exports;
if (pixi) {
    const projectPaths = pixi.getProjectPaths();
    const envs = pixi.getAllEnvironments();
    const packages = await pixi.getPackages('default', projectPaths[0]);

    pixi.onDidChangeEnvironments(() => {
        console.log('Pixi 环境发生变化');
    });
}
```

---

## 📦 环境要求与安装

1. 确保系统已安装 [Pixi](https://pixi.sh)。
2. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi) 或 [Open VSX](https://open-vsx.org/extension/sheeptao/pixi) 安装 **Pixi** 扩展。
3. _（Python 用户推荐）_ 安装 VS Code 官方 [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) 扩展以启用解释器切换与包依赖查看。
4. 打开任意包含 `pixi.toml` 或 `pyproject.toml` 的工作区即可开始使用。

---

## 🔍 故障排查

- **查看日志**：打开 `查看` → `输出`，在下拉框中选择 `Pixi`。
- **找不到二进制文件**：检查 `pixi` 是否在系统环境变量 `PATH` 中，或在设置中显式配置 `pixi.executablePath`。
- **环境未显示**：确保 `pixi.toml` 文件存在，并在工程目录下执行 `pixi install` 完成初始化。

---

## 📄 致谢与开源许可

- 特别鸣谢 [Renan Santos](https://github.com/renan-r-santos) 以及 [pixi-code](https://github.com/renan-r-santos/pixi-code) 早期贡献者奠定的代码起点。
- 感谢 [Prefix.dev](https://prefix.dev) 团队打造卓越的 [Pixi](https://pixi.sh) 包管理器与生态系统。
- 本项目遵循 [MIT 许可证](LICENSE)。
