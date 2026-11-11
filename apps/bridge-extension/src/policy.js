// CDP methods the bridge refuses no matter who asks. Cookie, storage and
// browser-level access stays out of reach of the relay.
export const REFUSED_METHODS = Object.freeze([
  'Network.getCookies',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Storage.clearDataForOrigin',
  'DOMStorage.getDOMStorageItems',
  'DOMStorage.enable', // its events carry storage values
  'IndexedDB.requestData',
  'CacheStorage.requestCachedResponse',
  'Page.getCookies',
  'Browser.close',
  'Browser.crash',
  'Target.exposeDevToolsProtocol',
  'Runtime.addBinding',
  'Page.addScriptToEvaluateOnNewDocument',
]);

// Page.addScriptToEvaluateOnNewDocument is refused unless its source is
// exactly '': Patchright creates its utility world that way on every page
// (FrameSession._initialize), and an empty script runs nothing in the page.
/** Whether the bridge refuses this CDP command. */
export function isRefused(method, params) {
  if (method === 'Page.addScriptToEvaluateOnNewDocument') {
    return !(
      typeof params === 'object' &&
      params !== null &&
      params.source === ''
    );
  }
  return REFUSED_METHODS.includes(method);
}

// The only Target.* methods a tab or child session may send. They are the
// ones Patchright 1.64.3 sends on page and child sessions (setAutoAttach,
// detachFromTarget) plus the relay's own getTargetInfo on a new tab. Any
// other (attachToTarget, createTarget, getTargets, ...) could reach beyond
// the run tab, so it is refused here, not left to Chrome.
export const SESSION_TARGET_METHODS = Object.freeze([
  'Target.setAutoAttach',
  'Target.detachFromTarget',
  'Target.getTargetInfo',
]);

/** Whether the bridge refuses this CDP command on a tab or child session. */
export function isRefusedOnSession(method, params) {
  if (isRefused(method, params)) return true;
  return (
    method.startsWith('Target.') && !SESSION_TARGET_METHODS.includes(method)
  );
}
