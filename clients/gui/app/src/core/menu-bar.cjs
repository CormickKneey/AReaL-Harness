'use strict';
const { app, Tray, Menu, nativeImage } = require('electron');
const { join } = require('node:path');

// One GUI owns one native menu-bar item. Core execution and safe quit continue
// through their existing owners; restoring the window never creates a task.
class MenuBar {
  constructor(getWindow, stopAndQuit = () => {}) {
    this.getWindow = getWindow; this.tray = null; this.error = null;
    this.stopAndQuit = stopAndQuit;
    this.supported = process.platform === 'darwin'; this.closed = false;
  }
  sync(enabled) {
    if (!this.supported || this.closed) return;
    try {
      if (enabled && !this.tray) {
        const icon = nativeImage.createFromPath(join(__dirname, '../../assets/icon-1024.png')).resize({ width: 18, height: 18 });
        if (icon.isEmpty()) throw new Error('missing icon');
        const tray = new Tray(icon);
        try {
          tray.setToolTip('AReaL Harness');
          tray.setContextMenu(Menu.buildFromTemplate([
            { label: '打开 AReaL Harness', click: () => {
              const window = this.getWindow();
              if (!window || window.isDestroyed()) return;
              if (window.isMinimized()) window.restore();
              window.show(); window.focus();
            } },
            { type: 'separator' },
            { label: '退出界面，后台继续', click: () => app.quit() },
            { label: '停止后台并退出…', click: () => this.stopAndQuit() },
          ]));
          this.tray = tray;
        } catch (error) { tray.destroy(); throw error; }
      } else if (!enabled && this.tray) {
        this.tray.destroy(); this.tray = null;
      }
      this.error = null;
    } catch { this.error = '菜单栏入口未能更新，请重试或重新打开应用。'; }
  }
  snapshot() { return { supported: this.supported, active: !!this.tray && !this.tray.isDestroyed(), error: this.error }; }
  close() { this.sync(false); this.closed = true; }
}
module.exports = { MenuBar };
