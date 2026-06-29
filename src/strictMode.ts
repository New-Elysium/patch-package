import { gunzipSync } from "zlib"
import { request as httpsRequest, RequestOptions } from "https"
import {
  request as httpRequest,
  RequestOptions as HttpRequestOptions,
} from "http"
import { URL } from "url"
import { removeSync } from "fs-extra"
import { existsSync, statSync, readdirSync, rmdirSync } from "fs"
import { join } from "path"
import { resolve as resolvePath } from "./path"

/**
 * Strict-mode support for `patch-package`.
 *
 * In strict mode, after the user's edited copy of the package has been
 * staged in the temp git repo, any file whose path was NOT part of the
 * original published package (the tarball at the resolved URL) is removed
 * from the tree before computing the diff. This prevents the
 * "--- /dev/null" ("new file") entries that appear when a package manager
 * install in the temp directory produces a slightly different file layout
 * than the user's `node_modules` copy.
 *
 * Returns `null` when the baseline cannot be determined — callers warn the
 * user and proceed without strict filtering.
 */
export type StrictBaselineProvider = {
  /** Set of relative file paths (forward slashes) that the original
   * published package contained, or `null` if not determinable. */
  getOriginalTarballFiles(): Promise<Set<string> | null>
}

/**
 * Build a baseline provider for a given package resolution.
 *
 * `resolution` is whatever `getPackageResolution` returned — typically:
 *  - "https://registry.yarnpkg.com/foo/-/foo-1.2.3.tgz#sha512-..."  (yarn / bun.lockb)
 *  - "https://registry.npmjs.org/foo/-/foo-1.2.3.tgz"               (npm via lockfile)
 *  - "1.2.3"                                                        (version-only, e.g. bun.lock text)
 *  - "npm:bar@1.2.3"                                                (alias)
 *  - "file:./path"                                                  (local file)
 *  - "git+https://..."                                              (git url)
 */
export function createStrictBaseline({
  packageName,
  resolution,
  appPath,
}: {
  packageName: string
  resolution: string
  appPath: string
}): StrictBaselineProvider {
  return {
    async getOriginalTarballFiles() {
      // CASE 1: file:./path -> walk local directory and return relative paths
      if (process.env.PATCH_PACKAGE_DEBUG) {
        process.stderr.write(
          `[strict] resolving ${packageName} resolution=${JSON.stringify(resolution)}\n`,
        )
      }
      if (resolution.startsWith("file:")) {
        const localPath = resolvePath(appPath, resolution.slice("file:".length))
        if (!existsSync(localPath)) return null
        try {
          if (statSync(localPath).isDirectory()) {
            return walkLocalDirectory(localPath, localPath)
          }
        } catch {
          return null
        }
        return null
      }

      // CASE 2: looks like a .tgz URL -> download, gunzip, parse tar
      if (
        resolution.endsWith(".tgz") ||
        resolution.endsWith(".tar.gz") ||
        /\bhttps?:\/\/.*\.(tgz|tar\.gz)(\?|#|$)/i.test(resolution)
      ) {
        const url = resolution.split("#")[0]
        try {
          const tarball = await fetchBuffer(url)
          return new Set(listTarGzEntries(tarball))
        } catch {
          return null
        }
      }

      // CASE 3: looks like a git URL
      if (resolution.startsWith("git+") || resolution.endsWith(".git")) {
        return null
      }

      // CASE 4: plain version like "1.2.3", possibly with an `npm:` alias
      // -> resolve via the npm registry metadata endpoint
      const aliasResolved = parseNpmAlias(resolution)
      const name = aliasResolved.name ?? packageName
      const version = aliasResolved.version ?? resolution
      if (!version.match(/^v?\d/)) return null
      try {
        if (process.env.PATCH_PACKAGE_DEBUG) {
          process.stderr.write(
            `[strict] case 4: name=${name} version=${version}\n`,
          )
        }
        const tarballUrl = await fetchTarballUrlFromRegistry(name, version)
        if (!tarballUrl) {
          if (process.env.PATCH_PACKAGE_DEBUG) {
            process.stderr.write(
              `[strict] registry lookup returned no tarball URL\n`,
            )
          }
          return null
        }
        if (process.env.PATCH_PACKAGE_DEBUG) {
          process.stderr.write(`[strict] downloading ${tarballUrl}\n`)
        }
        const tarball = await fetchBuffer(tarballUrl)
        const entries = listTarGzEntries(tarball)
        if (process.env.PATCH_PACKAGE_DEBUG) {
          process.stderr.write(
            `[strict] parsed ${entries.length} entries from tarball\n`,
          )
        }
        return new Set(entries)
      } catch (e) {
        if (process.env.PATCH_PACKAGE_DEBUG) {
          process.stderr.write(
            `[strict] case 4 threw: ${(e as Error).message}\n`,
          )
        }
        return null
      }
    },
  }
}

function parseNpmAlias(resolution: string): {
  name?: string
  version?: string
} {
  if (resolution.startsWith("npm:")) {
    const rest = resolution.slice("npm:".length)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { name: rest }
  }
  if (/^v?\d/.test(resolution)) {
    return { version: resolution }
  }
  return {}
}

/** Walks a local directory recursively and returns forward-slash relative paths. */
function walkLocalDirectory(root: string, current: string): Set<string> {
  const out = new Set<string>()
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const abs = join(current, entry.name)
    const rel = abs.slice(root.length + 1).replace(/\\/g, "/")
    if (entry.isDirectory()) {
      out.add(rel + "/")
      for (const sub of walkLocalDirectory(root, abs)) {
        out.add(sub)
      }
    } else if (entry.isFile()) {
      out.add(rel)
    }
  }
  return out
}

