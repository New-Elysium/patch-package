# Changelog

## 1.0.0

- Add support for [bun](https://bun.sh) as a package manager. `patch-package`
  now detects `bun.lockb` lockfiles (and bun workspaces), and accepts a
  `--use-bun` flag analogous to `--use-yarn` for forcing bun.
- Package renamed to `@psync/patch-package`. The CLI command remains
  `patch-package`.
