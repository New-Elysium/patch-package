# CLAUDE.md

Guidelines and orientation for AI agents (Claude or otherwise) working on this
codebase. Read this before making changes.

## What this project is

`patch-package` lets app authors make and keep fixes to their `node_modules`
dependencies by generating `.patch` files that are re-applied on `postinstall`.

This is a **scoped fork** of the original `patch-package`, published as
**`@psync/patch-package`**. It has been modernised for:

- **TypeScript 6** (was 4.2)
- **Bun 1.3.14** as a first-class package manager (in addition to npm & yarn)
- **Bun** as the development toolchain (replaces yarn for all dev scripts)

## Critical: Bun lockfile formats

Bun has **two** lockfile formats. Both MUST be supported.

| Format     | Bun version   | Type        | Parse strategy                                                  |
| ---------- | ------------- | ----------- | --------------------------------------------------------------- |
| `bun.lock` | >= 1.2 (incl. 1.3.14) | Text/JSONC  | Read directly, strip `//` comments and trailing commas, `JSON.parse` |
| `bun.lockb`| < 1.2         | Binary      | Spawn `bun <path>` to dump as yarn-v1 text, then parse that       |

`bun.lock` is the **default** for current Bun (1.3.14+). `bun.lockb` is legacy
but kept for backward compatibility. Detection and parsing logic that touches
bun MUST handle both — see `src/detectPackageManager.ts` (`findBunLockfilePath`)
and `src/parseBunLockfile.ts` (`parseBunLockTextFile` vs `parseBunLockfile`).

When in doubt, prefer `bun.lock` over `bun.lockb` if both exist.

## Package manager detection

Detection lives in `src/detectPackageManager.ts`. Order of precedence:

1. CLI overrides: `--use-yarn` or `--use-bun` (`--use-yarn` wins if both)
2. Conflict resolution when multiple lockfiles exist:
   - npm lockfile + yarn lockfile → npm (with warning)
   - npm lockfile + bun lockfile → npm (with warning)
   - yarn lockfile + bun lockfile → yarn (with warning)
3. Single lockfile → that package manager
4. No lockfile → error and `process.exit(1)`

Lockfiles are searched starting from `findWorkspaceRoot()` (yarn/bun
workspaces) or `appRootPath` (npm lockfiles), to support monorepos.

## Build & test

```sh
bun install              # install deps
bun run typecheck        # tsc --noEmit (FAST - run this first)
bun run build            # full build to dist/
bun run clean            # rm -rf dist
bun run test:unit        # jest unit tests (src/ only)
bun run test             # full test suite via run-tests.sh
```

Always run `bun run typecheck` after edits. It is the fastest signal.

## TypeScript conventions (important)

- **`moduleResolution: "bundler"`** with **`module: "commonjs"`** (see
  `tsconfig.json`). This is a pragmatic combo for TS 6 compatibility.
- **Every relative import MUST include the `.js` extension**, even though the
  source files are `.ts`. Example: `import { x } from "./foo.js"`. This is
  required by the `bundler`/`commonjs` setup. Do not omit extensions.
- `rootDir: "./src"` is set in `tsconfig.build.json` so build output lands in
  `dist/` (not `dist/src/`).
- Test files (`*.test.ts`) are excluded from the build via the `prepack`
  script which deletes them from `dist/`.
- **Do NOT** add `"ignoreDeprecations": "6.0"` — the maintainer has
  explicitly rejected this. Fix the underlying issue instead.

## Windows compatibility

- Bun does **not** expand globs (`*.js`) before passing them to subprocesses
  on Windows. `*` is also illegal in Windows filenames, so `rimraf` will fail
  on unexpanded globs.
- **Solution:** Prefer Node.js `fs` operations in `package.json` scripts
  instead of shell glob expansion. See the existing `prepack` script for the
  pattern (it uses `node -e "..."` with `fs.readdirSync` recursion).

## Key files

| Path                                  | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `index.js`                            | CLI entry point (`bin`). Thin wrapper around `dist/index.js`.          |
| `src/index.ts`                        | CLI arg parsing (`minimist`), dispatches to `makePatch` or `applyPatches`. |
| `src/detectPackageManager.ts`         | Detects npm/yarn/bun from lockfiles. Exports `findBunLockfilePath`.    |
| `src/parseBunLockfile.ts`             | `parseBunLockfile` (binary `.lockb`) and `parseBunLockTextFile` (text `.lock`). |
| `src/getPackageResolution.ts`         | Resolves a package to a version/URL/alias for the temp install.        |
| `src/makePatch.ts`                    | Core patch-creation logic: temp dir, install, diff, write `.patch`.    |
| `src/applyPatches.ts`                 | Applies existing `.patch` files to `node_modules` on `postinstall`.    |
| `src/patch/parse.ts`                  | Parses `.patch` file format.                                           |
| `src/patch/apply.ts`                  | Applies a parsed patch to the filesystem.                              |
| `src/PackageDetails.ts`               | Parses patch filenames (`name+version.patch`) and CLI specifiers.      |
| `package.json`                        | Named `@psync/patch-package`. `engines.bun: ">=1.3.14"`.               |

## How a patch is made (high level)

1. User edits files in `node_modules/foo/`.
2. Runs `patch-package foo`.
3. `makePatch` creates a temp git repo, writes a minimal `package.json` with
   just `dependencies: { foo: <resolution> }`, runs the detected package
   manager's install, then `git diff` to produce the patch.
4. `<resolution>` comes from `getPackageResolution`, which reads the user's
   lockfile (npm/yarn/bun.lock/bun.lockb).
5. Patch is written to `patches/foo+<version>.patch`.

## Pre-existing test failures (do not try to fix)

There are **29 snapshot test failures** that exist on a clean HEAD and are
**unrelated to ongoing work**:

- Jest 30 changed snapshot format (`Object {` → `{`).
- Several snapshot tests reference graphql patch output with quote-style
  differences.

These show up across `src/PackageDetails.test.ts`, `src/patch/parse.test.ts`,
`src/patch/read.test.ts`, and `src/resolveRelativeFileDependencies.test.ts`.
**Do not treat these as caused by your changes** unless your change is
obviously in those areas. Verify by running tests on a clean checkout first.

To update snapshots (only if intended): `bun run test:unit -- -u`.

## Code style

- Prettier config: `--no-semi --trailing-comma=all`. Run `bun run format`.
- 2-space indentation, no semicolons, trailing commas everywhere.
- Names use camelCase for functions/variables, PascalCase for types/classes.

## Don'ts

- Don't rename the package away from `@psync/patch-package` without
  explicit instruction.
- Don't change `moduleResolution`/`module` in tsconfig without discussing
  the migration cost (every relative import would need revisiting).
- Don't add `ignoreDeprecations` to tsconfig.
- Don't switch the dev toolchain away from bun (yarn lockfiles have been
  deliberately removed).
- Don't use shell glob expansion in `package.json` scripts (Windows).
