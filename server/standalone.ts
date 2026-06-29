import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getUsageSummaryWithBackgroundScan } from './usage'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(root, 'dist')
const port = Number(process.env.PORT ?? 4173)
const host = process.env.HOST ?? '127.0.0.1'

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
])

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

  if (url.pathname === '/api/health') {
    sendJson(response, { ok: true })
    return
  }

  if (url.pathname === '/api/usage') {
    const anomalyPolicy = url.searchParams.get('anomalyPolicy') ?? undefined
    try {
      sendJson(response, await getUsageSummaryWithBackgroundScan({ anomalyPolicy }))
    } catch (error) {
      response.statusCode = 500
      sendJson(response, {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
    return
  }

  await serveStatic(url.pathname, response)
})

server.listen(port, host, () => {
  console.log(`Tokometer is running at http://${host}:${port}/`)
})

async function serveStatic(pathname: string, response: ServerResponse) {
  const requested = pathname === '/' ? '/index.html' : pathname
  const normalized = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(distDir, normalized)

  try {
    await stat(filePath)
  } catch {
    filePath = join(distDir, 'index.html')
  }

  const extension = extname(filePath)
  response.statusCode = 200
  response.setHeader('Content-Type', contentTypes.get(extension) ?? 'application/octet-stream')
  createReadStream(filePath).pipe(response)
}

function sendJson(response: ServerResponse, payload: unknown) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}
