# Changelog

All notable changes to the "pixi" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-10-19

- **Windows Path Sensitivity & Environment Management**:
    - Introduce canonical `PathMap` and `PathSet` collection types for case-insensitive lookup and case-preserving keys on Windows.
    - Fix an issue where refreshing or switching environments on Windows purged all environments from the tree view and active environment state due to path casing discrepancies (`folder.uri.fsPath`).
    - Resolve project path mapping in Python environment manager for Jupyter Notebooks (`.ipynb`) and document scopes.
    - Reinforce Jupyter notebook `ipykernel` detection and installation prompt flow.
- **Automatic Package Update Inspection**:
    - Add native background package update checking with inline manifest hints (`pixi.toml` / `pyproject.toml`) and visual upgrade indicators in the Environments view.
    - Support configurable check intervals and opt-in settings (`pixi.packageUpdates.enabled`, `pixi.packageUpdates.showInlineHints`).
- **Terminal & Configuration Customization**:
    - Add customizable terminal naming formats and flexible shell execution activation options.

## [2.0.0] - 2026-10-18

- **Modern Pixi Workspace Architecture & Baseline Compatibility**:
    - Set minimum Pixi version requirement to `>= 0.60.0` (covering all daily workflows: environments, tasks, packages, terminals, Python, and manifests), with `>= 0.79.0` recommended for complete modern workspace CLI feature access.
    - Completely remove legacy compatibility shims and workarounds for obsolete pre-0.60 Pixi releases.
    - Streamline Command Palette hierarchy: consolidate scattered commands into 15 high-level, focused Hub entries and hide internal sub-menus (`when: false`).
- **Pixi Solve Groups & Workspace Dependencies**:
    - Add native support for Pixi solve groups (`[environments.<name>.solve-group]`), enabling co-solved environments and visual solve group indicators in the Environments view.
    - Add first-class support for workspace-level shared dependencies (`[workspace.dependencies]`) via native `pixi workspace dependencies` CLI.
- **Unified Workspace Hub (`pixi.workspace`)**:
    - Centralized interactive menu to manage shared workspace dependencies, target platforms, channels, system requirements, lockfiles, version bumping, and descriptions.
    - Interactive target platform picker with 1-click host auto-detection for OS, architecture, and GPU CUDA virtual packages.
    - Interactive system requirements hub (`pixi.systemRequirements`) for CUDA, glibc, archspec, and OS platform constraints.
- **Unified Configuration & Authentication Hub (`pixi.config`)**:
    - Manage Pixi configuration across workspace local, user global, and system scopes (`pixi config list`, `set`, `unset`, `append`, `prepend`, `edit`).
    - Consolidate private registry credentials and authentication (`pixi auth`), including background OAuth device flow with zero terminal clutter.
- **Environment Import & Export**:
    - Import external Conda `environment.yml` and PyPI `requirements.txt` into existing or new environments (`pixi import`).
    - Export environment specifications to standard Conda environment YAML or Conda Explicit Specification (`@EXPLICIT`).
- **Granular Cleanup & Machine Registry Management (`pixi.clean`)**:
    - Targeted cleanup for project environments, individual environment prefixes, activation script cache (`pixi clean --activation-cache`), build backends, and package caches.
    - Machine-wide workspace registry management (`pixi workspace register`) and stale registry cleanup (`pixi clean --workspaces-registry`).
- **Task Execution Arguments Pipeline**:
    - Pass arbitrary runtime arguments (`ShellExecution`) to Pixi tasks from Command Palette (`pixi.runTaskWithArgs`), Tasks tree view, Hover, and CodeLens without argument loss.
    - Support declared task aliases in project manifests.
- **Terminal Execution & ShellHook Mode**:
    - Introduce `pixi.terminal.activationMode` supporting fast `shellHook` environment variable activation alongside `shell`.
    - Add configurable `pixi.executionMode` (`smart`, `terminal`, `notification`) for running tasks and package actions.
- **Package Management Enhancements**:
    - 1-click single package reinstall directly from the Environments tree view.
    - Selective package upgrades via interactive multi-select QuickPick in `Pixi: Update / Upgrade ...`.
    - Outdated package dry-run inspection with build diffs and cascade removal warnings.
