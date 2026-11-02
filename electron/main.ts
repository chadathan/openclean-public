import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { registerSystemIpc } from './ipc-handlers';
import { registerAppInventory } from './app-inventory';
import { registerJunkInventory } from './junk-inventory';
import { registerRemovals } from './removals';
import { registerDeveloperTools } from './developer-tools';
import { registerFileInventory } from './file-inventory';
import { registerAnalytics } from './analytics';

const isDev = !app.isPackaged;

// In a packaged build the name comes from productName; unpackaged it would be the npm package
// name, which the About and Hide menu items print verbatim.
app.setName('OpenClean');

// Kept off Angular's default 4200 so another project serving on it cannot be loaded here by
// mistake. `ng serve` reads the same number from angular.json; OPENCLEAN_DEV_PORT overrides both.
const devServerUrl = `http://localhost:${process.env['OPENCLEAN_DEV_PORT'] ?? 4310}`;

let mainWindow: BrowserWindow | null = null;
let menuBarWindow: BrowserWindow | null = null;
/** One reusable panel for whichever metric was clicked, rather than a window per metric. */
let detailWindow: BrowserWindow | null = null;
const DETAIL_METRICS = ['cpu', 'memory', 'battery', 'disks'] as const;
type DetailMetric = (typeof DETAIL_METRICS)[number];

let tray: Tray | null = null;
/** Set only by the explicit Quit commands and by logout/shutdown — every other quit request retreats to the menu bar. */
let quitForReal = false;

function quitOpenClean(): void {
  quitForReal = true;
  app.quit();
}

/**
 * The Dock's Quit and ⌘Q from the app switcher arrive as the same quit request as a real one, so
 * they are caught in `before-quit` and turned into "close the dashboard": the windows go, the
 * Dock icon goes with them, and the monitor carries on in the menu bar until the dashboard is
 * opened again.
 */
function retreatToMenuBar(): void {
  closeMenuBarWindows();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  app.dock?.hide();
}

/**
 * The tray is the app; the dashboard is a window it opens. ⌘Q therefore closes that window
 * and leaves the monitor running, and the command that really quits lives in the tray menu
 * where the agent does.
 *
 * ⌘Q is remapped in the menu, and the Dock's Quit is caught in `before-quit` (see
 * retreatToMenuBar). Logout and restart still quit: `powerMonitor`'s shutdown event lets them
 * through before macOS sends its own quit request.
 */
function buildApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Close Dashboard', accelerator: 'Command+Q', click: () => mainWindow?.close() },
        { label: 'Quit OpenClean', click: quitOpenClean }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]));
}

function notifyPopoverVisibility(visible: boolean): void {
  menuBarWindow?.webContents.send('menu-bar:visibility', visible);
  detailWindow?.webContents.send('menu-bar:visibility', visible);
}

function dismissPopoverAfterBlur(): void {
  // Electron may deliver `blur` before the newly focused window is known. Check on the next
  // turn so moving from the detail panel back into the main popover only dismisses the detail.
  setTimeout(() => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow === detailWindow) return;

    if (detailWindow?.isVisible()) {
      detailWindow.hide();
      detailWindow.webContents.send('menu-bar:visibility', false);
    }
    if (focusedWindow !== menuBarWindow) {
      closeMenuBarWindows();
    }
  }, 0);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f6fc',
    // Let Chromium throttle painting and animations while this window is occluded.
    // Disabling this kept the dashboard rendering behind the menu-bar popover and
    // detail panel, which needlessly kept Electron's GPU process busy.
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  if (isDev) window.loadURL(devServerUrl);
  else window.loadFile(join(__dirname, '../dist/openclean/browser/index.html'));
  // Without the dashboard OpenClean is a menu-bar app, and a Dock icon would only invite a Quit
  // that does not mean what it says.
  window.on('closed', () => { if (mainWindow === window) { mainWindow = null; app.dock?.hide(); } });
  mainWindow = window;
  return window;
}

function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M5 2.5h8a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 13V5A2.5 2.5 0 0 1 5 2.5Z" fill="#000"/><path d="m5.1 9.2 2.4 2.4 5.4-5.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  icon.setTemplateImage(true);
  return icon;
}

