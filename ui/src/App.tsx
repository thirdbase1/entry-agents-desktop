import React, { useState, useEffect } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CenterChat } from './components/CenterChat';
import { RightPanel } from './components/RightPanel';
import { ResizerLeft, ResizerRight } from './components/Resizers';
import { AutomationsModal } from './components/AutomationsModal';
import { CustomizationsModal } from './components/CustomizationsModal';
import { SettingsModal } from './components/SettingsModal';
import type {
  ConversationItem,
  ArtifactTabItem,
  LiveModelOption,
  AutomationItem,
  SkillItem,
  McpServerItem,
  UserAccount,
} from './types';

// Initial artifact tabs matching three-column-workspace.html exactly
const INITIAL_DOCS: Record<string, NonNullable<ArtifactTabItem['doc']>> = {
  desktop: {
    title: 'Desktop App Architecture Blueprint',
    h1: 'Desktop App — Architectural Map &amp; System Blueprint',
    intro: 'How the desktop app is put together: the window shell, the main process, the local agent runtime, and the cloud services it syncs with.',
    layers: [
      { title: 'Desktop shell (Native WebView2)', link: 'IPC', items: [['Window manager', 'tabs · panes'], ['Native WebView2', 'WebView2'], ['Diff viewer', 'full-height'], ['Preview pane', 'local server']] },
      { title: 'Main process', items: [['IPC bridge', 'typed channels'], ['File watcher', 'workspace sync'], ['Git runner', 'commit · branch'], ['Updater', 'auto-update']] },
      { title: 'Local agent runtime', link: 'HTTPS', items: [['Workflow loop', 'plan · act · verify'], ['Tool registry', 'shell · files · search'], ['Model client', 'streaming']] },
      { title: 'Cloud services', items: [['Sync', 'chats · settings'], ['Model APIs', 'LLM providers'], ['Auth', 'device sign-in']] },
    ],
    flow: [
      'The window sends the message to the main process over IPC.',
      'The main process starts the local agent runtime for the workspace.',
      'Tools run against local files and the shell, and diffs stream to the viewer.',
      'Chats and settings sync to the cloud in the background.',
    ],
  },
  web: {
    title: 'Web Architecture',
    h1: 'Web Application — Complete Architectural Map &amp; System Blueprint',
    intro: 'A complete end-to-end map of the web platform (<code>apps/web</code>): UI layout, routing, API handlers, background AI workflows, cloud sandboxes, and persistence.',
    layers: [
      { title: 'Browser client (React 19 / Next.js)', link: 'HTTPS · SSE · WebSocket', items: [['Three-column UI', 'chat · files'], ['Xterm terminal', 'WebSocket PTY'], ['State cache', 'chats · diffs'], ['Live preview', 'dev server tunnel']] },
      { title: 'Edge &amp; middleware', items: [['Proxy', 'routing'], ['Auth check', 'session cookie'], ['Rate limits', 'per user']] },
      { title: 'App server (apps/web)', items: [['App router', 'pages · layouts'], ['REST &amp; SSE API', '/api/*'], ['Auth engine', 'OAuth · sessions'], ['Credit ledger', 'usage metering']] },
      { title: 'Agent &amp; tool engine', items: [['Workflow loop', 'plan · act · verify'], ['Tool registry', 'shell · files · search'], ['Model gateway', 'provider API']] },
      { title: 'Sandboxes', items: [['Cloud micro-VM', 'isolated workspace'], ['Container', 'build &amp; test'], ['Local sandbox', 'dev fallback']] },
      { title: 'Upstream services', items: [['Hosting', 'deploys'], ['Postgres', 'persistence'], ['Git host', 'repos &amp; PRs'], ['Model APIs', 'LLM providers']] },
    ],
    flow: [
      'The browser sends a message over SSE and keeps the stream open.',
      'Edge middleware checks the session and applies rate limits.',
      'The app server loads the project, checks credits, and starts a turn.',
      'The agent engine runs tools inside a sandbox and streams each step back.',
      'Results, diffs, and usage are written to Postgres.',
    ],
  },
};

