// Add .js extension to all extensionless relative imports
const fs = require("fs")
const path = require("path")

const srcDir = path.resolve(process.argv[2] || "src")

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...walk(full))
    else if (e.name.endsWith(".ts")) files.push(full)
  }
  return files
}

const files = walk(srcDir)
let changed = 0

for (const file of files) {
  const text = fs.readFileSync(file, "utf8")
  // Match: from "./..." or from "../..." — NOT already ending in a known extension
  const re = /from "(\.\.?\/[^"]+)"/g
  let m
  let newText = text
  while ((m = re.exec(text)) !== null) {
    const spec = m[1]
    // Skip if it already has a file extension (.js, .json, etc.)
    if (/\.[a-z]{2,6}$/i.test(spec)) continue
    newText = newText.replace(`from "${spec}"`, `from "${spec}.js"`)
  }
  if (newText !== text) {
    fs.writeFileSync(file, newText)
    changed++
    console.log("  fixed:", path.relative(srcDir, file))
  }
}

console.log(`Done: ${changed} files updated.`)
