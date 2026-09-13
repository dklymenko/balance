interface WindowState {
  isDestroyed(): boolean;
}

// A closing auxiliary window (such as the App Lock dialog) may still appear
// in BrowserWindow.getAllWindows() for a short time after successful unlock.
// Restoration must depend on the main window itself, not the global count.
export function shouldRestoreMainWindow(mainWindow: WindowState | null): boolean {
  return !mainWindow || mainWindow.isDestroyed();
}
