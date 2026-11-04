/**
 * Entry Desktop V1 — Permission Engine
 *
 * Implements the permission architecture studied in `docs/desktop/architecture.md`:
 * - Actions: `"allow"` | `"ask"` | `"deny"`
 * - Path-based permissions & external directory boundary checks
 * - Sensitive file protection (`.env`, `.env.*`, `.git/config`, `.git/hooks/*`, `*.pem`, `*.key`, `*credentials*`)
 * - Destructive / mutating command classification (`rm`, `del`, `Remove-Item`, `git reset`, `git push`, `git clean`, etc.)
 * - Session-level & persistent approval memory (`"once"` | `"session"` | `"deny"`)
 *
 * Explicit V1 Security Boundary Note:
 * Permission rules enforce pre-execution policy gates inside Entry's tool dispatcher.
 * When a shell command is approved and executed on the host OS, child processes run with
 * the current OS user's privileges (not inside an OS kernel namespace or VM).
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export type PermissionRuleset = PermissionRule[];

export function wildcardMatch(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(target);
}

/**
 * Default ruleset for `build` mode:
 * - Allows project-scoped read, list, search, and normal file creation/edits
 * - Requires explicit user approval (`ask`) for sensitive files, external directories,
 *   and destructive or network/privilege-escalating shell commands
 */
export const BUILD_PERMISSION_RULESET: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "read_file", pattern: "*.env", action: "ask" },
  { permission: "read_file", pattern: "*/.env", action: "ask" },
  { permission: "read_file", pattern: "*.env.*", action: "ask" },
  { permission: "read_file", pattern: "*/.env.*", action: "ask" },
  { permission: "read_file", pattern: "*.env.example", action: "allow" },
  { permission: "read_file", pattern: "*/.env.example", action: "allow" },
  { permission: "create_file", pattern: "*.env", action: "ask" },
  { permission: "create_file", pattern: "*/.env", action: "ask" },
  { permission: "create_file", pattern: "*.env.*", action: "ask" },
  { permission: "create_file", pattern: "*/.env.*", action: "ask" },
  { permission: "edit_file", pattern: "*.env", action: "ask" },
  { permission: "edit_file", pattern: "*/.env", action: "ask" },
  { permission: "edit_file", pattern: "*.env.*", action: "ask" },
  { permission: "edit_file", pattern: "*/.env.*", action: "ask" },
  { permission: "*", pattern: "*.pem", action: "ask" },
  { permission: "*", pattern: "*.key", action: "ask" },
  { permission: "*", pattern: "*/.git/config", action: "ask" },
  { permission: "*", pattern: "*/.git/hooks/*", action: "ask" },
];

/**
 * Default ruleset for `plan` mode:
 * - Read-only exploration (`read_file`, `list_directory`, `search_files`, `search_content`, `project_info`, `working_directory`, `git_status`, `git_diff` allowed)
 * - Denies mutating `create_file`, `edit_file`, `run_command` EXCEPT writing to `.entry/plan/*.md`
 */
export const PLAN_PERMISSION_RULESET: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "read_file", pattern: "*.env", action: "ask" },
  { permission: "read_file", pattern: "*.env.*", action: "ask" },
  { permission: "read_file", pattern: "*.env.example", action: "allow" },
  { permission: "run_command", pattern: "*", action: "deny" },
  { permission: "create_file", pattern: "*", action: "deny" },
  { permission: "edit_file", pattern: "*", action: "deny" },
  { permission: "create_file", pattern: "*.entry/plan/*.md", action: "allow" },
  { permission: "edit_file", pattern: "*.entry/plan/*.md", action: "allow" },
  { permission: "create_file", pattern: "*/.entry/plan/*.md", action: "allow" },
  { permission: "edit_file", pattern: "*/.entry/plan/*.md", action: "allow" },
];

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)\b(?:rm|rmdir|del|erase|Remove-Item|Format-Volume|dd|mkfs|shutdown|reboot)\b/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[fd]|push\b|branch\s+-D|checkout\s+--\s+\.)/i,
  /\b(?:sudo|su|runas|chmod\s+777|chown)\b/i,
  /\b(?:npm\s+publish|pnpm\s+publish|cargo\s+publish)\b/i,
];

export function isSensitiveCommand(command: string): boolean {
  const trimmed = command.trim();
  for (const regex of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (regex.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates a permission ruleset in order (last matching rule wins).
 */
export function evaluatePermission(
  ruleset: PermissionRuleset,
  permission: string,
  target = "*",
): PermissionAction {
  let result: PermissionAction = "allow";
  const normalizedTarget = target.replace(/\\/g, "/");

  for (const rule of ruleset) {
    const permMatches =
      rule.permission === "*" || wildcardMatch(rule.permission, permission);
    const patternMatches =
      rule.pattern === "*" || wildcardMatch(rule.pattern, normalizedTarget);
    if (permMatches && patternMatches) {
      result = rule.action;
    }
  }

  // Additionally check if a shell command matches destructive/sensitive patterns
  if (
    result === "allow" &&
    (permission === "run_command" || permission === "bash") &&
    isSensitiveCommand(target)
  ) {
    return "ask";
  }

  return result;
}