/**
 * Fetches the `dist.tarball` URL for a package version from the npm registry
 * metadata endpoint. Returns null if the package/version can't be found.
 */
function fetchTarballUrlFromRegistry(
  name: string,
  version: string,
): Promise<string | null> {
  const encodedName = name.startsWith("@")
    ? "@" + encodeURIComponent(name.slice(1))
    : encodeURIComponent(name)
  const url = `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`
  return new Promise((resolveP) => {
    fetchJson(url)
      .then((json) => {
        const tarball = json?.dist?.tarball
        resolveP(typeof tarball === "string" ? tarball : null)
      })
      .catch(() => resolveP(null))
  })
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      rejectP(new Error(`Invalid URL: ${url}`))
      return
    }
    const lib = parsed.protocol === "https:" ? httpsRequest : httpRequest
    const opts = {
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": "patch-package",
        Accept: "application/octet-stream, */*",
      },
    } as RequestOptions & HttpRequestOptions
    const req = lib(opts, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        fetchBuffer(res.headers.location).then(resolveP, rejectP)
        res.resume()
        return
      }
      if (res.statusCode !== 200) {
        rejectP(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolveP(Buffer.concat(chunks)))
      res.on("error", rejectP)
    })
    req.on("error", rejectP)
    req.setTimeout(15000, () =>
      req.destroy(new Error("Tarball download timed out")),
    )
    req.end()
  })
}

function fetchJson(url: string): Promise<any> {
  return fetchBuffer(url).then((buf) => JSON.parse(buf.toString("utf8")))
}

/**
 * Lists the file paths inside a gzipped tarball buffer.
 *
 * Tar format: 512-byte header + <size> bytes of file content, padded to
 * the next 512-byte boundary. We don't extract file contents — only the
 * `name` field of each header is read, which is enough to compute the
 * baseline file set.
 */
export function listTarGzEntries(tarGz: Buffer): string[] {
  const tar = gunzipSync(tarGz)
  const out: string[] = []
  const HEADER_SIZE = 512
  const BLOCK_SIZE = 512

  // Common prefix (e.g. "package/") that npm and yarn add to every entry —
  // stripped so paths match the user's node_modules layout.
  let leadingPrefix: string | null = null

  let offset = 0
  while (offset + HEADER_SIZE <= tar.length) {
    if (
      tar[offset] === 0 &&
      tar.subarray(offset, offset + HEADER_SIZE).every((b) => b === 0)
    ) {
      break
    }

    const name = readCString(tar, offset, 100)
    const sizeOctal = readCString(tar, offset + 124, 12)
    const typeFlag = String.fromCharCode(tar[offset + 156])

    const entrySize = parseOctal(sizeOctal) || 0
    const paddedSize = Math.ceil(entrySize / BLOCK_SIZE) * BLOCK_SIZE

    // PAX extended header / long-name redirect — skip its blocks only.
    if (typeFlag === "x" || typeFlag === "g" || typeFlag === "L") {
      offset += HEADER_SIZE + paddedSize
      continue
    }

    if (leadingPrefix === null && name) {
      const firstSlash = name.indexOf("/")
      leadingPrefix = firstSlash >= 0 ? name.slice(0, firstSlash + 1) : ""
    }

    if (leadingPrefix && name.startsWith(leadingPrefix)) {
      const cleaned = name.slice(leadingPrefix.length)
      if (cleaned && !cleaned.endsWith("/")) {
        out.push(cleaned)
      }
    } else if (name && !name.endsWith("/")) {
      out.push(name)
    }

    offset += HEADER_SIZE + paddedSize
  }

  return out
}

/** Read a NUL-terminated UTF-8 string of `maxLen` bytes at `offset`. */
function readCString(buf: Buffer, offset: number, maxLen: number): string {
  const slice = buf.subarray(offset, offset + maxLen)
  const nulIdx = slice.indexOf(0)
  return slice.subarray(0, nulIdx < 0 ? maxLen : nulIdx).toString("utf8")
}

/** Parse an octal string (e.g. "000142") into a number. */
function parseOctal(s: string): number {
  const trimmed = s.replace(/\0/g, "").trim()
  if (!trimmed) return 0
  if (/^[0-7]+$/.test(trimmed)) {
    return parseInt(trimmed, 8)
  }
  return 0
}

/**
 * Removes files from `treeRoot` whose relative paths (forward slashes, sans
 * leading `./`) are NOT in `baseline`. Any directory that becomes empty as
 * a side effect is also removed, so git doesn't include empty-dir noise in
 * the resulting patch.
 */
export function pruneToBaseline(
  treeRoot: string,
  baseline: Set<string>,
): { pruned: number } {
  let pruned = 0
  walk(treeRoot, (absPath, relativePath) => {
    if (!statSync(absPath).isFile()) return
    const normalized = relativePath.replace(/\\/g, "/")
    if (!baseline.has(normalized)) {
      removeSync(absPath)
      pruned++
    }
  })
  pruneEmptyDirs(treeRoot)
  return { pruned }
}

function walk(
  root: string,
  visit: (absPath: string, relPath: string) => void,
): void {
  function recurse(absPath: string, relPath: string): void {
    const entries = readdirSync(absPath, { withFileTypes: true })
    for (const entry of entries) {
      const childAbs = join(absPath, entry.name)
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        recurse(childAbs, childRel)
      } else {
        visit(childAbs, childRel)
      }
    }
  }
  recurse(root, "")
}

function pruneEmptyDirs(root: string): void {
  function recurse(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      recurse(child)
    }
    if (dir !== root && readdirSync(dir).length === 0) {
      try {
        rmdirSync(dir)
      } catch {
        // ignore
      }
    }
  }
  recurse(root)
}
