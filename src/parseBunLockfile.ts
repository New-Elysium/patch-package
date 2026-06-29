import { spawnSync } from "child_process"

// Adapted from https://github.com/oven-sh/bun/blob/main/packages/bun-vscode/src/features/lockfile.ts,
// rewritten to use spawnSync instead of spawn.
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
