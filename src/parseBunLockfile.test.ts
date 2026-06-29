import { parseBunLockTextFile } from "./parseBunLockfile"
import { writeFileSync, rmSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * Tests for the new `bun.lock` text/JSONC lockfile parser (Bun >= 1.2,
 * including 1.3.14). The legacy `bun.lockb` binary format is exercised
 * indirectly through the bun CLI and is not unit-tested here.
 */
describe(parseBunLockTextFile, () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "patch-package-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("parses a minimal bun.lock with regular package entries", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          lockfileVersion: 1,
          packages: {
            chalk: [
              "chalk@4.1.2",
              "",
              { dependencies: { "ansi-styles": "^4.1.0" } },
              "sha512-aaa",
            ],
            yaml: ["yaml@2.9.0", "", {}, "sha512-bbb"],
          },
        },
        null,
        2,
      ),
    )
    const result = parseBunLockTextFile(lockPath)
    expect(result).toEqual({
      "chalk@4.1.2": { version: "4.1.2", resolved: undefined },
      "yaml@2.9.0": { version: "2.9.0", resolved: undefined },
    })
  })

  it("handles scoped packages (@scope/name@version)", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        packages: {
          "@types/node": ["@types/node@22.10.0", "", {}, "sha512-ccc"],
        },
      }),
    )
    const result = parseBunLockTextFile(lockPath)
    expect(result).toEqual({
      "@types/node@22.10.0": {
        version: "22.10.0",
        resolved: undefined,
      },
    })
  })

  it("handles npm: alias specifiers", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        packages: {
          // alias: "foo" is actually installed as "bar@1.2.3"
          foo: ["npm:bar@1.2.3", "", {}, "sha512-dddd"],
          bar: ["bar@1.2.3", "", {}, "sha512-eeee"],
        },
      }),
    )
    const result = parseBunLockTextFile(lockPath)
    expect(result["npm:bar@1.2.3"]).toEqual({
      version: "1.2.3",
      resolved: undefined,
    })
  })

  it("strips JSONC trailing commas and // comments", () => {
    const lockPath = join(tmpDir, "bun.lock")
    // Note the trailing comma after the last entry and the // comment.
    writeFileSync(
      lockPath,
      `{
        "lockfileVersion": 1,
        // this is a comment
        "packages": {
          "chalk": ["chalk@4.1.2", "", {}, "sha512-aaa",],
        },
      }`,
    )
    const result = parseBunLockTextFile(lockPath)
    expect(result).toEqual({
      "chalk@4.1.2": { version: "4.1.2", resolved: undefined },
    })
  })

  it("returns an empty object when packages is absent", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 1 }))
    const result = parseBunLockTextFile(lockPath)
    expect(result).toEqual({})
  })

  it("skips malformed package entries (non-array values)", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        packages: {
          // Bun's own workspace entry shape can vary; non-array entries
          // should be silently skipped.
          workspaceRoot: { some: "object" },
          chalk: ["chalk@4.1.2", "", {}, "sha512-aaa"],
        },
      }),
    )
    const result = parseBunLockTextFile(lockPath)
    expect(Object.keys(result)).toEqual(["chalk@4.1.2"])
  })

  it("throws a clear error when the JSON cannot be parsed", () => {
    const lockPath = join(tmpDir, "bun.lock")
    writeFileSync(lockPath, "{ this is not valid json ")
    expect(() => parseBunLockTextFile(lockPath)).toThrow(
      /Could not parse bun\.lock/,
    )
  })
})
