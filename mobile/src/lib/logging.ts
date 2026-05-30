// Lightweight runtime logging so failures show up in the `expo start` / Metro
// terminal instead of vanishing. Tagged with [Sentinel] for easy filtering:
//   npx expo start --clear 2>&1 | grep Sentinel
//
// - log()  → breadcrumb you can sprinkle anywhere
// - installGlobalErrorLogging() → catches otherwise-uncaught JS errors so a
//   fatal logs a readable line before the app dies (RN's ErrorUtils).

const TAG = '[Sentinel]';

export function log(...args: unknown[]) {
  console.log(TAG, ...args);
}

export function warn(...args: unknown[]) {
  console.warn(TAG, ...args);
}

let installed = false;

export function installGlobalErrorLogging() {
  if (installed) return;
  installed = true;

  // RN exposes a global ErrorUtils with the current fatal handler. Chain ours
  // in front so we log, then defer to the default (red box in dev).
  const errorUtils = (global as any).ErrorUtils;
  if (errorUtils?.getGlobalHandler && errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
      console.error(`${TAG} ${isFatal ? 'FATAL' : 'error'}:`, error?.message ?? error, '\n', error?.stack ?? '');
      previous?.(error, isFatal);
    });
  }

  // Catch unhandled promise rejections too (silent failures otherwise).
  const tracking = (global as any).HermesInternal?.enablePromiseRejectionTracker;
  if (typeof tracking === 'function') {
    tracking({
      allRejections: true,
      onUnhandled: (id: number, rejection: any) => {
        console.warn(`${TAG} unhandled promise rejection:`, rejection?.message ?? rejection);
      },
    });
  }
}
