<div align="center">

<img src="./assets/icon.png" alt="VSCode" width="220" height="220">

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/sheeptao.pixi-python)](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi-python)

</div>

# Pixi Python (VSCode Extension)

VS Code extension that integrates [Pixi](https://pixi.sh) Python environments with the [Python Environments extension](https://github.com/microsoft/vscode-python-environments).

> **Note**: **Pixi Python** is an independent fork based on [renan-r-santos/pixi-code](https://github.com/renan-r-santos/pixi-code) (v0.2.0) under the MIT License, created to improve multi-platform compatibility, fix package tree inspection, and support customizable workspace search.
>
> Feedback, suggestions, and community contributions are warmly welcome!

## Overview

This extension implements the `EnvironmentManager` and `PackageManager` interfaces for the [Python Environments
extension](https://github.com/microsoft/vscode-python-environments), allowing Pixi environments to appear alongside
conda, venv, and other Python environments in VS Code.

## Features

- Automatic discovery of Python environments created with Pixi
- Automatic interpreter selection when running and debugging Python code
- Support for Pixi features (dev, test, lint, etc.) as separate selectable environments
- Terminal activation
- Persistent environment selection per project
- Package discovery and inspection
- Robust multi-platform filtering (safely skips environments incompatible with current host without breaking discovery)
- Support for relative paths and `${workspaceFolder}` in executable settings

## Requirements

- Pixi installed on your system
- Python Environments extension (`ms-python.vscode-python-envs`)

## Installation

1. Install Pixi on your system
2. Install [Pixi Python](https://marketplace.visualstudio.com/items?itemName=sheeptao.pixi-python) from the VS Code Marketplace
3. Open a project with a `pixi.toml` or `pyproject.toml` file

The extension will automatically discover Pixi environments and register them with the Python Environments system.

## Extension Settings

- `pixi-python.pixiExecutable`: Path to the Pixi executable (supports `${workspaceFolder}` and relative paths). Leave empty to use auto-discovery (default).
- `pixi-python.searchIgnorePatterns`: Array of glob patterns to exclude when searching for Pixi projects in the workspace (defaults to `node_modules`, `.git`, `dist`, `build`, `.venv`).

## Limitations

- **Environment creation and deletion**
- **Adding, updating and removing packages**

These operations are intentionally not supported as Pixi's declarative manifest approach works best through direct CLI
interaction or editing of the `pixi.toml` or `pyproject.toml` files directly.

## Troubleshooting

### Logs

Check the "Pixi Environment Manager" output channel:

1. View → Output
2. Select "Pixi Environment Manager" from dropdown

### Common Issues

**Pixi executable not found**

- Ensure Pixi is installed and in PATH
- Set `pixi-python.pixiExecutable` setting if needed

**No environments discovered**

- Verify `pixi.toml` or `pyproject.toml` exists in project root
- Run `pixi install` to ensure environments are set up

## Acknowledgements

Special thanks to [Renan Santos](https://github.com/renan-r-santos) and contributors of [pixi-code](https://github.com/renan-r-santos/pixi-code) for creating the original extension foundation.

## License

MIT
