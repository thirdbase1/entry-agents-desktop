
export interface DiagramLayer {
  title: string;
  link?: string;
  items: [string, string][];
}

export interface DiagramDoc {
  title: string;
  h1: string;
  intro: string;
  layers: DiagramLayer[];
  flow: string[];
}

export interface ArtifactTabItem {
  id: string;
  title: string;
  empty?: boolean;
  doc?: DiagramDoc;
  isDiff?: boolean;
  diffFiles?: DiffFile[];
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  lines: { type: 'add' | 'del' | 'ctx'; numOld?: number; numNew?: number; content: string }[];
}

export interface ToolExecution {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  output?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools?: ToolExecution[];
  timestamp?: number;
}

export interface ConversationItem {
  id: string;
  t: string;
  time?: string;
  dot?: boolean;
  messages: ChatMessage[];
  prompt?: string;
}

export interface LiveModelOption {
  id: string;
  name: string;
  chef?: string;
  contextWindow?: number;
}

export interface AutomationItem {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'workspace';
  enabled: boolean;
}

export interface McpServerItem {
  id: string;
  name: string;
  command?: string;
  url?: string;
  status: 'connected' | 'idle' | 'error';
  toolsCount: number;
}

export interface UserAccount {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  plan?: string;
  creditBalanceCents?: number;
}
