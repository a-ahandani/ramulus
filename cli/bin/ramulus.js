#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { gitProblem, run, toplevel } from '../lib/git.js'
import { createServer } from '../lib/server.js'

const args = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))

// The native helper ships as one package per platform. Without one (an unsupported platform, a checkout, or RAMULUS_NODE=1) the Node helper below serves instead.
function nativeHelper() {
  if (process.env.RAMULUS_NODE) return undefined
  try {
    return createRequire(import.meta.url).resolve(`ramulus-${process.platform}-${process.arch}/bin/ramulus${process.platform === 'win32' ? '.exe' : ''}`)
  } catch {
    return undefined
  }
}

const native = nativeHelper()
if (native) {
  const child = spawn(native, [...args, '--ui', join(here, '..', 'ui')], { stdio: 'inherit' })
  // the helper stops its agents on these signals, so pass them on and exit with its code; a Windows console sends Ctrl+C to it directly
  if (process.platform !== 'win32') for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('error', (e) => {
    console.error(e.message)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  await new Promise(() => {})
}
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: ramulus [path] [--port N] [--no-open]\n\nServes the Ramulus UI for the repository at path (default: current directory).')
  process.exit(0)
}
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`Ramulus needs Node 20 or newer, and this is Node ${process.versions.node}. Update it from https://nodejs.org`)
  process.exit(1)
}
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) : 0
const noOpen = args.includes('--no-open')
const pathArg = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--port') ?? '.'

const root = resolve(pathArg)
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`No such folder: ${root}`)
  process.exit(1)
}
const problem = gitProblem(await run(root, ['--version']).then((r) => r.stdout, () => ''))
if (problem) {
  console.error(problem)
  process.exit(1)
}
const dir = await toplevel(root).catch((e) => {
  if (!/not a git repository/.test(e.message)) console.error(e.message.trim())
})

const uiDir = join(here, '..', 'ui')
if (!existsSync(join(uiDir, 'index.html'))) {
  console.error('The UI build is missing. Run `npm run build` in the cli folder first.')
  process.exit(1)
}

const token = randomBytes(16).toString('hex')
const server = createServer({ dir, root, uiDir, token })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    server.stopAgents()
    process.exit(0)
  })
}
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/#${token}`
  console.log(`${dir ? `Ramulus is serving ${dir}` : `${root} is not a git repository. Pick repositories in the browser.`}\n${url}\nPress Ctrl+C to stop.`)
  if (!noOpen) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  }
})
