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

export function isRefused(method) {
  return REFUSED_METHODS.includes(method);
}