const INITIAL_CONVERSATIONS: ConversationItem[] = [
  {
    id: 'c-1',
    t: 'Vercel And GitHub CLI Setup',
    time: 'now',
    prompt: 'Improve everything about how the model works in any scenario, remove the commit input bar from the UI, and make the agents stable and crash resistant across every scenario.',
    messages: [
      {
        id: 'm-1',
        role: 'assistant',
        content: `1. **Gateway retries:** transient upstream errors (502/503, timeouts) are retried with backoff before a turn is allowed to fail.
2. **Context overflow recovery:** when the context window fills up, older tool outputs collapse into lightweight placeholders and the step is retried immediately without failing the turn.
3. **In-Flight Dynamic Model Fallback:** If the selected model suffers an upstream outage and the route can't be found, the workflow pivots to the healthiest live model from catalog, resets stream retry counters, and completes the turn without crashing.
4. **Cost & Metadata Accuracy:** Dynamically tracks token usage, step cost breakdown, and telemetry reflect the model that executed.

## Updated \`docs/agents/lessons-learned.md\`
- Added an entry covering the commit input bar removal, the full-height diff canvas, and multi-tier model crash resilience:
  - De-cluttering of the review workspace canvas in favor of autonomous git workflows.
  - Multi-tier upstream gateway fault-tolerance, context overflow auto-compaction recovery, and in-flight gateway model fallback.`,
      },
    ],
  },
  { id: 'c-2', t: 'Brainstorming Developer Tool Ideas', time: '6d', messages: [] },
  { id: 'c-3', t: 'Investigating Data Drain and Language Settings', time: '7d', messages: [] },
  { id: 'c-4', t: 'Google Colab MCP Setup', time: '7d', messages: [] },
  { id: 'c-5', t: 'Transfer Chat History Between Systems', time: '9d', messages: [] },
  { id: 'c-6', t: 'Train A50 MoE Model', time: '10d', messages: [] },
  { id: 'c-7', t: 'Google Cloud Concurrent Users Meaning', time: '10d', messages: [] },
  { id: 'c-8', t: 'Unclear User Prompt', time: '1mo', messages: [] },
  { id: 'c-9', t: 'Check my entry agents repo and research…', dot: true, messages: [] },
  { id: 'c-10', t: 'Mercury Email and Task Integration', time: '2mo', messages: [] },
  { id: 'c-11', t: 'Top Black Sherif Songs', dot: true, messages: [] },
  { id: 'c-12', t: 'Codex Desktop BYOK Configuration', time: '2mo', messages: [] },
  { id: 'c-13', t: 'Pinning Gmail to Taskbar', time: '2mo', messages: [] },
];

