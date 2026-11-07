import preact from '@preact/preset-vite'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { toplevel } from '../cli/lib/git.js'
import { createServer } from '../cli/lib/server.js'

function helper(): Plugin {
  const token = (process.env.RAMULUS_DEV_TOKEN ||= randomBytes(16).toString('hex'))
  let api: ReturnType<typeof createServer>
  return {
    name: 'ramulus-helper',
    apply: (_, env) => env.command === 'serve' && !process.env.VITEST,
    async config() {
      const dir = await toplevel(resolve(process.env.RAMULUS_REPO ?? '..'))
      api = createServer({ dir, uiDir: resolve('../cli/ui'), token })
      await new Promise<void>((done) => api.listen(0, '127.0.0.1', done))
      console.log(`Serving ${dir}`)
      return { server: { open: `/#${token}`, proxy: { '/api': { target: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, ws: true } } } }
    },
    configureServer(server) {
      server.httpServer?.once('close', () => api.close())
      const print = server.printUrls
      server.printUrls = () => {
        print()
        server.config.logger.info(`  ➜  Ramulus: ${server.resolvedUrls?.local[0]}#${token}`)
      }
    },
  }
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [preact(), helper()],
})