/**
 * Only in development, where the bundle is Electron's own and carries Electron's icon. A packaged
 * app already has build/openclean.icns, laid out on macOS's icon grid; overriding it with the raw
 * full-bleed artwork made the Dock icon larger than its neighbours and kept the glow round it.
 */
function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock || !isDev) return;
  const iconPath = join(__dirname, '../src/assets/brand/openclean-mark.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`Unable to load Dock icon: ${iconPath}`);
    return;
  }
  app.dock.setIcon(icon);
}

function positionMenuBarWindow(): void {
  if (!menuBarWindow || !tray) return;
  const bounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = display.workArea;
  const [width, height] = menuBarWindow.getSize();
  const x = Math.max(areaX + 8, Math.min(bounds.x + bounds.width - width, areaX + areaWidth - width - 8));
  const below = bounds.y + bounds.height + 8;
  const y = below + height <= areaY + areaHeight ? below : Math.max(areaY + 8, bounds.y - height - 8);
  menuBarWindow.setPosition(Math.round(x), Math.round(y), false);
}

function toggleMenuBarWindow(): void {
  if (menuBarWindow?.isVisible()) { closeMenuBarWindows(); return; }
  const window = !menuBarWindow || menuBarWindow.isDestroyed() ? createMenuBarWindow() : menuBarWindow;
  detailWindow?.hide();
  detailWindow?.webContents.send('menu-bar:visibility', false);
  positionMenuBarWindow();
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed() && tray) showMenuBarWindow(window);
    });
    return;
  }
  showMenuBarWindow(window);
}

function showMenuBarWindow(window: BrowserWindow): void {
  positionMenuBarWindow();
  window.show();
  notifyPopoverVisibility(true);
  window.focus();
}

function closeMenuBarWindows(): void {
  notifyPopoverVisibility(false);
  const detail = detailWindow;
  const popover = menuBarWindow;
  detailWindow = null;
  menuBarWindow = null;
  if (detail && !detail.isDestroyed()) detail.destroy();
  if (popover && !popover.isDestroyed()) popover.destroy();
}

function showMainWindow(): void {
  if (app.dock && !app.dock.isVisible()) void app.dock.show().then(setDockIcon);
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function positionDetailWindow(): void {
  if (!detailWindow || !menuBarWindow) return;
  const menuBounds = menuBarWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: menuBounds.x, y: menuBounds.y });
  const [width, height] = detailWindow.getSize();
  const x = Math.max(display.workArea.x + 8, menuBounds.x - width - 12);
  const y = Math.max(display.workArea.y + 8, Math.min(menuBounds.y, display.workArea.y + display.workArea.height - height - 8));
  detailWindow.setPosition(Math.round(x), Math.round(y), false);
}

