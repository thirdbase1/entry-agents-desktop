/**
 * Entry Desktop V1 — Comprehensive Settings & Customizations Service
 *
 * Combines:
 * 1. **Entry Web Settings** (`apps/web/app/settings/*` & `/api/settings/preferences`):
 *    - Profile & Account (`email`, `plan`, `creditBalanceCents`, `publicUsageEnabled`)
 *    - General Preferences (`theme`: `"dark"` | `"light"` | `"system"`, `defaultDiffMode`: `"unified"` | `"split"`,
 *      `autoCommitPush`, `autoCreatePr`, `guidedFrontendWorkflowEnabled`, `defaultPermissionMode`: `"ask"` | `"autoAccept"` | `"fullAccess"`,
 *      `alertsEnabled`, `alertSoundEnabled`)
 *    - Model Preferences (`defaultModelId`, `defaultSubagentModelId`, `enabledModelIds` shortlist)
 *    - Global Skills (`globalSkillRefs`: `Array<{ source: string; skillName: string }>`)
 *    - MCP Servers (`mcpServers`: `Array<{ id, name, transport: "http" | "sse" | "stdio", url, command?, headers?, enabled }>`)
 *    - Connections (GitHub & Google OAuth status + quick link to `https://entry-agents.dev/settings/connections`)
 * 2. **OpenCode Desktop Settings** (`packages/desktop` & `packages/core`):
 *    - `autoCompactContext`: Automatic context compaction when token usage nears model context window
 *    - `verificationGateEnabled`: Automatically run verification checks (`typecheck` / `test`) after file edits
 *    - `commandTimeoutSeconds`: Default shell execution timeout (10s - 600s, default 120s)
 *    - `maxOutputLines`: Tool output line cap (default 2,000)
 *    - `maxOutputKilobytes`: Tool output byte cap (default 50 KiB)
 *    - `shellPath`: Preferred shell executable override
 *    - `customInstructions`: Global custom system instructions appended to agent prompts
 */
import { randomUUID } from "node:crypto";
import { FALLBACK_ENTRY_BACKEND_URLS } from "../auth/device-auth";
import type { EntryDesktopDatabase } from "../database/database";

export interface GlobalSkillRef {
  source: string;
  skillName: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

export interface DesktopSettingsState {
  // Entry Web Settings
  theme: "dark" | "light" | "system";
  defaultSandboxType: "local" | "boxd";
  defaultDiffMode: "unified" | "split";
  defaultModelId: string | null;
  defaultSubagentModelId: string | null;
  enabledModelIds: string[];
  defaultPermissionMode: "ask" | "autoAccept" | "fullAccess";
  autoCommitPush: boolean;
  autoCreatePr: boolean;
  guidedFrontendWorkflowEnabled: boolean;
  alertsEnabled: boolean;
  alertSoundEnabled: boolean;
  publicUsageEnabled: boolean;
  globalSkillRefs: GlobalSkillRef[];
  mcpServers: McpServerConfig[];

  // OpenCode Desktop Settings
  autoCompactContext: boolean;
  verificationGateEnabled: boolean;
  commandTimeoutSeconds: number;
  maxOutputLines: number;
  maxOutputKilobytes: number;
  shellPath: string;
  customInstructions: string;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettingsState = {
  theme: "dark",
  defaultSandboxType: "local",
  defaultDiffMode: "unified",
  defaultModelId: null,
  defaultSubagentModelId: null,
  enabledModelIds: [],
  defaultPermissionMode: "ask",
  autoCommitPush: false,
  autoCreatePr: false,
  guidedFrontendWorkflowEnabled: false,
  alertsEnabled: true,
  alertSoundEnabled: true,
  publicUsageEnabled: false,
  globalSkillRefs: [],
  mcpServers: [],
  autoCompactContext: true,
  verificationGateEnabled: true,
  commandTimeoutSeconds: 120,
  maxOutputLines: 2000,
  maxOutputKilobytes: 50,
  shellPath: "",
  customInstructions: "",
};

const SETTINGS_KV_KEY = "entry_desktop_settings_v1";

export class EntrySettingsService {
  constructor(
    private readonly db: EntryDesktopDatabase,
    private readonly baseUrl: string,
  ) {}

