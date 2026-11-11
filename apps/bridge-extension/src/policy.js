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