function createDetailWindow(metric: DetailMetric): void {
  if (detailWindow && !detailWindow.isDestroyed()) return;
  detailWindow = new BrowserWindow({
    width: 420,
    // An opening guess only. The panel measures itself once it has laid out and reports the
    // height it actually needs, so the floor here has to stay under the shortest panel or the
    // window keeps slack the content never asked for.
    height: 470,
    minWidth: 420,
    maxWidth: 420,
    minHeight: 280,
    frame: false,
    transparent: true,
    resizable: true,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  detailWindow.on('closed', () => { detailWindow = null; });
  detailWindow.on('blur', dismissPopoverAfterBlur);
  if (isDev) detailWindow.loadURL(`${devServerUrl}/?menubar=1&detail=${metric}`);
  else detailWindow.loadFile(join(__dirname, '../dist/openclean/browser/index.html'), { search: `menubar=1&detail=${metric}` });
}

/**
 * The panel sizes the window rather than the window sizing the panel. Each metric shows a
 * different amount — a chart and five rows, or a ring and a disk list — and the renderer is
 * the only side that knows how tall that came out, so it measures itself and reports.
 *
 * Reading `document.body.scrollHeight` from here could only ever grow the window: the body is
 * stretched to the window's own height, so it never measures smaller than what it already is.
 */
function fitDetailWindow(contentHeight: number): void {
  if (!detailWindow || detailWindow.isDestroyed()) return;
  const [, currentHeight] = detailWindow.getSize();
  // The screen is the only real ceiling. A fixed one would silently clip a long list, and the
  // popover hides its scrollbar, so there would be nothing on screen to say more was there.
  const bounds = detailWindow.getBounds();
  const workArea = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const nextHeight = Math.min(workArea.height - 16, Math.max(280, Math.ceil(contentHeight)));
  // Exact, not within a pixel: the panel's height is rounded up before it is reported, and a
  // one-pixel tolerance here left that rounding as a sliver of scrollable overflow. Content
  // height does not depend on window height — the width is fixed — so this cannot oscillate.
  if (nextHeight === currentHeight) return;
  detailWindow.setSize(420, nextHeight, false);
  positionDetailWindow();
}

function closeDetailWindow(): void {
  const window = detailWindow;
  detailWindow = null;
  if (window && !window.isDestroyed()) {
    window.webContents.send('menu-bar:visibility', false);
    window.destroy();
  }
}

function openDetailWindow(metric: DetailMetric): void {
  // An open panel switches metric in place. Reloading with a new query string would blank the
  // window for a moment and throw away the 60 seconds of history the chart has collected.
  createDetailWindow(metric);
  detailWindow?.webContents.send('detail:metric', metric);
  positionDetailWindow();
  detailWindow?.showInactive();
  detailWindow?.webContents.send('menu-bar:visibility', true);
}

function createMenuBarAgent(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('OpenClean');
  tray.setTitle('OC');
  tray.on('click', toggleMenuBarWindow);
  // Not setContextMenu: on macOS that would replace the left click, which belongs to the panel.
  tray.on('right-click', () => tray?.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit OpenClean', click: quitOpenClean }
  ])));
}

function createMenuBarWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 380,
    height: 520,
    minWidth: 380,
    maxWidth: 380,
    minHeight: 520,
    maxHeight: 520,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  menuBarWindow = window;
  window.on('closed', () => { if (menuBarWindow === window) menuBarWindow = null; });
  window.on('blur', dismissPopoverAfterBlur);
  window.webContents.on('did-finish-load', () => notifyPopoverVisibility(false));
  if (isDev) void window.loadURL(`${devServerUrl}/?menubar=1`);
  else void window.loadFile(join(__dirname, '../dist/openclean/browser/index.html'), { search: 'menubar=1' });
  return window;
}

ipcMain.handle('window:show-main', () => { closeMenuBarWindows(); showMainWindow(); return { opened: true }; });
ipcMain.handle('window:hide-menu-bar', () => { closeMenuBarWindows(); return { hidden: true }; });
ipcMain.handle('window:is-menu-bar-visible', () => ({ visible: Boolean(menuBarWindow && !menuBarWindow.isDestroyed() && menuBarWindow.isVisible()) }));
ipcMain.handle('window:open-detail', (_event, metric: string) => {
  if (!DETAIL_METRICS.includes(metric as DetailMetric)) return { opened: false };
  openDetailWindow(metric as DetailMetric);
  return { opened: true };
});
ipcMain.handle('window:close-detail', () => { closeDetailWindow(); return { closed: true }; });
ipcMain.handle('window:fit-detail', (_event, height: unknown) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return { fitted: false };
  fitDetailWindow(height);
  return { fitted: true };
});

app.whenReady().then(async () => {
  setDockIcon();
  await registerSystemIpc(showMainWindow);
  registerAppInventory();
  registerJunkInventory();
  registerRemovals();
  registerDeveloperTools();
  registerFileInventory();
  await registerAnalytics();
  buildApplicationMenu();
  createWindow();
  createMenuBarAgent();
  // The tray stays resident while its renderer is created only when the popover is opened.
  app.on('activate', () => showMainWindow());
  // macOS posts this before it asks running apps to quit for a logout, restart or shutdown. Those
  // requests must succeed: an app that refuses one stops the logout with a complaint about itself.
  powerMonitor.on('shutdown', () => { quitForReal = true; });
});

app.on('before-quit', event => {
  if (!quitForReal && tray) { event.preventDefault(); retreatToMenuBar(); return; }
  tray?.destroy(); tray = null;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
