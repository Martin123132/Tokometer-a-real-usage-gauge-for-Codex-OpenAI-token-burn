import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electron = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'electron.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron')
const url = process.env.TOKEN_GAUGE_URL ?? 'http://127.0.0.1:5173/'

const server = spawn(
  npm,
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'],
  {
    cwd: root,
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)

await waitForHealth('http://127.0.0.1:5173/api/health')

const desktop = spawn(electron, ['electron/main.cjs'], {
  cwd: root,
  shell: false,
  stdio: 'inherit',
  env: { ...process.env, TOKEN_GAUGE_URL: url },
})

desktop.on('exit', (code) => {
  server.kill()
  process.exit(code ?? 0)
})

process.on('SIGINT', () => {
  desktop.kill()
  server.kill()
  process.exit(0)
})

function waitForHealth(healthUrl) {
  const started = Date.now()

  return new Promise((resolve, reject) => {
    const poll = () => {
      http
        .get(healthUrl, (response) => {
          response.resume()
          if (response.statusCode && response.statusCode < 500) {
            resolve()
            return
          }
          retry()
        })
        .on('error', retry)
    }

    const retry = () => {
      if (Date.now() - started > 30_000) {
        reject(new Error('Timed out waiting for Tokometer dev server'))
        return
      }
      setTimeout(poll, 300)
    }

    poll()
  })
}
