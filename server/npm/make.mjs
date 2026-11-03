#!/usr/bin/env node
// Writes the npm package that carries one platform's native helper: node make.mjs <rust target> <binary> <out dir>
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TARGETS = {
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64'],
  'x86_64-unknown-linux-gnu': ['linux', 'x64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
  'x86_64-pc-windows-msvc': ['win32', 'x64'],
}

export const packageName = (platform, arch) => `ramulus-${platform}-${arch}`

const [target, binary, out] = process.argv.slice(2)
if (!TARGETS[target] || !binary || !out) {
  console.error(`Usage: make.js <${Object.keys(TARGETS).join('|')}> <binary> <out dir>`)
  process.exit(1)
}
const [platform, arch] = TARGETS[target]
const main = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'package.json'), 'utf8'))
mkdirSync(join(out, 'bin'), { recursive: true })
const file = join(out, 'bin', platform === 'win32' ? 'ramulus.exe' : 'ramulus')
copyFileSync(binary, file)
chmodSync(file, 0o755)
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: packageName(platform, arch), version: main.version, description: `The Ramulus helper for ${platform} ${arch}`, license: main.license, repository: main.repository, os: [platform], cpu: [arch], files: ['bin'] }, null, 2),
)
console.log(`${packageName(platform, arch)}@${main.version} -> ${out}`)
