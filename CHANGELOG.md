# Changelog

All notable changes to the "pixi" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-10-05

- **Jupyter Notebook Integration & Kernel Safeguards**:
    - Automatically detect if target Pixi environment contains `ipykernel` when selecting environments for Jupyter notebooks (`.ipynb`).
    - Provide interactive 1-click installation via Pixi (`pixi add -e <env> ipykernel`) or seamless switching to an alternative environment containing `ipykernel` to prevent runtime execution failures.
- **Task Execution Arguments Pipeline**:
    - Add runtime command-line arguments support (`args?: string[]`) across `PixiTask`, `PixiTaskDefinition`, and VS Code task runners.
    - Enable passing arbitrary execution arguments dynamically to `pixi.runTask` (`pixi run -e <env> <task> <args...>`).
    - Enhance manifest task parsing with environment alias fallbacks (`environment ?? default_environment`).
- **Architecture Simplification & Performance Refinement (KISS)**:
    - Streamline `persistentState` by eliminating asynchronous locks and normalizing synchronous state reads.
    - Proactive synchronous toolchain discovery with compiled regexes and file inspection.
    - Remove redundant directory-climbing heuristics in Python package management and unify environment sorting across the extension.
    - Extract reusable `pickInstallableEnvironment` helper to deduplicate selection logic across installation workflows.
- **Environment Lifecycle & Platform Compatibility**:
    - Refine environment deletion and cleaning workflows (`pixi.clean`, `pixi.reinstall`, `pixi.deleteEnvironment`) with granular choices (clean disk vs delete from manifest).
    - Decouple editor title bar actions from environment installation and gracefully skip incompatible platform queries.
- **Manifest Hover Theme Icon Rendering**:
    - Enable `supportThemeIcons` on dependency hover cards, rendering native VS Code Codicons (`$(package)`, `$(go-to-file)`, `$(lock)`, `$(link-external)`) instead of raw text placeholders.

## [1.2.2] - 2026-10-04

- **Offline Manifest Schema Validation & IntelliSense**:
    - Bundle official Pixi manifest JSON schema locally for 100% offline, zero-dependency autocompletion and hover documentation in `pixi.toml` and `pyproject.toml`.
    - Provide `pixi.manifest.schemaSupport` user configuration setting (default `true`) allowing seamless coexistence with third-party TOML language servers like Even Better TOML.
    - Intelligent quote and bracket replacement preventing duplicate closing brackets (`[workspace]]`) and double quotes (`""conda-forge""`).
    - Dedicated completions for top-level sections, subtask property tables (`[tasks.<name>]`), activation scripts/env, system requirements, PyPI options, and target platforms.
- **Native Package Search & Error Transparency**:
    - Propagate and display raw native error messages directly in the QuickPick UI when registry search encounters offline, network, or SSL errors, eliminating artificial wrappers.
    - Preserve direct manifest package addition (`$(edit) Add: "..."`) during registry search failures so offline users can add packages without interruptions.
    - Guard against accidental submission when selecting informational search banners.

## [1.2.1] - 2026-10-03

- **Windows Cache Measurement Performance**:
    - Accelerate cache directory size calculation on Windows using native `robocopy` read-only scan, reducing calculation time on 350k+ files from timeout failure to 1~2 seconds.
    - Add measurement fault tolerance to prevent repeated calculation attempts on inaccessible directories.
- **Task View Icons & Semantics Expansion**:
    - Expand semantic Codicon matching for tasks with deployment/release (`$(rocket)`), benchmark/evaluation (`$(pulse)`), preprocessing/ETL (`$(database)`), installation/download (`$(cloud-download)`), and monitoring (`$(eye)`).
    - Harmonize theme colors across all task icon categories.
- **Manifest Dependency Parsing & External Links**:
    - Support quoted platform/target dependency table headers in `pixi.toml` (e.g. `[target."linux-64".dependencies]`).
    - Support definition navigation to local path and editable subpackages in `pixi.lock`.
    - Add direct links to package documentation on PyPI and prefix.dev in package hover inspection cards.

## [1.2.0] - 2026-10-01

- **Locked Dependency Inlay Hints & Navigation**:
    - Inline locked version hints directly in `pixi.toml` and `pyproject.toml` manifests (e.g. `: 1.26.4`), configurable via `pixi.dependencies.inlayHints`.
    - Rich hover inspection cards displaying locked version, package kind (Conda/PyPI), build string, requested specification, license, and multi-environment matrix comparison.
    - `Ctrl`/`Cmd` + Click definition navigation from manifest package entries directly to corresponding definitions in `pixi.lock`.
    - Add `pixi.openLockfile` command to jump to and highlight package entries within `pixi.lock`.
