import { spawnSync } from "child_process"
import { readFileSync } from "fs-extra"

/**
 * Parses the legacy `bun.lockb` binary lockfile (Bun < 1.2) by running
 * `bun <path>`, which prints the lockfile in yarn-v1 text format.
 *
 * Returns the yarn-v1 text so it can be fed to `@yarnpkg/lockfile`'s parser.
 */
export function parseBunLockfile(lockFilePath: string): string {
  const process = spawnSync("bun", [lockFilePath], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (process.status !== 0) {
    throw new Error(
      `Bun exited with code: ${process.status}\n${process.stderr.toString()}`,
    )
  }
  return process.stdout.toString()
}

/**
 * Parses the new `bun.lock` text/JSONC lockfile (Bun >= 1.2, including
 * 1.3.14) and converts it into a yarn-v1-lockfile-compatible object so the
 * rest of the resolution logic can treat bun like yarn.
 *
 * Each package entry in `bun.lock` has the form:
 *
 *   "name": ["full-specifier@version", "path", { ...metadata }, "integrity"]
 *
 * This is transformed to yarn v1 shape:
 *
 *   "full-specifier@version": { version: "version", resolved: undefined }
 *
 * The `resolved` URL is not stored in `bun.lock` (only the integrity hash),
 * so it is left `undefined`. The downstream resolution logic already falls
 * back to the version/alias/file specifier when `resolved` is missing.
 */
export function parseBunLockTextFile(
  lockFilePath: string,
): Record<string, { version: string; resolved?: string }> {
  const raw = readFileSync(lockFilePath, "utf8")
  const cleaned = stripJsonc(raw)
  let data: { packages?: Record<string, unknown> }
  try {
    data = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(
      `Could not parse bun.lock file at ${lockFilePath}: ${(e as Error).message}`,
    )
  }
  const packages = data.packages ?? {}
  const result: Record<string, { version: string; resolved?: string }> = {}
  for (const entry of Object.values(packages)) {
    if (!Array.isArray(entry)) continue
    const specifier = entry[0]
    if (typeof specifier !== "string") continue
    const version = extractVersion(specifier)
    result[specifier] = { version, resolved: undefined }
  }
  return result
}

/**
 * Extracts the version (or meaningful resolution token) from a bun.lock
 * package specifier.
 *
 * Specifier forms handled:
 *   "name@1.2.3"
 *   "@scope/name@1.2.3"
 *   "npm:other-name@1.2.3"
 *   "file:./path"
 *   "workspace:^"
 *   "link:./path"
 */
function extractVersion(specifier: string): string {
  const prefixMatch = specifier.match(/^(npm:|file:|workspace:|link:)/)
  if (prefixMatch) {
    const rest = specifier.slice(prefixMatch[0].length)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return rest.slice(atIdx + 1)
    }
    return rest
  }
  const atIdx = specifier.lastIndexOf("@")
  if (atIdx > 0) {
    return specifier.slice(atIdx + 1)
  }
  return specifier
}

/**
 * Strips JSONC extensions (// comments and trailing commas) so the file can
 * be parsed with `JSON.parse`. Bun's `bun.lock` allows both.
 */
function stripJsonc(text: string): string {
  // Strip single-line `//` comments. (bun.lock does not use block comments.)
  let out = text.replace(/^\s*\/\/.*$/gm, "")
  // Remove trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return out
}
