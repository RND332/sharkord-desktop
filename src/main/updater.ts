import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdaterHooks = {
  log: (...parts: unknown[]) => void;
  /** Called just before the app is restarted into the new version. */
  beforeInstall: () => void;
};

const githubFeed = (): { provider: 'github'; owner: 'RND332'; repo: 'sharkord-desktop' } => ({
  provider: 'github',
  owner: 'RND332',
  repo: 'sharkord-desktop'
});

/**
 * Updates come from the release page: NSIS on Windows and the AppImage on Linux both replace
 * themselves in place. Package-managed installs (deb/pacman) are updated by their package manager,
 * and electron-updater says so instead of failing silently.
 */
export const setupAutoUpdates = (hooks: UpdaterHooks): void => {
  if (!app.isPackaged) return;

  const { log } = hooks;
  // Point the updater somewhere else (a local server, a mirror) for testing or self-hosting.
  const feed = process.env.SHARKORD_UPDATE_FEED;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  else autoUpdater.setFeedURL(githubFeed());

  autoUpdater.logger = {
    info: (...parts: unknown[]) => log('updater:', ...parts),
    warn: (...parts: unknown[]) => log('updater:', ...parts),
    error: (...parts: unknown[]) => log('updater:', ...parts),
    debug: () => {}
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => log('checking for updates'));
  autoUpdater.on('update-not-available', () => log('no update available'));
  autoUpdater.on('error', (error: Error) => {
    log(`update check failed: ${error?.message ?? String(error)}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`update downloaded: ${info.version}`);
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Sharkord ${info.version} has been downloaded`,
        detail: 'Restart to switch to the new version. It will also be applied next time you quit.'
      });
      if (response !== 0) return;
      hooks.beforeInstall();
      autoUpdater.quitAndInstall();
    })();
  });

  void autoUpdater.checkForUpdates().catch((error: Error) => {
    log(`update check failed: ${error?.message ?? String(error)}`);
  });
};

/** Menu action: check on demand and say what happened. */
export const checkForUpdatesNow = async (log: (...parts: unknown[]) => void): Promise<void> => {
  if (!app.isPackaged) {
    log('update check skipped: this is a development build');
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version ?? 'unknown';
    if (latest === app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'No updates',
        message: `Sharkord ${app.getVersion()} is the latest version.`
      });
      return;
    }
    await dialog.showMessageBox({
      type: 'info',
      title: 'Update found',
      message: `Sharkord ${latest} is downloading`,
      detail: 'You will be asked to restart once it is ready.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`update check failed: ${message}`);
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Update check failed',
      message,
      detail:
        'Automatic updates work for the Windows installer and the Linux AppImage. Package-manager installs update through their package manager.'
    });
  }
};
