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

        server.middlewares.use('/api/usage', async (_request, response) => {
          try {
            const payload = await getUsageSummary()
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