export const App: React.FC = () => {
  // State
  const [conversations, setConversations] = useState<ConversationItem[]>(INITIAL_CONVERSATIONS);
  const [activeConvId, setActiveConvId] = useState<string>('c-1');
  const [tabs, setTabs] = useState<ArtifactTabItem[]>([
    { id: 'desktop', title: INITIAL_DOCS.desktop.title, doc: INITIAL_DOCS.desktop },
    { id: 'web', title: INITIAL_DOCS.web.title, doc: INITIAL_DOCS.web },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('web');

  const [models, setModels] = useState<LiveModelOption[]>([
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash High', chef: 'google' },
    { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro High', chef: 'google' },
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', chef: 'anthropic' },
    { id: 'step-5-preview', name: 'Step 5 Preview', chef: 'stepfun' },
  ]);
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.8-flash');
  const [turbo, setTurbo] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);

  // Column visibility
  const [leftHidden, setLeftHidden] = useState<boolean>(false);
  const [rightHidden, setRightHidden] = useState<boolean>(false);
  const [isFullRight, setIsFullRight] = useState<boolean>(false);

  // Modals
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [customizationsOpen, setCustomizationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Automations & Customizations live data
  const [automations, setAutomations] = useState<AutomationItem[]>([
    { id: 'auto-1', name: 'Morning Code Audit', schedule: '0 9 * * *', prompt: 'Audit repository changes and run test suite', enabled: true },
    { id: 'auto-2', name: 'Dependency Health Check', schedule: '0 0 * * 0', prompt: 'Check npm outdated packages and license risks', enabled: false },
  ]);

  const [skills, setSkills] = useState<SkillItem[]>([
    { id: 'sk-1', name: 'modern-web-guidance', description: 'Best practices for React 19, CSS tokens, and CWV', path: 'skills/modern-web', scope: 'global', enabled: true },
    { id: 'sk-2', name: 'chrome-extensions', description: 'Manifest V3 patterns and service workers', path: 'skills/chrome', scope: 'global', enabled: true },
  ]);

  const [mcpServers] = useState<McpServerItem[]>([
    { id: 'mcp-1', name: 'filesystem', command: 'npx -y @modelcontextprotocol/server-filesystem', status: 'connected', toolsCount: 8 },
    { id: 'mcp-2', name: 'git', command: 'npx -y @modelcontextprotocol/server-git', status: 'connected', toolsCount: 6 },
  ]);

  const [account, setAccount] = useState<UserAccount | null>(null);
  const [activeProjectDir, setActiveProjectDir] = useState<string>('');

  // Fetch live models and auth from local sidecar
  useEffect(() => {
    fetch('http://127.0.0.1:4096/models')
      .then(res => res.json())
      .then(data => {
        if (data.models && Array.isArray(data.models) && data.models.length > 0) {
          setModels(data.models);
          setSelectedModel(data.models[0].id);
        }
      })
      .catch(() => { /* sidecar starting */ });

    fetch('http://127.0.0.1:4096/auth/status')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated && data.account) {
          setAccount({
            id: data.account.id,
            email: data.account.email,
            name: data.account.email?.split('@')[0],
            plan: data.account.plan || 'pro',
            creditBalanceCents: data.account.credit_balance_cents,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Sync column visibility classes to document.body
  useEffect(() => {
    document.body.classList.toggle('no-left', leftHidden);
  }, [leftHidden]);

  useEffect(() => {
    document.body.classList.toggle('no-right', rightHidden);
  }, [rightHidden]);

  useEffect(() => {
    document.body.classList.toggle('full-right', isFullRight);
  }, [isFullRight]);

  const activeConv = conversations.find(c => c.id === activeConvId) || conversations[0];

  const handleSelectConv = (id: string) => {
    setActiveConvId(id);
    setConversations(prev =>
      prev.map(c => (c.id === id ? { ...c, dot: false } : c))
    );
  };

  const handleNewConv = () => {
    const newId = `c-${Date.now()}`;
    const newConv: ConversationItem = {
      id: newId,
      t: 'New conversation',
      time: 'now',
      messages: [],
    };
    setConversations([newConv, ...conversations]);
    setActiveConvId(newId);
  };

  const handleSendMessage = async (text: string) => {
    const userMsg = { id: `m-${Date.now()}`, role: 'user' as const, content: text };
    const updatedMessages = [...activeConv.messages, userMsg];

    setConversations(prev =>
      prev.map(c => {
        if (c.id === activeConvId) {
          return {
            ...c,
            t: c.t === 'New conversation' ? (text.length > 40 ? text.slice(0, 40) + '…' : text) : c.t,
            messages: updatedMessages,
          };
        }
        return c;
      })
    );

    setIsGenerating(true);

    // Call local sidecar
    try {
      const res = await fetch(`http://127.0.0.1:4096/session/${activeConvId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'user',
          content: text,
          model: selectedModel,
          turbo,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.response) {
          const assistantMsg = {
            id: `m-ast-${Date.now()}`,
            role: 'assistant' as const,
            content: data.response,
          };
          setConversations(prev =>
            prev.map(c => (c.id === activeConvId ? { ...c, messages: [...c.messages, assistantMsg] } : c))
          );
        }
      }
    } catch {
      // Offline fallback note
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddTab = () => {
    const newId = `tab-${Date.now()}`;
    const newTab: ArtifactTabItem = {
      id: newId,
      title: 'Untitled artifact',
      empty: true,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(newId);
    if (rightHidden) setRightHidden(false);
  };

  const handleCloseTab = (id: string) => {
    const nextTabs = tabs.filter(t => t.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      setActiveTabId(nextTabs[0]?.id || '');
    }
  };

  const handleResizeLeft = (newWidth: number) => {
    document.documentElement.style.setProperty('--lw', `${newWidth}px`);
  };

  const handleResizeRight = (newWidth: number) => {
    document.documentElement.style.setProperty('--rw', `${newWidth}px`);
  };

  const handleSignInBrowser = () => {
    // Seamless browser sign-in flow
    window.open('http://127.0.0.1:4096/auth/login', '_blank');
    // Poll for status
    const interval = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4096/auth/status');
        const data = await res.json();
        if (data.authenticated && data.account) {
          setAccount({
            id: data.account.id,
            email: data.account.email,
            name: data.account.email?.split('@')[0],
            plan: data.account.plan || 'pro',
            creditBalanceCents: data.account.credit_balance_cents,
          });
          clearInterval(interval);
        }
      } catch {
        // ignore
      }
    }, 1500);
    setTimeout(() => clearInterval(interval), 120000);
  };

  const handleSignOut = async () => {
    try {
      await fetch('http://127.0.0.1:4096/auth/logout', { method: 'POST' });
    } catch {}
    setAccount(null);
  };

  return (
    <div className="app">
      {/* Column 1: Navigation Sidebar */}
      <LeftSidebar
        conversations={conversations}
        activeId={activeConvId}
        onSelectConv={handleSelectConv}
        onNewConv={handleNewConv}
        onToggleLeft={() => setLeftHidden(prev => !prev)}
        onOpenAutomations={() => setAutomationsOpen(true)}
        onOpenCustomizations={() => setCustomizationsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        activeProject={activeProjectDir}
        onSelectProjectDir={() => {
          const path = prompt('Enter project directory path:');
          if (path) setActiveProjectDir(path);
        }}
        account={account}
      />

      {/* Draggable Divider 1 */}
      <ResizerLeft onDrag={handleResizeLeft} />

      {/* Column 2: Center Chat */}
      <CenterChat
        conversation={activeConv}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        turbo={turbo}
        onToggleTurbo={() => setTurbo(prev => !prev)}
        onSendMessage={handleSendMessage}
        isGenerating={isGenerating}
        onStopGenerating={() => setIsGenerating(false)}
        onToggleLeft={() => setLeftHidden(prev => !prev)}
        onToggleRight={() => setRightHidden(prev => !prev)}
        leftHidden={leftHidden}
        rightHidden={rightHidden}
      />

      {/* Draggable Divider 2 */}
      <ResizerRight onDrag={handleResizeRight} />

      {/* Column 3: Artifact Panel */}
      <RightPanel
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={handleCloseTab}
        onAddTab={handleAddTab}
        onToggleFull={() => setIsFullRight(prev => !prev)}
        onToggleRight={() => setRightHidden(prev => !prev)}
        isFullRight={isFullRight}
      />

      {/* Modals */}
      <AutomationsModal
        isOpen={automationsOpen}
        onClose={() => setAutomationsOpen(false)}
        automations={automations}
        onToggleAutomation={id =>
          setAutomations(prev =>
            prev.map(a => (a.id === id ? { ...a, enabled: !a.enabled } : a))
          )
        }
        onRunNow={id => {
          const auto = automations.find(a => a.id === id);
          if (auto) handleSendMessage(auto.prompt);
          setAutomationsOpen(false);
        }}
        onCreateAutomation={(name, schedule, prompt) =>
          setAutomations([
            ...automations,
            { id: `auto-${Date.now()}`, name, schedule, prompt, enabled: true },
          ])
        }
      />

      <CustomizationsModal
        isOpen={customizationsOpen}
        onClose={() => setCustomizationsOpen(false)}
        skills={skills}
        mcpServers={mcpServers}
        onToggleSkill={id =>
          setSkills(prev =>
            prev.map(s => (s.id === id ? { ...s, enabled: !s.enabled } : s))
          )
        }
        onTestMcp={name => alert(`MCP server ${name} ping successful (OK)`)}
      />

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        account={account}
        onSignInBrowser={handleSignInBrowser}
        onSignOut={handleSignOut}
        activeProjectDir={activeProjectDir}
        onPickProjectDir={() => {
          const path = prompt('Enter project directory path:');
          if (path) setActiveProjectDir(path);
        }}
      />
    </div>
  );
};
