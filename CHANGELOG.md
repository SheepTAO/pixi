# Changelog

All notable changes to the "pixi-python" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

- Add `Pixi: Create Environment...` command with interactive project initialization (manifest format and Python version selection) and named environment creation
- Add `Pixi: Delete Environment...` command with modal safety confirmation, supporting disk cleaning and manifest removal options
- Automatically register discovered Pixi projects into VS Code Python Projects (`api.addPythonProject`)
- Fall back to default environment in `PixiEnvManager.get()` and project refresh routines
- Enhance package removal (`Pixi: Remove Package...`) with target environment selection and automatic cache invalidation
- Support on-demand single-environment installation from interpreter activation warning prompts
- Differentiate environment discovery into Ready (installed), Cache (uninstalled but compatible, with one-click install), and Unavailable (incompatible) tiers
- Optimize Pixi project detection in `pyproject.toml` by verifying `[tool.pixi]` configuration to eliminate false positives
- Harmonize environment QuickPick icons and status badges across terminal, tasks, and workspace commands
- Add `Pixi: Clean...` command to clean specific environments, all project environments, or global package cache
- Streamline `Pixi: Create Environment...` to directly prompt for environment name in existing projects
- Unify sidebar Tree View and QuickPick UI by decoupling uninstalled and incompatible environments from synthetic error markers, ensuring clean custom icons (`$(cloud-download)` and `$(circle-slash)`) and rich tooltips
- Add `Pixi: Lock Dependencies` and `Pixi: Reinstall Environment...` commands to Command Palette and manifest editor title bar
- Fix parameter parsing in `Pixi: Install` to prevent `[object Object]` error when executed from editor title buttons

## [0.2.4]

- Add native Pixi Tasks provider (`vscode.tasks.registerTaskProvider`) for automatic discovery and execution of Pixi tasks via `Terminal: Run Task...`
- Add `Pixi: Run Task` and `Pixi: Run Task in Environment...` commands to the Command Palette
- Update extension icon with official Pixi puzzle piece vector and pure white Python snake eyes

## [0.2.3]

- Add `pixi-python.environmentRules` setting with interactive "Add Item" list editor in VS Code Settings UI
- Support dynamic per-file environment switching across multiple environments (format: `tests/**=dev`, with backward-compatible object support)
- Implement lightweight exact environment rule matching using `picomatch` for fast, sub-millisecond glob resolution

## [0.2.2]

- Fix package inspection showing "No packages found" by returning package list from `PixiPackageManager.refresh` to satisfy VS Code tree view rendering
- Add environment package caching and dynamic on-demand retrieval in `PixiPackageManager`
- Differentiate direct vs transitive dependencies using native `isTransitive` mapping (`!is_explicit`), enabling VS Code's native dependency grouping and icons
- Remove `is_explicit` filter to display all installed packages, including Pixi feature dependencies
- Enrich package tooltips with package type (`conda` / `pypi`) and version
- Make `PixiPackageManager.refresh` resilient to stripped VS Code environment objects

## [0.2.1]

- Rebrand to `pixi-python` (Pixi Python) under publisher `sheeptao`
- Fix environment discovery failure when project contains unsupported environments (fixes #39)
- Fix package list inspection failing with decorated environment name (fixes #47, #50)
- Add configurable directory ignore patterns (`pixi-python.searchIgnorePatterns`) to `fast-glob` search to optimize startup performance
- Support relative paths and `${workspaceFolder}` in `pixi-python.pixiExecutable` setting
- Add error boundary to `PixiPackageManager.refresh`

## [0.2.0]

- Use published @vscode/python-environments API package
- Improve environment display names to match uv/venv style (e.g. `project:env (version)`)
- Sort environments alphabetically by project and environment name
- Update default `workspaceSearchPaths` to improve environment discovery performance
- Support `python-envs.workspaceSearchPaths` and `python-envs.globalSearchPaths` for environment discovery
- Fix `pixi-code.pixiExecutable` setting not being read
- Fix subprocess runner race condition between exit and close events
- Fix fire-and-forget promises in environment selection
- Remove broken `deactivate` function (VS Code handles cleanup automatically)
- Extract shared helpers and parallelize environment discovery
- Add pre-release pipeline for continuous updates on every push to main
- Revert 0.1.5 `activatedRun` change now that https://github.com/microsoft/vscode-python-debugger/pull/949 was merged
- Remove `defaultInterpreterPath` support for setting the active environment

## [0.1.5]

- Fix debugging Pixi projects in the new version of the Python Environments extension by fixing the `activatedRun`
  command.

## [0.1.4]

- Check if project path exists before running Pixi commands
- Check minimum Pixi version on activation
- Remove unsupported actions (create, quick create and remove) for better UX

## [0.1.3]

### Added

- If `defaultInterpreterPath` is set and no Pixi environment was manually selected, use it as the project's interpreter
- Publish to OpenVSX

## [0.1.2]

### Fixed

- Deduplicate envs returned by getEnvironments

## [0.1.1]

### Fixed

- Fix error messages only showing in debug mode

## [0.1.0]

### Added

- Initial release of Pixi integration for VS Code
- Implements `EnvironmentManager` and `PackageManager` interfaces for the [Python Environments
  extension](https://github.com/microsoft/vscode-python-environments)
- Automatic discovery of Python environments created with Pixi
- Automatic interpreter selection when running and debugging Python code
- Support for Pixi features (dev, test, lint, etc.) as separate selectable environments
- Terminal activation
- Persistent environment selection per project
- Package discovery

### Limitations

- Environment creation and deletion
- Adding, updating and removing packages
