// The relay's model of the run windows, ported from Playwright's BrowserModel
// and ExtensionProtocolV2 (playwright-core 1.65.0, src/tools/mcp/
// browserModel.ts and cdpRelayV2.ts). chrome.* calls are mapped onto the
// bridge's wire protocol: chrome.tabs.create -> run.createWindow,
// chrome.tabs.remove -> tabs.remove, chrome.debugger.attach ->
// debugger.attach, chrome.debugger.sendCommand -> debugger.send.
//
// Unlike Playwright's model there are no pre-existing tabs: the extension owns
// only the windows created here, so root Target.setAutoAttach attaches nothing.

export type Json = Record<string, unknown>;

export type CallExtension = (method: string, params: Json) => Promise<unknown>;
export type SendToCdp = (message: Json) => void;

interface Tab {
  tabId: number;
  attached: boolean;
  sessionId?: string; // set once announced to the CDP client
  targetInfo?: Json;
  childSessions: Set<string>; // auto-attached iframes and workers
}

export class BrowserModel {
  private readonly tabs = new Map<number, Tab>();
  private nextSessionId = 1;

  constructor(
    private readonly callExtension: CallExtension,
    private readonly sendToCdp: SendToCdp,
  ) {}

  // ─── CDP client → model ────────────────────────────────────────────────

  /** Handles a non-refused CDP command; Browser.* locals are the relay's. */
  async handleCommand(
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const p = (params ?? {}) as Json;
    if (sessionId === undefined) {
      switch (method) {
        case 'Target.setAutoAttach':
          return {};
        case 'Target.createTarget':
          return this.createTarget(p.url);
        case 'Target.closeTarget':
          return this.closeTarget(p.targetId);
      }
      // Browser-scoped commands go through any attached tab, as Playwright
      // does; with none attached they are answered with {}.
      const tab = [...this.tabs.values()].find(
        (t) => t.attached && t.sessionId,
      );
      if (!tab) return {};
      return this.debuggerSend({ tabId: tab.tabId }, method, params);
    }

    for (const tab of this.tabs.values()) {
      if (!tab.attached) continue;
      if (tab.sessionId === sessionId) {
        return this.debuggerSend({ tabId: tab.tabId }, method, params);
      }
      if (tab.childSessions.has(sessionId)) {
        return this.debuggerSend(
          { tabId: tab.tabId, sessionId },
          method,
          params,
        );
      }
    }
    throw new Error('No target for this session');
  }

  // ─── Extension → model ─────────────────────────────────────────────────

  onDebuggerEvent(
    source: { tabId?: unknown; sessionId?: unknown },
    method: unknown,
    params: unknown,
  ): void {
    const tab =
      typeof source.tabId === 'number'
        ? this.tabs.get(source.tabId)
        : undefined;
    if (!tab?.attached || !tab.sessionId) return;
    const child = (params as Json | undefined)?.sessionId;
    if (typeof child === 'string') {
      if (method === 'Target.attachedToTarget') tab.childSessions.add(child);
      else if (method === 'Target.detachedFromTarget')
        tab.childSessions.delete(child);
    }
    const sessionId =
      typeof source.sessionId === 'string' ? source.sessionId : tab.sessionId;
    this.sendToCdp({ sessionId, method, params });
  }

  /** The tab stays known after a detach so Target.closeTarget can still close it. */
  onDebuggerDetach(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (tab) this.detachSession(tab);
  }

  onTabRemoved(tabId: number): void {
    this.onDebuggerDetach(tabId);
    this.tabs.delete(tabId);
  }

  /** Drops every session, telling the CDP client (if still there). */
  reset(): void {
    for (const tab of this.tabs.values()) this.detachSession(tab);
    this.tabs.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private debuggerSend(
    target: { tabId: number; sessionId?: string },
    method: string,
    params: unknown,
  ): Promise<unknown> {
    return this.callExtension('debugger.send', {
      target,
      method,
      params: params ?? {},
    });
  }

  // Target.createTarget becomes run.createWindow, then debugger.attach.
  private async createTarget(url: unknown): Promise<Json> {
    const created = (await this.callExtension('run.createWindow', {
      url: typeof url === 'string' ? url : 'about:blank',
    })) as { tabId?: unknown } | undefined;
    const tabId = created?.tabId;
    if (typeof tabId !== 'number') throw new Error('Failed to create window');
    const tab: Tab = { tabId, attached: false, childSessions: new Set() };
    this.tabs.set(tabId, tab);
    try {
      await this.callExtension('debugger.attach', { tabId });
      tab.attached = true;
      const info = (await this.debuggerSend(
        { tabId },
        'Target.getTargetInfo',
        {},
      )) as { targetInfo?: Json } | undefined;
      if (!tab.attached || this.tabs.get(tabId) !== tab)
        throw new Error('debugger detached');
      const targetInfo = info?.targetInfo ?? {};
      tab.targetInfo = targetInfo;
      tab.sessionId = `bridge-tab-${this.nextSessionId++}`;
      this.sendToCdp({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: tab.sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      });
      return { targetId: targetInfo.targetId };
    } catch (e) {
      // Don't leave a half-made run window behind. tabs.remove works on any
      // tab the extension created, even after a detach.
      tab.attached = false;
      this.tabs.delete(tabId);
      await this.callExtension('tabs.remove', { tabId }).catch(() => undefined);
      throw e;
    }
  }

  // Target.closeTarget becomes tabs.remove. Detached tabs stay closable.
  private async closeTarget(targetId: unknown): Promise<Json> {
    const tab = [...this.tabs.values()].find(
      (t) => targetId !== undefined && t.targetInfo?.targetId === targetId,
    );
    if (!tab) return { success: false };
    await this.callExtension('tabs.remove', { tabId: tab.tabId });
    return { success: true };
  }

  private detachSession(tab: Tab): void {
    const wasAnnounced = tab.attached && tab.sessionId !== undefined;
    tab.attached = false;
    tab.childSessions.clear();
    if (!wasAnnounced) return;
    this.sendToCdp({
      method: 'Target.detachedFromTarget',
      params: { sessionId: tab.sessionId, targetId: tab.targetInfo?.targetId },
    });
  }
}
