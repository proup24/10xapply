// Real patchright-core 1.64.3 against the real relay and the real extension
// core (apps/bridge-extension/src/bridge-core.js). Only chrome.* is faked:
// it answers the CDP commands Patchright sends for a new about:blank page.
// This is the evidence that the stop events and the Target allowlist leave
// Patchright's connect, newPage, page.close and browser.close working.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'patchright-core';
import { WebSocket } from 'ws';
import { startRelay, type BridgeEvent, type Relay } from '../relay/relay.js';

const TOKEN = 'test-token-0123456789abcdef';
const TAB = 42;
const WINDOW = 7;
const TARGET = 'T-42';

type Json = Record<string, unknown>;

interface BridgeCore {
  handleCommand(msg: unknown): Promise<void>;
  onDebuggerDetach(source: { tabId: number }, reason: string): void;
  onTabRemoved(tabId: number): void;
}

const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');

async function loadCore(): Promise<
  (chromeApi: unknown, send: (m: Json) => void) => BridgeCore
> {
  const mod = (await import(
    pathToFileURL(
      path.join(workspaceRoot, 'apps/bridge-extension/src/bridge-core.js'),
    ).href
  )) as {
    createBridgeCore: (
      chromeApi: unknown,
      send: (m: Json) => void,
    ) => BridgeCore;
  };
  return mod.createBridgeCore;
}

/** What Chrome answers for an about:blank tab; everything else is {}. */
function answer(method: string): unknown {
  switch (method) {
    case 'Target.getTargetInfo':
      return {
        targetInfo: {
          targetId: TARGET,
          type: 'page',
          title: '',
          url: 'about:blank',
          attached: true,
          canAccessOpener: false,
          browserContextId: 'CTX-1',
        },
      };
    case 'Page.getFrameTree':
      return {
        frameTree: {
          frame: {
            id: TARGET,
            loaderId: 'L-1',
            url: 'about:blank',
            domainAndRegistry: '',
            securityOrigin: '://',
            mimeType: 'text/html',
            secureContextType: 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
      };
    case 'Page.addScriptToEvaluateOnNewDocument':
      return { identifier: '1' };
    // Patchright looks for its own leftover init-script tags after the
    // initial navigation; there are none.
    case 'DOM.getDocument':
      return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9 } };
    case 'DOM.querySelectorAll':
      return { nodeIds: [] };
    default:
      return {};
  }
}

describe('patchright-core through the relay and the extension core', () => {
  let relay: Relay | undefined;
  let extWs: WebSocket | undefined;
  afterEach(async () => {
    extWs?.terminate();
    await relay?.stop();
  });

  it('connects, opens a page, closes it and disconnects', async () => {
    relay = await startRelay({ port: 0, token: TOKEN });
    const events: BridgeEvent[] = [];
    relay.onEvent((e) => events.push(e));

    const port = new URL(relay.cdpUrl).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`);
    extWs = ws;
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });

    const forwarded: string[] = []; // CDP methods that reached chrome.debugger
    const replies: Json[] = []; // every reply the extension core sent
    const createBridgeCore = await loadCore();
    const core = createBridgeCore(
      {
        windows: {
          create: async () => ({ id: WINDOW, tabs: [{ id: TAB }] }),
        },
        tabs: {
          // As Chrome does: the removal is reported after the call returns.
          remove: async (tabId: number) => {
            setTimeout(() => core.onTabRemoved(tabId), 5);
          },
        },
        debugger: {
          attach: async () => undefined,
          sendCommand: async (_target: unknown, method: string) => {
            forwarded.push(method);
            return answer(method);
          },
        },
      },
      (m) => {
        if (m.id !== undefined) replies.push(m);
        ws.send(JSON.stringify(m));
      },
    );
    ws.on('message', (data) => {
      void core.handleCommand(JSON.parse(data.toString()) as unknown);
    });
    expect(await relay.waitForExtension(1000)).toBe(true);

    const browser = await chromium.connectOverCDP(relay.cdpUrl, {
      timeout: 10_000,
    });
    const context = browser.contexts()[0];
    expect(context).toBeDefined();
    const page = await context.newPage();
    expect(page.url()).toBe('about:blank');
    // Our own close is not a stop.
    await page.close();
    await browser.close();

    const refused = replies.filter(
      (r) => typeof r.error === 'string' && r.error.startsWith('refused:'),
    );
    expect(refused).toEqual([]);
    expect(forwarded).toContain('Page.getFrameTree');
    expect(forwarded).toContain('Target.setAutoAttach');
    expect(
      forwarded.filter(
        (m) =>
          m.startsWith('Target.') &&
          ![
            'Target.setAutoAttach',
            'Target.detachFromTarget',
            'Target.getTargetInfo',
          ].includes(m),
      ),
    ).toEqual([]);
    expect(events).toEqual([]);
  }, 20_000);
});
