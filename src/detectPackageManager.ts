import fs from "fs-extra"
import { join } from "./path"
import chalk from "chalk"
import process from "process"
import findWorkspaceRoot from "find-yarn-workspace-root"

export type PackageManager = "yarn" | "npm" | "npm-shrinkwrap" | "bun"

/**
 * The set of lockfile filenames patch-package recognises for each package
 * manager. Exposed so other modules can resolve the actual file in use.
 */
export const LOCKFILE_NAMES = {
  yarn: "yarn.lock",
  npm: "package-lock.json",
  "npm-shrinkwrap": "npm-shrinkwrap.json",
  // bun.lockb is the legacy binary lockfile (Bun < 1.2).
  // bun.lock is the text/JSONC lockfile used by Bun >= 1.2 (incl. 1.3.14).
  bun: "bun.lock",
  bunLegacy: "bun.lockb",
} as const

function printNoYarnLockfileError() {
  console.log(`
${chalk.red.bold("**ERROR**")} ${chalk.red(
    `The --use-yarn option was specified but there is no yarn.lock file`,
  )}
`)
}

function printNoBunLockfileError() {
  console.log(`
${chalk.red.bold("**ERROR**")} ${chalk.red(
    `The --use-bun option was specified but there is no bun.lock or bun.lockb file`,
  )}
`)
}

function printNoLockfilesError() {
  console.log(`
${chalk.red.bold("**ERROR**")} ${chalk.red(
    `No package-lock.json, npm-shrinkwrap.json, yarn.lock, bun.lock, or bun.lockb file.

You must use either npm@>=5, yarn, npm-shrinkwrap, or bun to manage this project's
dependencies.`,
  )}
`)
}

function printSelectingDefaultMessage() {
  console.info(
    `${chalk.bold(
      "patch-package",
    )}: you have multiple lockfiles, e.g. yarn.lock and package-lock.json
Defaulting to using ${chalk.bold("npm")}
You can override this setting by passing --use-yarn, --use-bun, or
deleting the conflicting lockfile if you don't need it
`,
  )
}

function printSelectingDefaultYarnMessage() {
  console.info(
    `${chalk.bold(
      "patch-package",
    )}: you have both yarn.lock and a bun lockfile (bun.lock or bun.lockb)
Defaulting to using ${chalk.bold("yarn")}
You can override this setting by passing --use-bun, or
deleting yarn.lock if you don't need it
`,
  )
}

function checkForYarnOverride(overridePackageManager: PackageManager | null) {
  if (overridePackageManager === "yarn") {
    printNoYarnLockfileError()
    process.exit(1)
  }
}

function checkForBunOverride(overridePackageManager: PackageManager | null) {
  if (overridePackageManager === "bun") {
    printNoBunLockfileError()
    process.exit(1)
  }
}

export const detectPackageManager = (
  appRootPath: string,
  overridePackageManager: PackageManager | null,
): PackageManager => {
  const packageLockExists = fs.existsSync(
    join(appRootPath, "package-lock.json"),
  )
  const shrinkWrapExists = fs.existsSync(
    join(appRootPath, "npm-shrinkwrap.json"),
  )
  const yarnLockExists = fs.existsSync(
    join(findWorkspaceRoot() ?? appRootPath, "yarn.lock"),
  )
  // Bun workspaces seem to work the same as yarn workspaces - https://bun.sh/docs/install/workspaces
  // bun.lock is the text/JSONC format used by Bun >= 1.2 (incl. 1.3.14).
  // bun.lockb is the legacy binary format used by Bun < 1.2.
  const bunLockExists = fs.existsSync(
    join(findWorkspaceRoot() ?? appRootPath, "bun.lock"),
  )
  const bunLockbExists = fs.existsSync(
    join(findWorkspaceRoot() ?? appRootPath, "bun.lockb"),
  )
  const anyBunLockExists = bunLockExists || bunLockbExists
  if (
    [
      packageLockExists || shrinkWrapExists,
      yarnLockExists,
      anyBunLockExists,
    ].filter(Boolean).length > 1
  ) {
    if (overridePackageManager) {
      return overridePackageManager
    }
    if (!packageLockExists && !shrinkWrapExists) {
      // The only case where we don't want to default to npm is when we have both yarn and bun lockfiles.
      printSelectingDefaultYarnMessage()
      return "yarn"
    }
    printSelectingDefaultMessage()
    return shrinkWrapExists ? "npm-shrinkwrap" : "npm"
  } else if (packageLockExists || shrinkWrapExists) {
    checkForYarnOverride(overridePackageManager)
    checkForBunOverride(overridePackageManager)
    return shrinkWrapExists ? "npm-shrinkwrap" : "npm"
  } else if (yarnLockExists) {
    checkForBunOverride(overridePackageManager)
    return "yarn"
  } else if (anyBunLockExists) {
    checkForYarnOverride(overridePackageManager)
    return "bun"
  } else {
    printNoLockfilesError()
    process.exit(1)
  }
  throw Error()
}

/**
 * Returns the path to the actual bun lockfile that exists on disk, preferring
 * the new `bun.lock` text format over the legacy `bun.lockb` binary format.
 *
 * Returns `null` if neither exists.
 */
export function findBunLockfilePath(appRootPath: string): string | null {
  const root = findWorkspaceRoot() ?? appRootPath
  if (fs.existsSync(join(root, "bun.lock"))) {
    return join(root, "bun.lock")
  }
  if (fs.existsSync(join(root, "bun.lockb"))) {
    return join(root, "bun.lockb")
  }
  return null
}