  getSettings(): DesktopSettingsState {
    const stored = this.db.getKv<Partial<DesktopSettingsState>>(SETTINGS_KV_KEY);
    if (!stored) {
      return { ...DEFAULT_DESKTOP_SETTINGS };
    }
    return {
      ...DEFAULT_DESKTOP_SETTINGS,
      ...stored,
      enabledModelIds: Array.isArray(stored.enabledModelIds)
        ? stored.enabledModelIds
        : [],
      globalSkillRefs: Array.isArray(stored.globalSkillRefs)
        ? stored.globalSkillRefs
        : [],
      mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers : [],
    };
  }

  updateSettings(
    patch: Partial<DesktopSettingsState>,
    sessionToken?: string | null,
  ): DesktopSettingsState {
    const current = this.getSettings();
    const updated: DesktopSettingsState = {
      ...current,
      ...patch,
    };
    this.db.setKv(SETTINGS_KV_KEY, updated);

    // Best-effort background sync of shared web preferences to Entry cloud if authenticated
    if (sessionToken) {
      void this.syncToEntryWeb(patch, sessionToken).catch(() => undefined);
    }

    return updated;
  }

  addMcpServer(input: {
    name: string;
    transport?: "http" | "sse" | "stdio";
    url: string;
    headers?: Record<string, string>;
  }): McpServerConfig {
    const settings = this.getSettings();
    const server: McpServerConfig = {
      id: `mcp_${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      transport: input.transport ?? "http",
      url: input.url.trim(),
      headers: input.headers,
      enabled: true,
      createdAt: Date.now(),
    };
    this.updateSettings({
      mcpServers: [...settings.mcpServers, server],
    });
    return server;
  }

  toggleMcpServer(id: string, enabled: boolean): McpServerConfig | null {
    const settings = this.getSettings();
    let target: McpServerConfig | null = null;
    const next = settings.mcpServers.map((s) => {
      if (s.id === id) {
        target = { ...s, enabled };
        return target;
      }
      return s;
    });
    if (target) {
      this.updateSettings({ mcpServers: next });
    }
    return target;
  }

  removeMcpServer(id: string): boolean {
    const settings = this.getSettings();
    const next = settings.mcpServers.filter((s) => s.id !== id);
    if (next.length === settings.mcpServers.length) return false;
    this.updateSettings({ mcpServers: next });
    return true;
  }

  addGlobalSkill(source: string, skillName: string): GlobalSkillRef[] {
    const settings = this.getSettings();
    const cleanSource = source.trim();
    const cleanSkill = skillName.trim();
    if (!cleanSource || !cleanSkill) {
      throw new Error("Both repository source (owner/repo) and skillName are required");
    }
    const exists = settings.globalSkillRefs.some(
      (r) =>
        r.source.toLowerCase() === cleanSource.toLowerCase() &&
        r.skillName.toLowerCase() === cleanSkill.toLowerCase(),
    );
    if (!exists) {
      const next = [
        ...settings.globalSkillRefs,
        { source: cleanSource, skillName: cleanSkill },
      ];
      this.updateSettings({ globalSkillRefs: next });
      return next;
    }
    return settings.globalSkillRefs;
  }

  removeGlobalSkill(index: number): GlobalSkillRef[] {
    const settings = this.getSettings();
    const next = settings.globalSkillRefs.filter((_, idx) => idx !== index);
    this.updateSettings({ globalSkillRefs: next });
    return next;
  }

  private async syncToEntryWeb(
    patch: Partial<DesktopSettingsState>,
    sessionToken: string,
  ): Promise<void> {
    const webPayload: Record<string, unknown> = {};
    const webKeys = [
      "defaultModelId",
      "defaultSubagentModelId",
      "defaultDiffMode",
      "autoCommitPush",
      "autoCreatePr",
      "defaultPermissionMode",
      "alertsEnabled",
      "alertSoundEnabled",
      "publicUsageEnabled",
      "guidedFrontendWorkflowEnabled",
      "globalSkillRefs",
      "enabledModelIds",
    ] as const;

    for (const k of webKeys) {
      if (patch[k] !== undefined) {
        webPayload[k] = patch[k];
      }
    }

    if (Object.keys(webPayload).length === 0) return;

    const origins = new Set<string>([this.baseUrl.replace(/\/$/, "")]);
    for (const fb of FALLBACK_ENTRY_BACKEND_URLS) {
      origins.add(fb);
    }

    for (const origin of origins) {
      try {
        const res = await fetch(`${origin}/api/settings/preferences`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(webPayload),
        });
        if (res.ok) return;
      } catch {
        // ignore
      }
    }
  }
}
