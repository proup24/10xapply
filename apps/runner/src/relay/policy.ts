// CDP methods the relay refuses no matter who asks: cookie, storage and
// browser-level access, and page-script hooks. The bridge extension refuses
// the same list (apps/bridge-extension/src/policy.js); policy.spec.ts keeps
// the two in step.
export const REFUSED_METHODS: readonly string[] = Object.freeze([
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
export function isRefused(method: string, params?: unknown): boolean {
  if (method === 'Page.addScriptToEvaluateOnNewDocument') {
    return !(
      typeof params === 'object' &&
      params !== null &&
      (params as { source?: unknown }).source === ''
    );
  }
  return REFUSED_METHODS.includes(method);
}
