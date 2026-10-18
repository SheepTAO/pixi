# Release Guide

## Pre-release

1. Go to GitHub **Actions** → select **CI** workflow.
2. Click **Run workflow** on the `main` branch.

## Stable Release

1. Update `"version"` in `package.json` and run `npm install`.
2. Update `CHANGELOG.md`.
3. Commit, tag, and push:
    ```bash
    git commit -am "chore(release): bump version to x.y.z"
    git tag vx.y.z
    git push origin main --tags
    ```

GitHub Actions will automatically build, publish to VS Code Marketplace & Open VSX, and create the GitHub Release.