- **Codebase Modernization & Performance**:
    - Eliminate indirect command reflection (`executeCommand('pixi....')`) in favor of direct handler functions.
    - Consolidate project path resolution, storage key normalization, and precompiled regexes.
    - Upgrade development toolchain to TypeScript 6, ESLint 10, and Prettier 3.8.

## [1.6.4] - 2026-10-13

- **Private Registry & Credentials Management (`pixi auth`)**:
    - Add native interactive authentication hub (`pixi.auth`), multi-protocol login wizard (`pixi.auth.login`), host logout (`pixi.auth.logout`), copy token (`pixi.auth.copyToken`), and credential status inspection (`pixi.auth.status`).
    - Implement native background OAuth device flow with automatic clipboard copy of device code and browser launch (0 terminal windows).
    - Upgrade Auth Storage in Pixi Info view to a hierarchical tree showing authenticated hosts, methods, and usernames with inline actions.
    - Sanitize sensitive credentials (tokens, passwords, secret keys) in CLI error logging.

## [1.6.3] - 2026-10-13

- **Local & Editable Package Action Safeguards**:
    - Hide inline update action and context menu item for local path and editable dependencies in the Environments tree view, and filter them out from interactive package update pickers.

## [1.6.2] - 2026-10-13

- **Unified Target Platform Picker (`pixi.platform`)**:
    - Consolidate platform addition and removal into a single interactive check/uncheck multi-select QuickPick (`Pixi: Platform ...`), displaying custom platforms and virtual packages alongside standard Conda presets.
- **Unified Feature & Environment Tree Views**:
    - Unify `PixiFeatureTreeItem` and `PixiPackageTreeItem` across both Environment and Feature view modes, resolving installed package metadata (versions, builds, licenses, local editable paths) and enabling full package context menu actions directly in Feature view.
- **Async Cache Unification & Codebase Simplification**:
    - Unify task, package, manifest schema, and Python environment caches into single in-flight `Promise` maps, reuse `PixiProjectTreeItem` across views, and remove redundant abstractions and menu guard rules.

## [1.6.1] - 2026-10-12

- **Target Platform Management (`pixi.platform`)**:
    - Introduce interactive `Pixi: Platform ...`, `Pixi: Add Platform ...`, and `Pixi: Remove Platform ...` commands supporting both workspace-global and feature-specific (`-f <feature>`) target platforms.
    - Support multi-select addition and removal of Conda target platforms (`linux-64`, `linux-aarch64`, `osx-arm64`, `osx-64`, `win-64`, `win-arm64`) with host OS detection and safety guards against removing all workspace platforms.
- **Feature-Scoped Channel Management & Multi-Select Removal**:
    - Extend `Pixi: Add Channel ...` and `Pixi: Remove Channel ...` to support feature-level channels (`pixi workspace channel add/remove -f <feature>`) and multi-select channel removal.
    - Register channel and platform management actions directly in feature tree node context menus.
- **Selective Package Upgrade (`pixi upgrade`)**:
    - Add an interactive multi-select package picker (all selected by default) to `Upgrade Dependencies` in `Pixi: Update / Upgrade ...`, enabling selective manifest constraint upgrades (`pixi upgrade <pkg...>`) alongside full workspace upgrades.
- **Manifest Hover Quick Actions**:
    - Add clickable action links (`Update`, `Why`, `Remove`, `Open in pixi.lock`, `Run Pixi Lock`) to dependency hover cards in `pixi.toml` and `pyproject.toml` with automatic feature scope detection.
    - Add `Run Task`, `Run in Environment...`, and `Remove` action links to task hover cards in manifest files.
- **Codebase Simplification & Refactoring**:
    - Extract shared workspace/feature scope resolution (`resolveWorkspaceOrFeatureScope`), scoped multi-item removal (`executeScopedWorkspaceRemove`), and environment picker helpers (`toEnvQuickPickItem`).
    - Eliminate redundant wrapper functions, duplicate parsing logic, and over-defensive checks across workspace commands, core discovery, tree views, and language providers.

## [1.6.0] - 2026-10-12