- **Manifest Task CodeLens & Hover Actions**:
    - Interactive CodeLens and Hover actions for tasks in `pixi.toml` and `pyproject.toml` (`PixiTaskManifestProvider`).
    - Configurable display styles via `pixi.tasks.manifestActions` (`hover`, `compact`, `full`, `header`, `off`).
    - Direct manifest actions: Run Task, Run in Environment, and jump to Documentation.
- **Intelligent Tasks View Grouping & Management**:
    - Support namespace prefix grouping (`prefix`), environment grouping (`environment`), and flat listing (`none`) in the Tasks tree view, configurable via `pixi.tasks.groupBy`.
    - Quick switcher button in the Tasks view title bar to toggle grouping mode interactively.
    - Fine-grained grouping control with `pixi.tasks.prefixSeparators`, `pixi.tasks.minGroupSize`, and `pixi.tasks.maxDepth`.
    - Dedicated task lifecycle commands: `pixi.tasks.runTask`, `pixi.tasks.runTaskInEnvironment`, `pixi.tasks.removeTask`, and interactive task creation.
- **CI & Release Automation**:
    - Automate odd-minor pre-releases via GitHub Actions manual workflow dispatch.
    - Enforce even-minor versioning policy for stable releases according to VS Code marketplace guidelines.

## [1.0.1] - 2026-09-30

- **Fix Environment Platform Compatibility Check**:
    - Prioritize disk existence (`fs.existsSync`) to ensure installed environments are never mistakenly flagged as `(incompatible)`.
    - Match platform `subdir` and `name` against host platform, properly supporting custom named platforms (e.g. `win-64-cuda`, `linux-64-cuda`).
    - Expand `PixiEnvironmentPlatform` with `virtual_packages` and `PixiRawEnvironmentInfo` with `resolved_platform` matching native Pixi CLI schema.

## [1.0.0] - 2026-09-30

- **Dedicated Pixi Explorer Side Panel**: Introduced a full-featured Activity Bar container with 4 dedicated Tree Views:
    - `Environments`: Deep inspection of installed/uninstalled/incompatible environments, explicit vs transitive package dependencies, 1-click package updates/removal, and terminal launch.
    - `Tasks`: Interactive tree of declared Pixi tasks with 1-click run, execution in specific environments, and manifest definition jumping.
    - `Global Tools`: Visual management of user-level CLI packages installed in `~/.pixi/bin`, supporting inspection, sync, update, and uninstall.
    - `Pixi Info`: System diagnostics, Pixi CLI version, virtual packages, config files, disk cache size measurement, and 1-click cache cleaning.
- **Aggregated Package Search & Discovery**: High-performance real-time search across Conda repositories (`conda-forge`, etc.) and PyPI with instant version, platform, and license inspection, direct prefix.dev navigation, and reverse dependency diagnosis (`pixi.whyPackage`).
- **Polyglot Toolchain Scanner**: Automatic multi-language toolchain scanning (`src/core/toolchains.ts`) detecting Python, C/C++ compilers (GCC, Clang, MSVC, CMake, Ninja, headers), R (`R`, `Rscript`), and Rust (`rustc`, `cargo`).
- **Major Architectural Decoupling**: Cleanly separated language-agnostic Pixi Core (`src/core/`) from language adapters (`src/languages/`), providing a resilient polyglot foundation for Visual Studio Code and Open VSX.
- **Official Paxton Mascot & Visual Branding**: Adopted the official Pixi fairy mascot Paxton with dark-mode drop shadow as the extension icon, custom activity bar icon, and dark marketplace gallery banner.
- **Public Extension API**: Exported `PixiExtensionApi` (`sheeptao.pixi` exports) allowing third-party extensions to query Pixi projects, environments, toolchains, and packages, with bi-directional environment switching and change event subscriptions.
- **Manifest Lifecycle & Editor Navigation**: One-click action buttons in the editor title bar for `pixi.toml` and `pyproject.toml` (Lock, Install, Update, Reinstall).
- **Native Tasks & Terminal Profiles**: Automatic registration of Pixi tasks as native VS Code Tasks (`Terminal: Run Task...`) and pre-activated interactive Pixi terminal profiles.
- **Streamlined Documentation**: Comprehensive, visual, and minimalist documentation in `README.md`.

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
