import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';

/**
 * The main process owns the screen capture and the audio service, so its crashes are the ones that
 * end a share without anyone noticing. Nothing here may keep the app from starting.
 */
export const initSentry = (dsn: string | null): void => {
  if (!dsn) return;

  try {
    Sentry.init({
      dsn,
      environment: app.isPackaged ? 'production' : 'development',
      release: app.getVersion(),
      tracesSampleRate: 0,
      beforeSend: (event) => ({
        ...event,
        request: undefined,
        contexts: undefined,
        extra: undefined
      })
    });
  } catch (error) {
    console.error('[sharkord-desktop] sentry init failed:', error);
  }
};

export const captureError = (
  error: unknown,
  tags?: Record<string, string>
): void => {
  if (!Sentry.getClient()) return;

  try {
    Sentry.captureException(error, tags ? { tags } : undefined);
  } catch {
    // Reporting must never break the caller.
  }
};
