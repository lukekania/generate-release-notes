# Release Notes Generator

Release Notes Generator is a minimal GitHub Action that automatically generates release notes from merged pull requests.

It is designed to eliminate manual release-note writing while staying simple, predictable, and easy to audit.

---

## What It Does

The action:
- Uses Git tags to determine the release range
- Collects merged pull requests since the previous tag
- Groups pull requests by common labels (bug, enhancement, chore, docs, etc.)
- Writes formatted release notes to the GitHub Actions Step Summary
- Optionally creates or updates a draft GitHub Release

It does not require conventional commits or strict workflows.

---

## How the Release Range Is Determined

On tag push:
- Current tag to previous tag

On manual run:
- Latest tag to now
- Falls back to a configurable number of days if no tags exist

---

## Example Output

## Release v1.7.0

From v1.6.0 to v1.7.0

### Fixed
- Fix login redirect loop (#412) @alice

### Added
- Support dark mode (#418) @bob

### Changed
- Upgrade dependencies (#420) @carol

---

## Usage

```yaml
name: Release Notes

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  pull-requests: read

jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - uses: lukekania/generate-release-notes-@v0.1.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Configuration

| Input | Default | Description |
|------|---------|-------------|
| base_branch | main | Base branch PRs must be merged into |
| draft | true | Create or update a draft GitHub Release |
| since_days | 30 | Fallback lookback if no tags exist |
| max_prs | 200 | Maximum number of PRs to include |

---

## Label Grouping Rules

- Fixed: bug, fix
- Added: enhancement, feat, feature
- Changed: chore, refactor, deps, dependencies
- Docs: docs, documentation
- Other: everything else

---

## Design Principles

- Heuristics over ceremony
- Zero required configuration
- One clear output
- No AI or opaque logic

---

## Known Limitations

- Relies on GitHub Search API heuristics
- Label quality affects grouping quality
- Large repositories may need tighter limits

---

## Possible Future Features

- Label allowlist and denylist
- Ignore dependency-only PRs
- Custom section names
- Conventional commit support
- Changelog file generation
- Tag comparison links
- Summary-only mode
- Preview comments on PRs

---

## License

MIT
