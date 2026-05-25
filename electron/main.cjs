const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron')
const path = require('node:path')

const appUrl = process.env.TOKEN_GAUGE_URL || 'http://127.0.0.1:5173/'
let mainWindow
let tray

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: 'Tokometer',
    backgroundColor: '#0a0d11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadURL(appUrl)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'public', 'favicon.svg')
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

app.whenReady().then(() => {
  createWindow()
  createTray()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
