import {
  createStrictBaseline,
  listTarGzEntries,
  pruneToBaseline,
} from "./strictMode"
import { gzipSync } from "zlib"
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "./path"

/**
 * Builds a tiny gzipped tarball in-memory containing a small set of
 * files. Used so tests can exercise `listTarGzEntries` without network.
 */
function buildFakeTarball(
  files: Array<{ name: string; content: string }>,
): Buffer {
  const HEADER_SIZE = 512
  const BLOCK_SIZE = 512

  const blocks: Buffer[] = []
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, "utf8").subarray(0, 100)
    const contentBytes = Buffer.from(f.content, "utf8")
    const header = Buffer.alloc(HEADER_SIZE)
    nameBytes.copy(header, 0)
    // size, octal, 12 bytes at offset 124
    const sizeOct = contentBytes.length.toString(8).padStart(11, "0") + "\0"
    header.write(sizeOct, 124, 12, "ascii")
    // typeflag = '0' (regular file)
    header.write("0", 156, 1, "ascii")
    // magic = "ustar\0" + version "00"
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    blocks.push(header)
    blocks.push(contentBytes)
    const padding = BLOCK_SIZE - (contentBytes.length % BLOCK_SIZE)
    if (padding !== BLOCK_SIZE) blocks.push(Buffer.alloc(padding))
  }
  // End-of-archive marker: two zero blocks
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2))

  return gzipSync(Buffer.concat(blocks))
}

describe(listTarGzEntries, () => {
  it("extracts file paths from a tarball", () => {
    const buf = buildFakeTarball([
      { name: "package/lib/index.js", content: "module.exports = 1" },
      { name: "package/package.json", content: "{}" },
    ])
    const entries = listTarGzEntries(buf)
    expect(entries.sort()).toEqual(["lib/index.js", "package.json"])
  })

  it("returns empty array on an empty tarball", () => {
    const buf = gzipSync(Buffer.concat([Buffer.alloc(1024)]))
    expect(listTarGzEntries(buf)).toEqual([])
  })

  it("handles tarballs without a leading prefix", () => {
    const buf = buildFakeTarball([{ name: "index.js", content: "//" }])
    expect(listTarGzEntries(buf)).toEqual(["index.js"])
  })
})

describe(createStrictBaseline, () => {
  it("resolves a tarball URL by listing files", async () => {
    // Use the registry endpoint with a real package to verify end-to-end.
    // This is a smoke test, so we limit it to a single small package.
    const provider = createStrictBaseline({
      packageName: "chalk",
      resolution: "https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz",
      appPath: "/tmp",
    })
    const files = await provider.getOriginalTarballFiles()
    expect(files).not.toBeNull()
    if (files) {
      expect(files.has("package.json")).toBe(true)
      expect(files.has("source/index.js")).toBe(true)
    }
  })

  it("returns null for git URLs", async () => {
    const provider = createStrictBaseline({
      packageName: "git-pkg",
      resolution: "git+https://example.com/pkg.git",
      appPath: "/tmp",
    })
    expect(await provider.getOriginalTarballFiles()).toBeNull()
  })

  it("returns null for non-version non-URL bare strings", async () => {
    const provider = createStrictBaseline({
      packageName: "wat",
      resolution: "tag: latest",
      appPath: "/tmp",
    })
    expect(await provider.getOriginalTarballFiles()).toBeNull()
  })

  it("walks a local file: resolution", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-pkg-strict-"))
    try {
      mkdirSync(join(tmpDir, "src"), { recursive: true })
      writeFileSync(join(tmpDir, "src/index.js"), "// ok")
      writeFileSync(join(tmpDir, "package.json"), "{}")
      const provider = createStrictBaseline({
        packageName: "localpkg",
        resolution: `file:${tmpDir}`,
        appPath: "/anywhere",
      })
      const files = await provider.getOriginalTarballFiles()
      expect(files).not.toBeNull()
      if (files) {
        expect(files.has("src/index.js")).toBe(true)
        expect(files.has("package.json")).toBe(true)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe(pruneToBaseline, () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "patch-pkg-prune-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("removes files not in the baseline and reports count", () => {
    writeFileSync(join(tmpDir, "kept.js"), "")
    writeFileSync(join(tmpDir, "drift.js"), "")
    mkdirSync(join(tmpDir, "sub"), { recursive: true })
    writeFileSync(join(tmpDir, "sub/another.js"), "")
    writeFileSync(join(tmpDir, "sub/extra.txt"), "")

    const baseline = new Set(["kept.js", "sub/another.js"])
    const { pruned } = pruneToBaseline(tmpDir, baseline)

    expect(pruned).toBe(2)
    // Drift files are gone; expected files remain
    expect(existsSync(join(tmpDir, "kept.js"))).toBe(true)
    expect(existsSync(join(tmpDir, "drift.js"))).toBe(false)
    expect(existsSync(join(tmpDir, "sub/another.js"))).toBe(true)
    expect(existsSync(join(tmpDir, "sub/extra.txt"))).toBe(false)
  })

  it("removes directories that became empty after pruning", () => {
    mkdirSync(join(tmpDir, "empty-dir"), { recursive: true })
    writeFileSync(join(tmpDir, "empty-dir/only.js"), "")
    expect(existsSync(join(tmpDir, "empty-dir"))).toBe(true)

    pruneToBaseline(tmpDir, new Set()) // empty baseline removes everything

    expect(existsSync(join(tmpDir, "empty-dir"))).toBe(false)
  })

  it("returns 0 when nothing needs pruning", () => {
    writeFileSync(join(tmpDir, "only.js"), "")
    const { pruned } = pruneToBaseline(tmpDir, new Set(["only.js"]))
    expect(pruned).toBe(0)
    expect(existsSync(join(tmpDir, "only.js"))).toBe(true)
  })
})

// existsSync is brought in via the strict-mode harness; we just declare a
// local ref so this file can stay self-contained.
import { existsSync } from "fs"
