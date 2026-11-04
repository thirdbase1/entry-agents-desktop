/**
 * Modular Agent Registry (`build`, `plan`, `explore`, `general`, `title`, `summary`)
 * Mirrors `packages/core/src/plugin/agent.ts` and `packages/core/src/plugin/plan.ts`.
 *
 * Embodies Entry Desktop's 5 Core Promises:
 * 1. Spend less: Get more useful work from every dollar.
 * 2. Move faster: Fast desktop, fast execution, efficient agents.
 * 3. Trust the results: Agents must prove their work.
 * 4. Stay in control: Users own their models, projects, execution and data.
 * 5. Extend everything: Plugins make Entry capable of growing beyond its original developers.
 */
import { join } from "node:path";
import {
  BUILD_PERMISSION_RULESET,
  PLAN_PERMISSION_RULESET,
  type PermissionRuleset,
} from "../permission/permission";

export interface AgentInfo {
  name: "build" | "plan" | "explore" | "general" | "title" | "summary";
  displayName: string;
  description: string;
  mode: "primary" | "subagent" | "hidden";
  native: boolean;
  permission: PermissionRuleset;
  systemInstructions: string;
}

export const PROMPT_EXPLORE = `You are a file search specialist for Entry Desktop. You excel at thoroughly navigating and exploring codebases with minimal token waste.
- Use glob to find files by name/pattern
- Use grep to search file contents with regex
- Use read to inspect specific line ranges
- Adapt your search approach based on the thoroughness requested by the caller.`;

export const PROMPT_TITLE = `You are a title generator. Output ONLY a brief 2-5 word title for the conversation without quotes or punctuation.`;

export const PROMPT_SUMMARY = `Summarize what was done in this conversation like a concise pull request description (2-4 bullet points).`;

export const PROMPT_BUILD = `You are Entry Desktop in BUILD mode.
Core Product Principle: Get the most verified work done with the least time, money, and human intervention.
- Spend less: Avoid redundant file reads or noisy output.
- Move faster: Execute changes directly and cleanly.
- Trust the results: Always verify your changes (run typecheck, tests, or build checks) and report concrete verification proof.
- Stay in control: Respect project boundaries and permission rules.`;

export function buildPlanModeReminder(
  projectDir: string,
  sessionSlug: string,
): string {
  const planPath = join(
    projectDir,
    ".entry",
    "plan",
    `${sessionSlug}.md`,
  ).replace(/\\/g, "/");
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute mutating code changes yet — you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools, or otherwise make any changes to the system.

## Plan File Info:
You should record your structured architectural blueprint and implementation plan at:
${planPath}

## Workflow:
Phase 1: Initial Understanding — Explore the codebase using read, glob, and grep.
Phase 2: Design & Architecture — Formulate a verified, minimal-token implementation plan.
Phase 3: Synthesis — Write the markdown plan artifact to ${planPath} so it renders in the Right Workspace Column.
</system-reminder>`;
}

export const AGENTS: Record<AgentInfo["name"], AgentInfo> = {
  build: {
    name: "build",
    displayName: "Build",
    description:
      "The default agent. Executes tools based on configured permissions and verifies work.",
    mode: "primary",
    native: true,
    permission: BUILD_PERMISSION_RULESET,
    systemInstructions: PROMPT_BUILD,
  },
  plan: {
    name: "plan",
    displayName: "Plan",
    description:
      "Plan mode. Disallows all edit tools except writing the structured markdown plan file.",
    mode: "primary",
    native: true,
    permission: PLAN_PERMISSION_RULESET,
    systemInstructions:
      "You are Entry Desktop in PLAN mode. Explore the codebase read-only and produce a clear, verifiable engineering blueprint.",
  },
  general: {
    name: "general",
    displayName: "General",
    description:
      "General-purpose agent for researching complex questions and executing multi-step tasks.",
    mode: "subagent",
    native: true,
    permission: BUILD_PERMISSION_RULESET,
    systemInstructions: PROMPT_BUILD,
  },
  explore: {
    name: "explore",
    displayName: "Explore",
    description: "Fast agent specialized for exploring codebases.",
    mode: "subagent",
    native: true,
    permission: PLAN_PERMISSION_RULESET,
    systemInstructions: PROMPT_EXPLORE,
  },
  title: {
    name: "title",
    displayName: "Title",
    description: "Generates concise conversation titles.",
    mode: "hidden",
    native: true,
    permission: PLAN_PERMISSION_RULESET,
    systemInstructions: PROMPT_TITLE,
  },
  summary: {
    name: "summary",
    displayName: "Summary",
    description: "Generates pull-request style session summaries.",
    mode: "hidden",
    native: true,
    permission: PLAN_PERMISSION_RULESET,
    systemInstructions: PROMPT_SUMMARY,
  },
};

export function listVisibleAgents(): AgentInfo[] {
  return [AGENTS.build, AGENTS.plan, AGENTS.general, AGENTS.explore];
}
