import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getUsageSummary } from './server/usage'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'codex-token-usage-api',
      configureServer(server) {
        server.middlewares.use('/api/health', (_request, response) => {
          response.statusCode = 200
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ ok: true }))
        })

        server.middlewares.use('/api/usage', async (request, response) => {
          const anomalyPolicy = request.url
            ? new URL(request.url, 'http://localhost').searchParams.get('anomalyPolicy') ??
              undefined
            : undefined
          try {
            const payload = await getUsageSummary({ anomalyPolicy })
            response.statusCode = 200
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(payload))
          } catch (error) {
            response.statusCode = 500
            response.setHeader('Content-Type', 'application/json')
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error ? error.message : 'Unknown error',
              }),
            )
          }
        })
      },
    },
  ],
})