- **First-Class Feature Management & Dual-Perspective Environments View**:
    - Decouple Pixi features and environments across CLI parsing, manifest manipulation, and workspace commands.
    - Add dual-perspective grouping (`pixi.environments.viewMode`: `"environment"` vs `"feature"`) in the Environments tree view with a title-bar quick switcher.
    - Nest packages by defining feature under each environment node, providing clear visibility into feature composition (`features: [...]`) and solve groups.
    - Introduce interactive `Pixi: Manage Environments...` and `Pixi: Manage Features...` QuickPick command hubs for creating, editing, renaming, deleting, and jumping to manifest definitions of environments and features.
- **Streamlined Command Hierarchy & Package Picker Overhaul**:
    - Overhaul multi-step package search and selection with interactive `conda`/`pypi` source filters, target feature selection, and inline QuickInput action buttons.
    - Consolidate redundant environment and feature actions in the Command Palette and context menus for a cleaner user experience.
- **Tasks View Grouping & Prefix Enhancements**:
    - Expand `pixi.tasks.prefixSeparators` default delimiters to `["-", "_", ":", "::"]`.
    - Add `pixi.tasks.displayNameFormat` (`"stripped"` vs `"full"`) to control whether grouped task labels strip their prefix, updating the tree view instantaneously without re-querying the CLI.
    - Automatically infer existing group separators and preserve parent prefixes when creating tasks directly from a prefix group folder.
- **Architecture & Performance Optimizations**:
    - Extract shared provider utilities (`providerUtils`), TOML manipulation services (`tomlService`), and debounced manifest file watchers (`manifestWatcher`).
    - Parallelize workspace project discovery and refresh pipelines, and filter file watcher events strictly to Pixi-managed manifests.
    - Scope manifest completion, hover, inlay hint, and CodeLens providers strictly to valid Pixi manifests and fix inline TOML environment snippet formatting.

## [1.4.2] - 2026-10-07

- **Unified Dependency Update & Upgrade Workflows**:
    - Introduce an interactive `Pixi: Update / Upgrade ...` secondary menu with dry-run outdated package inspection, constraint-respecting lockfile updates, and manifest upgrade options.
    - Enhance dry-run QuickPick with pre-selected outdated items, build/version diff tracking, and cascade removal filtering.
    - Aggregate multi-environment package updates by name into single picker items, displaying affected environments and platforms cleanly in the detail line.
- **Inlay Hints & Hover Refinements**:
    - Filter outdated package inspection (`pixi update --dry-run`) strictly to explicit dependencies declared in the project manifest (`is_explicit === true`).
    - Streamline dependency inlay hints into clean passive annotations (e.g. `: 1.26.4`), eliminating duplicate hover tooltip cards and preserving full hover cards on package names.
- **Polymorphic Command Context & UI Polish**:
    - Centralize tree view, menu, and palette context extraction via `extractCommandContext`, improving support for multi-selection and editor title bar actions.
    - Provide intuitive Conda channel addition placement options (prepend with highest priority vs append).
    - Hide `pixi.init` from the Command Palette when a Pixi project is already present in the workspace.
- **Performance & Architectural Simplification**:
    - Optimize lockfile line search by eliminating redundant scans and using normalized canonical package keys.
    - Deduplicate task object instantiation in manifest task provider.
    - Flatten package spec parsing logic and unify regular expression escaping in task tree prefix grouping.

## [1.4.1] - 2026-10-05

- **Command Palette Streamlining & Submenu Architecture**:
    - Consolidate all environment and cache cleaning operations into a unified interactive `Pixi: Clean ...` secondary menu (clean project environments `.pixi`, clean specific environment on disk, clean global package cache).
    - Consolidate environment re-installation into an interactive `Pixi: Reinstall ...` secondary menu (reinstall all project environments vs reinstall a specific target environment).
    - Optimize global package cache cleaning to trigger immediately without prompting for project selection in multi-project workspaces.
    - Cleanse the Command Palette by suppressing 21 internal/tree-item-specific commands, title bar refresh icons, and duplicate entries (`when: false`).
- **Guard Conditions & Bug Fixes**:
    - Fix `pixi.init` visibility condition so project initialization remains accessible from the Command Palette even when a Pixi project is already present.
    - Add missing `pixi.hasPixiProject` guards to `pixi.openLockfile` and `pixi.createEnvironment`.
    - Standardize command title ellipsis (`...`) across interactive prompts (`Pixi: Run Task ...`, `Pixi: Clean ...`, `Pixi: Reinstall ...`).
    - Format and align `README.md` essential command table according to Prettier formatting rules.

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
