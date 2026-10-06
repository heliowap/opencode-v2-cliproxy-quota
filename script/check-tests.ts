// Fails when any test still passes after every function exported from src/ is replaced by one that returns
// undefined. Such a test observes no behavior, so it cannot catch a defect.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const modules = ["src/quota.ts", "src/client.ts"]

const stubs = await Promise.all(
  modules.map(async (file) => {
    const exported = await import(path.join(root, file))
    const names = Object.keys(exported).filter((name) => typeof exported[name] === "function")
    return `mock.module(${JSON.stringify(path.join(root, file))}, () => ({ ${names.map((name) => `${name}: () => undefined`).join(", ")} }))`
  }),
)

const dir = await mkdtemp(path.join(tmpdir(), "check-tests-"))
const preload = path.join(dir, "preload.ts")
const config = path.join(dir, "bunfig.toml")
await Bun.write(preload, `import { mock } from "bun:test"\n${stubs.join("\n")}\n`)
await Bun.write(config, "")

const report = path.join(dir, "report.xml")
Bun.spawnSync(["bun", `--config=${config}`, "test", "--preload", preload, "--reporter=junit", `--reporter-outfile=${report}`], {
  cwd: root,
  stderr: "ignore",
  stdout: "ignore",
})
const xml = await Bun.file(report).text().catch(() => "")
await rm(dir, { recursive: true })

// In the JUnit report a passing test is a self-closing <testcase/>; a failing one wraps a <failure>.
const cases = [...xml.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]*?(\/?)>/g)]
const passed = cases.filter((match) => match[3] === "/").map((match) => `${match[2]} > ${match[1]}`)

if (cases.length === 0) {
  console.error("No tests ran with the stubbed modules.")
  process.exit(1)
}
if (passed.length > 0) {
  console.error("These tests pass even when every function in src/ returns undefined:")
  passed.forEach((name) => console.error(`  ${name}`))
  process.exit(1)
}
console.log(`All ${cases.length} tests fail when every function in src/ returns undefined.`)
