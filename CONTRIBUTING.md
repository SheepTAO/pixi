# Contributing to Pixi for Visual Studio Code

Thank you for your interest in contributing to Pixi! This document provides guidelines for contributing to this VS Code extension that integrates the Pixi package manager and polyglot workspaces into Visual Studio Code.

## Development Setup

### 1. Prerequisites

- **Node.js** 20+
- **Pixi** installed on your system ([Installation Guide](https://pixi.sh))
- **Visual Studio Code** (optionally with the official [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension for Python integration testing)

### 2. Clone and Install

```bash
git clone https://github.com/SheepTAO/pixi.git
cd pixi
npm install
```

### 3. Development Workflow

```bash
npm run compile    # Build the extension with Webpack
npm run watch      # Watch for changes during local development
npm test           # Run TypeScript compilation, Webpack build, and ESLint checks
```

## Code Style & Standards

This project enforces strict code quality and formatting using TypeScript, ESLint, and Prettier:

```bash
npm run format:check   # Verify code formatting
npm run format         # Auto-format all files with Prettier
npm run lint           # Check for linting issues
npm run lint -- --fix  # Auto-fix linting issues
```

## Architectural Guidelines

- **Decoupled Core (`src/core/`)**: Keep core workspace operations (projects, environments, tasks, terminals, CLI detection, package queries) completely language-agnostic.
- **Language Adapters (`src/languages/`)**: Language-specific integrations (e.g. `src/languages/python/`) extend core capabilities without polluting core types or commands.
- **Pure Common Utilities (`src/common/`)**: Keep common helpers (exec, deferred promises, logging, persistent state) free of domain-specific Pixi assumptions.
- **Public Extension API (`src/api/`)**: Maintain backward compatibility and clear typing for `PixiExtensionApi`.

## Running & Debugging Locally

1. Open the project folder in VS Code.
2. Press `F5` to start debugging with the **Run Extension** launch configuration.
3. In the new Extension Development Host window:
    - Open any folder with a `pixi.toml` or `pyproject.toml`.
    - Verify environment discovery, task execution, terminal profiles, and language toolchain detection.

## Submitting Pull Requests

1. Create a feature branch (`git checkout -b feat/your-feature-name`).
2. Follow Conventional Commits formatting for commit messages (`feat: ...`, `fix: ...`, `refactor: ...`).
3. Ensure all tests and lint checks pass (`npm test`).
4. Submit a Pull Request with a clear description of the problem and the proposed solution.
