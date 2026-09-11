import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

/**
 * Removes the virtual sink the first design used to create. Kept so an existing installation can be
 * cleaned up after upgrading; refuses while the previous version of the app is still running.
 */
export const removeLegacyRouting = (
  statePath: string,
  log: (msg: string, ...rest: unknown[]) => void
): void => {
  const ownerPath = `${statePath}.pid`;
  if (existsSync(ownerPath)) {
    const pid = Number(readFileSync(ownerPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        log(`another instance (pid ${pid}) is still running; leaving its audio routing alone`);
        return;
      } catch {
        // the owner is gone, the file is debris
      }
    }
  }

  let unloaded = 0;
  try {
    const modules = execFileSync('pactl', ['list', 'modules'], { encoding: 'utf8' });
    for (const block of modules.split('Module #').slice(1)) {
      const [id] = block.split('\n');
      const isOurs =
        block.includes('sink_name=sharkord_capture') || block.includes('source=sharkord_capture.monitor');
      if (!isOurs) continue;
      try {
        execFileSync('pactl', ['unload-module', String(id).trim()], { stdio: 'ignore' });
        unloaded += 1;
      } catch (error) {
        log('could not unload module', id, error);
      }
    }
  } catch (error) {
    log('could not read the module list:', error);
  }

  for (const path of [statePath, ownerPath]) {
    try {
      unlinkSync(path);
    } catch {
      // nothing to remove
    }
  }

  log(unloaded > 0 ? `removed ${unloaded} leftover routing module(s)` : 'nothing to clean up');
};
