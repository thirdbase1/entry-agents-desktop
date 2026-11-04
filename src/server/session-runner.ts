/**
 * Entry Desktop V1 — Session Runner & Multi-Round Tool-Calling Loop
 *
 * Implements Section 4 (Real Model Tool Calling) & Section 8 (Parent Agent & Subagents):
 * 1. User sends a message.
 * 2. Entry sends the request (with OpenAI-compatible `tools` JSON schemas) to the selected model
 *    via Entry's model gateway (`/v1/chat/completions` / `/api/desktop/chat`).
 * 3. Model streams text deltas or one or more tool calls (`delta.tool_calls`).
 * 4. Entry identifies each requested tool (`tool_requested`).
 * 5. Entry validates the tool arguments.
 * 6. Entry checks permissions (`allow` | `ask` | `deny`), transitions to `waiting_permission`
 *    when user approval is required, and blocks until the user approves or denies.
 * 7. Entry transitions to `tool_executing` and executes the tool against the user's real local files.
 * 8. Entry collects the bounded result and transitions to `tool_completed` or `tool_failed`.
 * 9. Entry appends `role: "tool"` messages and sends the results back to the model.
 * 10. Model continues working across multiple rounds until completion (`final_response`) or cancellation.
 *
 * Strictly ZERO simulated tool execution or canned demo responses.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AGENTS, buildPlanModeReminder, type AgentInfo } from "../agent/agents";
import type { EntryDeviceAuthService } from "../auth/device-auth";
import { FALLBACK_ENTRY_BACKEND_URLS } from "../auth/device-auth";
import type { EntryDesktopDatabase, SessionRow } from "../database/database";
import { LocalExecutionManager } from "../execution/local-env";
import {
  evaluatePermission,
  type PermissionAction,
  type PermissionRule,
} from "../permission/permission";
import type { PluginRegistry } from "../plugin/hooks";
import type { EntrySettingsService } from "../settings/settings";
import {
  executeDesktopTool,
  getOpenAIToolDefinitions,
  type OpenAIToolSchema,
} from "../tools/toolset";

export type ToolLifecycleState =
  | "thinking"
  | "tool_requested"
  | "waiting_permission"
  | "tool_executing"
  | "tool_completed"
  | "tool_failed"
  | "final_response";

export interface SidecarEvent {
  type:
    | "server.connected"
    | "session.created"
    | "session.updated"
    | "session.status"
    | "message.created"
    | "message.part.delta"
    | "message.part.updated"
    | "permission.asked"
    | "permission.replied"
    | "artifact.updated"
    | "verification.completed";
  properties: Record<string, unknown>;
}

export interface PendingPermission {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  permission: string;
  target: string;
  input: unknown;
  createdAt: number;
  resolve: (decision: {
    approved: boolean;
    scope?: "once" | "session";
    reason?: string;
  }) => void;
}

interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionMessageParam {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  name?: string;
}

const MAX_TOOL_ROUNDS = 25;

export class EntrySessionRunner {
  readonly executionManager = new LocalExecutionManager();
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sessionPermissionMemory = new Map<
    string,
    PermissionRule[]
  >();
  private readonly subscribers = new Set<(event: SidecarEvent) => void>();

  constructor(
    private readonly db: EntryDesktopDatabase,
    private readonly plugins: PluginRegistry,
    private readonly entryBaseUrl: string,
    private readonly authService?: EntryDeviceAuthService,
    private readonly settingsService?: EntrySettingsService,
  ) {}

  subscribe(listener: (event: SidecarEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  emit(event: SidecarEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  listPendingPermissions(
    sessionId?: string,
  ): Array<Omit<PendingPermission, "resolve">> {
    const all = Array.from(this.pendingPermissions.values());
    return all
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .map(({ resolve: _r, ...rest }) => rest);
  }

  /**
   * Adds a custom permission rule to the session (used in tests or session-level approvals).
   */
  addSessionPermissionRule(sessionId: string, rule: PermissionRule): void {
    const existing = this.sessionPermissionMemory.get(sessionId) ?? [];
    existing.push(rule);
    this.sessionPermissionMemory.set(sessionId, existing);
  }

  replyPermission(
    id: string,
    decision: {
      approved: boolean;
      scope?: "once" | "session";
      reason?: string;
    },
  ): boolean {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    this.pendingPermissions.delete(id);

    if (decision.approved && decision.scope === "session") {
      this.addSessionPermissionRule(pending.sessionId, {
        permission: pending.permission,
        pattern: pending.target,
        action: "allow",
      });
    }

    pending.resolve(decision);
    this.emit({
      type: "permission.replied",
      properties: {
        id,
        sessionId: pending.sessionId,
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        ...decision,
      },
    });
    return true;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const controller = this.activeAborts.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAborts.delete(sessionId);
    }

    // Reject any pending permissions for this session immediately
    for (const [id, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        pending.resolve({
          approved: false,
          reason: "Cancelled by user",
        });
      }
    }

    // Kill all running OS processes for this session
    await this.executionManager.cancelSessionProcesses(sessionId);

    this.emit({
      type: "session.status",
      properties: {
        sessionId,
        status: "idle",
        lifecycleState: "final_response",
        stopped: true,
      },
    });
    return Boolean(controller);
  }

  getWorkspaceDiff(directory: string): {
    diff: string;
    files: number;
    additions: number;
    deletions: number;
  } {
    try {
      const diff = execSync("git diff HEAD", {
        cwd: directory,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let files = 0;
      let additions = 0;
      let deletions = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) files++;
        else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
      return { diff, files, additions, deletions };
    } catch {
      return { diff: "", files: 0, additions: 0, deletions: 0 };
    }
  }

  /**
   * Executes a user prompt turn with full multi-round model tool calling.
   */
  async runPrompt(input: {
    sessionId: string;
    text: string;
    agent?: "build" | "plan" | "explore" | "general";
    modelId?: string;
    turbo?: boolean;
  }): Promise<{
    userMessageId: string;
    assistantMessageId: string;
    assistantText: string;
    verified: boolean;
    verificationSummary: string | null;
  }> {
    const session = this.db.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} not found`);
    }

    const sessionToken =
      this.authService?.getActiveAccessToken() ??
      this.db.getActiveAccount()?.access_token ??
      process.env.ENTRY_SESSION_TOKEN ??
      "";

    if (!sessionToken) {
      throw new Error(
        "Authentication required. Please sign in to your Entry account before sending a message.",
      );
    }

    const agentMode = input.agent ?? session.agent ?? "build";
    const agentDef: AgentInfo = AGENTS[agentMode] ?? AGENTS.build;
    const modelId = (input.modelId ?? session.model_id ?? "").trim();
    if (!modelId) {
      throw new Error(
        "No AI model selected. Please select an available model from the model selector.",
      );
    }

    if (agentMode !== session.agent || modelId !== session.model_id) {
      this.db.updateSession(session.id, {
        agent: agentMode,
        model_id: modelId,
      });
    }

    // 1. Persist user message
    const userMessageId = `msg_${randomUUID()}`;
    this.db.insertMessage({
      id: userMessageId,
      session_id: session.id,
      role: "user",
      agent: agentMode,
      model_id: modelId,
      data: { text: input.text },
    });
    this.db.insertPart({
      id: `part_${randomUUID()}`,
      message_id: userMessageId,
      session_id: session.id,
      part_type: "text",
      data: { type: "text", text: input.text },
    });

    // Auto-title new conversations from the first user prompt
    if (
      session.title === "New Conversation" ||
      session.title === "New conversation" ||
      session.title === "Desktop chat"
    ) {
      const cleanTitle = input.text.replace(/\s+/g, " ").trim().slice(0, 64);
      if (cleanTitle) {
        this.db.updateSession(session.id, { title: cleanTitle });
      }
    }

    // 2. Create assistant message placeholder
    const assistantMessageId = `msg_${randomUUID()}`;
    const textPartId = `part_${randomUUID()}`;
    this.db.insertMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: "assistant",
      agent: agentMode,
      model_id: modelId,
      data: {
        status: "streaming",
        lifecycleState: "thinking" satisfies ToolLifecycleState,
      },
    });

    const abort = new AbortController();
    this.activeAborts.set(session.id, abort);

    this.updateLifecycleState(
      session.id,
      assistantMessageId,
      "thinking",
      agentMode,
    );

    let assistantText = "";
    let hadFileEdits = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      // Build conversation history for the model
      const conversationMessages = this.buildConversationHistory(
        session,
        agentDef,
        userMessageId,
        input.text,
      );

      const toolsSchema = getOpenAIToolDefinitions();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (abort.signal.aborted) {
          throw new Error("Execution cancelled by user");
        }

        this.updateLifecycleState(
          session.id,
          assistantMessageId,
          "thinking",
          agentMode,
        );

        const stepResult = await this.streamGatewayRound({
          sessionToken,
          modelId,
          messages: conversationMessages,
          tools: toolsSchema,
          signal: abort.signal,
          onTextDelta: (delta) => {
            assistantText += delta;
            this.db.insertPart({
              id: textPartId,
              message_id: assistantMessageId,
              session_id: session.id,
              part_type: "text",
              data: {
                type: "text",
                text: assistantText,
                status: "streaming",
              },
            });
            this.emit({
              type: "message.part.delta",
              properties: {
                sessionId: session.id,
                messageId: assistantMessageId,
                partId: textPartId,
                delta,
              },
            });
          },
        });

        totalInputTokens += stepResult.promptTokens;
        totalOutputTokens += stepResult.completionTokens;

        // If the model returned no tool calls, the turn is complete!
        if (stepResult.toolCalls.length === 0) {
          break;
        }

        // Append the assistant message with `tool_calls` to the in-memory conversation history
        conversationMessages.push({
          role: "assistant",
          content: stepResult.contentText || null,
          tool_calls: stepResult.toolCalls,
        });

        // Execute each requested tool call in sequence (supporting multiple tool calls in a single response)
        for (const tc of stepResult.toolCalls) {
          if (abort.signal.aborted) {
            throw new Error("Execution cancelled by user");
          }

          const toolPartId = `part_tool_${tc.id.replace(/[^a-zA-Z0-9_-]/g, "") || randomUUID().slice(0, 8)}`;
          const toolName = tc.function.name;

          // Step 4: Tool requested
          let parsedArgs: unknown = {};
          let parseError: string | null = null;
          try {
            parsedArgs = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch (err) {
            parseError =
              err instanceof Error
                ? err.message
                : "Malformed JSON tool arguments";
          }

          this.updateLifecycleState(
            session.id,
            assistantMessageId,
            "tool_requested",
            agentMode,
            toolName,
          );
          this.upsertToolPart(session.id, assistantMessageId, toolPartId, {
            toolCallId: tc.id,
            tool: toolName,
            state: "tool_requested",
            status: "requested",
            input: parseError ? tc.function.arguments : parsedArgs,
          });

          if (parseError) {
            const errOutput = `Error: Invalid JSON arguments for tool "${toolName}": ${parseError}. Raw arguments: ${tc.function.arguments}`;
            this.updateLifecycleState(
              session.id,
              assistantMessageId,
              "tool_failed",
              agentMode,
              toolName,
            );
            this.upsertToolPart(session.id, assistantMessageId, toolPartId, {
              toolCallId: tc.id,
              tool: toolName,
              state: "tool_failed",
              status: "error",
              input: tc.function.arguments,
              output: errOutput,
              error: errOutput,
            });
            conversationMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: errOutput,
            });
            continue;
          }

          // Execute tool with permission checks
          let toolFailed = false;
          let toolOutputText = "";
          let toolTitle = toolName;

          try {
            const outcome = await executeDesktopTool(toolName, parsedArgs, {
              sessionId: session.id,
              projectDir: session.directory,
              executionManager: this.executionManager,
              signal: abort.signal,
              checkPermission: async (permName, target, inputObj) => {
                const baseRules = agentDef.permission;
                const sessionRules =
                  this.sessionPermissionMemory.get(session.id) ?? [];
                const combinedRules = [...baseRules, ...sessionRules];
                let action: PermissionAction = evaluatePermission(
                  combinedRules,
                  permName,
                  target,
                );
                const permMode =
                  this.settingsService?.getSettings().defaultPermissionMode ??
                  "ask";
                if (permMode === "fullAccess" && action === "ask") {
                  action = "allow";
                }

                if (action === "deny") {
                  throw new Error(
                    `Permission denied by ${agentMode} mode policy for ${permName} on "${target}".`,
                  );
                }

                if (action === "ask") {
                  this.updateLifecycleState(
                    session.id,
                    assistantMessageId,
                    "waiting_permission",
                    agentMode,
                    toolName,
                  );
                  this.upsertToolPart(
                    session.id,
                    assistantMessageId,
                    toolPartId,
                    {
                      toolCallId: tc.id,
                      tool: toolName,
                      state: "waiting_permission",
                      status: "waiting_permission",
                      permissionTarget: target,
                      input: inputObj,
                    },
                  );

                  const permId = `perm_${randomUUID().slice(0, 10)}`;
                  const decision = await new Promise<{
                    approved: boolean;
                    scope?: "once" | "session";
                    reason?: string;
                  }>((resolve) => {
                    this.pendingPermissions.set(permId, {
                      id: permId,
                      sessionId: session.id,
                      toolCallId: tc.id,
                      toolName,
                      permission: permName,
                      target,
                      input: inputObj,
                      createdAt: Date.now(),
                      resolve,
                    });
                    this.emit({
                      type: "permission.asked",
                      properties: {
                        id: permId,
                        sessionId: session.id,
                        toolCallId: tc.id,
                        toolName,
                        permission: permName,
                        target,
                        input: inputObj,
                      },
                    });
                  });

                  if (!decision.approved) {
                    throw new Error(
                      `User denied permission for ${toolName} on "${target}"${decision.reason ? `: ${decision.reason}` : ""}.`,
                    );
                  }
                }

                // Transition to tool_executing only once permission is granted
                this.updateLifecycleState(
                  session.id,
                  assistantMessageId,
                  "tool_executing",
                  agentMode,
                  toolName,
                );
                this.upsertToolPart(
                  session.id,
                  assistantMessageId,
                  toolPartId,
                  {
                    toolCallId: tc.id,
                    tool: toolName,
                    state: "tool_executing",
                    status: "running",
                    input: inputObj,
                  },
                );
              },
            });

            toolFailed = !outcome.ok;
            toolOutputText = outcome.output;
            toolTitle = outcome.title;
            if (outcome.mutatedFile) {
              hadFileEdits = true;
            }
          } catch (err) {
            toolFailed = true;
            toolOutputText =
              err instanceof Error ? err.message : String(err);
          }

          const finalToolState: ToolLifecycleState = toolFailed
            ? "tool_failed"
            : "tool_completed";
          this.updateLifecycleState(
            session.id,
            assistantMessageId,
            finalToolState,
            agentMode,
            toolName,
          );
          this.upsertToolPart(session.id, assistantMessageId, toolPartId, {
            toolCallId: tc.id,
            tool: toolName,
            title: toolTitle,
            state: finalToolState,
            status: toolFailed ? "error" : "completed",
            input: parsedArgs,
            output: toolOutputText,
            error: toolFailed ? toolOutputText : undefined,
          });

          conversationMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: toolOutputText,
          });
        }
      }

      // Finalize assistant text part
      this.db.insertPart({
        id: textPartId,
        message_id: assistantMessageId,
        session_id: session.id,
        part_type: "text",
        data: {
          type: "text",
          text: assistantText,
          status: "completed",
        },
      });

      const diffStats = this.getWorkspaceDiff(session.directory);
      if (hadFileEdits && diffStats.diff.trim().length > 0) {
        this.db.upsertArtifact({
          id: `art_diff_${session.id}`,
          session_id: session.id,
          title: `Workspace Diff (+${diffStats.additions} / -${diffStats.deletions})`,
          kind: "diff",
          file_path: session.directory,
          content: `\`\`\`diff\n${diffStats.diff.slice(0, 32000)}\n\`\`\``,
        });
      }

      this.db.updateSession(session.id, {
        summary_additions: diffStats.additions,
        summary_deletions: diffStats.deletions,
        summary_files: diffStats.files,
      });

      this.db.insertMessage({
        id: assistantMessageId,
        session_id: session.id,
        role: "assistant",
        agent: agentMode,
        model_id: modelId,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        data: {
          status: "completed",
          lifecycleState: "final_response" satisfies ToolLifecycleState,
        },
      });

      this.updateLifecycleState(
        session.id,
        assistantMessageId,
        "final_response",
        agentMode,
      );

      return {
        userMessageId,
        assistantMessageId,
        assistantText,
        verified: false,
        verificationSummary: null,
      };
    } catch (err) {
      const isCancelled = abort.signal.aborted;
      const errMsg = isCancelled
        ? "Execution stopped by user."
        : err instanceof Error
          ? err.message
          : String(err);

      const errorText = assistantText
        ? `${assistantText}\n\n[${errMsg}]`
        : `Error: ${errMsg}`;

      this.db.insertPart({
        id: textPartId,
        message_id: assistantMessageId,
        session_id: session.id,
        part_type: "text",
        data: {
          type: "text",
          text: errorText,
          status: isCancelled ? "cancelled" : "error",
          error: errMsg,
        },
      });

      this.db.insertMessage({
        id: assistantMessageId,
        session_id: session.id,
        role: "assistant",
        agent: agentMode,
        model_id: modelId,
        data: {
          status: isCancelled ? "cancelled" : "error",
          lifecycleState: "final_response" satisfies ToolLifecycleState,
          error: errMsg,
        },
      });

      this.emit({
        type: "session.status",
        properties: {
          sessionId: session.id,
          status: "idle",
          lifecycleState: "final_response",
          error: isCancelled ? undefined : errMsg,
          stopped: isCancelled,
        },
      });

      throw err;
    } finally {
      this.activeAborts.delete(session.id);
    }
  }

  private updateLifecycleState(
    sessionId: string,
    messageId: string,
    lifecycleState: ToolLifecycleState,
    agentMode: string,
    activeTool?: string,
  ): void {
    const isIdle = lifecycleState === "final_response";
    this.emit({
      type: "session.status",
      properties: {
        sessionId,
        messageId,
        status: isIdle ? "idle" : "running",
        lifecycleState,
        agent: agentMode,
        activeTool: activeTool ?? null,
      },
    });
  }

  private upsertToolPart(
    sessionId: string,
    messageId: string,
    partId: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.insertPart({
      id: partId,
      message_id: messageId,
      session_id: sessionId,
      part_type: "tool",
      data: {
        type: "tool",
        ...payload,
      },
    });
    this.emit({
      type: "message.part.updated",
      properties: {
        sessionId,
        messageId,
        partId,
        part: {
          type: "tool",
          ...payload,
        },
      },
    });
  }

  private buildConversationHistory(
    session: SessionRow,
    agentDef: AgentInfo,
    currentUserMessageId: string,
    currentPromptText: string,
  ): ChatCompletionMessageParam[] {
    const customInstr =
      this.settingsService?.getSettings().customInstructions?.trim() ?? "";
    const systemPrompt = [
      agentDef.systemInstructions,
      `Active project root directory: ${session.directory}`,
      `Operating system: ${process.platform}`,
      `When inspecting or modifying the project, always use the provided tools (read_file, create_file, edit_file, list_directory, search_files, search_content, run_command, read_process_output, cancel_process, project_info, working_directory, git_status, git_diff). Never guess file contents or command outputs.`,
      customInstr ? `Custom User Instructions:\n${customInstr}` : "",
      session.agent === "plan"
        ? buildPlanModeReminder(session.directory, session.slug)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    const priorMessages = this.db.listMessages(session.id);
    for (const msg of priorMessages) {
      if (msg.id === currentUserMessageId) continue;
      if (msg.role === "user") {
        const textPart = msg.parts.find((p) => p.part_type === "text");
        let text = "";
        if (textPart) {
          try {
            const parsed = JSON.parse(textPart.data) as { text?: string };
            text = parsed.text ?? "";
          } catch {
            text = "";
          }
        }
        if (text) {
          history.push({ role: "user", content: text });
        }
      } else if (msg.role === "assistant") {
        const textPart = msg.parts.find((p) => p.part_type === "text");
        let text = "";
        if (textPart) {
          try {
            const parsed = JSON.parse(textPart.data) as { text?: string };
            text = parsed.text ?? "";
          } catch {
            text = "";
          }
        }
        if (text) {
          history.push({ role: "assistant", content: text });
        }
      }
    }

    history.push({ role: "user", content: currentPromptText });
    return history;
  }

  /**
   * Sends a single streaming chat completion request to Entry's model gateway
   * (`/v1/chat/completions` or `/api/desktop/chat`) and accumulates streamed text
   * deltas and tool calls.
   */
  private async streamGatewayRound(options: {
    sessionToken: string;
    modelId: string;
    messages: ChatCompletionMessageParam[];
    tools: OpenAIToolSchema[];
    signal: AbortSignal;
    onTextDelta: (delta: string) => void;
  }): Promise<{
    contentText: string;
    toolCalls: ChatCompletionToolCall[];
    promptTokens: number;
    completionTokens: number;
  }> {
    const primary = this.entryBaseUrl.replace(/\/$/, "");
    const origins = new Set<string>([primary]);
    if (primary === "https://entry-agents.dev") {
      for (const fb of FALLBACK_ENTRY_BACKEND_URLS) {
        origins.add(fb);
      }
    }

    let response: Response | null = null;
    let lastError = "Unable to reach Entry model gateway";

    for (const origin of origins) {
      const url = `${origin}/v1/chat/completions`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.sessionToken}`,
          },
          body: JSON.stringify({
            model: options.modelId,
            stream: true,
            messages: options.messages,
            tools: options.tools,
            tool_choice: "auto",
          }),
          signal: options.signal,
        });

        if (res.status === 404 && origin === "https://entry-agents.dev" && origins.size > 1) {
          // Try deployed desktop backend origin
          continue;
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          let parsedErr = errBody;
          try {
            const j = JSON.parse(errBody) as {
              error?: string | { message?: string };
              reason?: string;
            };
            if (typeof j.error === "string") parsedErr = j.error;
            else if (j.error?.message) parsedErr = j.error.message;
            if (j.reason) parsedErr = `${parsedErr} (${j.reason})`;
          } catch {
            // keep text
          }

          if (res.status === 401) {
            this.authService?.signOut();
            throw new Error(
              `Authentication session expired (HTTP 401). Please sign in again. ${parsedErr}`.trim(),
            );
          }
          if (res.status === 402) {
            throw new Error(
              `Insufficient Entry credits (HTTP 402): ${parsedErr || "Please top up your account or upgrade your plan."}`,
            );
          }
          if (res.status === 403) {
            throw new Error(
              `Model unavailable on current plan (HTTP 403): ${parsedErr || options.modelId}`,
            );
          }
          throw new Error(
            `Model gateway error (HTTP ${res.status}): ${parsedErr || res.statusText}`,
          );
        }

        response = res;
        break;
      } catch (err) {
        if (options.signal.aborted) {
          throw new Error("Execution cancelled by user");
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("HTTP 401") ||
          msg.includes("HTTP 402") ||
          msg.includes("HTTP 403") ||
          msg.includes("Model gateway error")
        ) {
          throw err;
        }
        lastError = msg;
      }
    }

    if (!response || !response.body) {
      throw new Error(`Network failure communicating with Entry gateway: ${lastError}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: ChatCompletionToolCall[];
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const first = json.choices?.[0]?.message;
      const contentText = first?.content ?? "";
      if (contentText) {
        options.onTextDelta(contentText);
      }
      return {
        contentText,
        toolCalls: first?.tool_calls ?? [],
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let contentText = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let parsed: {
          error?: { message?: string } | string;
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            message?: {
              content?: string | null;
              tool_calls?: ChatCompletionToolCall[];
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.error) {
          const errMsg =
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error.message ?? "Stream error from model gateway";
          throw new Error(errMsg);
        }

        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const deltaContent = choice.delta?.content ?? choice.message?.content;
        if (typeof deltaContent === "string" && deltaContent.length > 0) {
          contentText += deltaContent;
          options.onTextDelta(deltaContent);
        }

        if (Array.isArray(choice.delta?.tool_calls)) {
          for (const tcDelta of choice.delta.tool_calls) {
            const idx = typeof tcDelta.index === "number" ? tcDelta.index : 0;
            const existing = toolCallsByIndex.get(idx) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tcDelta.id) existing.id = tcDelta.id;
            if (tcDelta.function?.name) existing.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) {
              existing.arguments += tcDelta.function.arguments;
            }
            toolCallsByIndex.set(idx, existing);
          }
        } else if (Array.isArray(choice.message?.tool_calls)) {
          choice.message.tool_calls.forEach((tc, idx) => {
            toolCallsByIndex.set(idx, {
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          });
        }
      }
    }

    const toolCalls: ChatCompletionToolCall[] = Array.from(
      toolCallsByIndex.entries(),
    )
      .sort(([a], [b]) => a - b)
      .filter(([, tc]) => tc.name.trim().length > 0)
      .map(([idx, tc]) => ({
        id: tc.id || `call_${idx}_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: tc.name.trim(),
          arguments: tc.arguments || "{}",
        },
      }));

    return {
      contentText,
      toolCalls,
      promptTokens,
      completionTokens,
    };
  }
}
