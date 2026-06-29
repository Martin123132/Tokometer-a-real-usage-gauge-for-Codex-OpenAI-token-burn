const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron')
const { createReadStream } = require('node:fs')
const { stat } = require('node:fs/promises')
const { createServer } = require('node:http')
const path = require('node:path')

const externalAppUrl = process.env.TOKEN_GAUGE_URL
let mainWindow
let tray
let localServer

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
])

async function createWindow() {
  const appUrl = externalAppUrl || await startBundledServer()

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: 'Tokometer',
    backgroundColor: '#0a0d11',
    icon: runtimeIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  await mainWindow.loadURL(appUrl)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createTray() {
  try {
    const iconPath = runtimeIconPath()
    const image = nativeImage.createFromPath(iconPath)
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip('Tokometer')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Tokometer', click: () => mainWindow?.show() },
        { label: 'Reload', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
  } catch {
    tray = undefined
  }
}

function runtimeIconPath() {
  return path.join(__dirname, '..', 'public', 'icon.png')
}

async function startBundledServer() {
  if (localServer) {
    const address = localServer.address()
    if (address && typeof address !== 'string') {
      return `http://127.0.0.1:${address.port}/`
    }
  }

  const distDir = path.join(__dirname, '..', 'dist')
  const { getUsageSummaryWithBackgroundScan } = require(path.join(__dirname, '..', 'dist-server', 'usage.cjs'))

  localServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host}`)

    if (requestUrl.pathname === '/api/health') {
      sendJson(response, { ok: true })
      return
    }

    if (requestUrl.pathname === '/api/usage') {
      const anomalyPolicy = requestUrl.searchParams.get('anomalyPolicy') || undefined
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

    await serveStatic(distDir, requestUrl.pathname, response)
  })

  return new Promise((resolve) => {
    localServer.listen(0, '127.0.0.1', () => {
      const address = localServer.address()
      const port = address && typeof address !== 'string' ? address.port : 0
      resolve(`http://127.0.0.1:${port}/`)
    })
  })
}

async function serveStatic(distDir, pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '')
  let filePath = path.join(distDir, normalized)

  try {
    await stat(filePath)
  } catch {
    filePath = path.join(distDir, 'index.html')
  }

  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
  )
  createReadStream(filePath).pipe(response)
}

function sendJson(response, payload) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

app.whenReady().then(async () => {
  await createWindow()
  createTray()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  }
})

app.on('before-quit', () => {
  localServer?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
