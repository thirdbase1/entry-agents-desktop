/**
 * Entry Desktop V1 — Initial Toolset (Section 7)
 *
 * Implements the 13 required local tools with:
 * - Strict JSON Schema & runtime argument validation
 * - Canonical `realpath` containment and permission gate integration
 * - Bounded output size (`truncateToolOutput`: max 2,000 lines / 50 KiB)
 * - Structured output & clear error reporting
 *
 * Required Tools:
 * 1. `read_file`
 * 2. `create_file`
 * 3. `edit_file`
 * 4. `list_directory`
 * 5. `search_files`
 * 6. `search_content`
 * 7. `run_command`
 * 8. `read_process_output`
 * 9. `cancel_process`
 * 10. `project_info`
 * 11. `working_directory`
 * 12. `git_status`
 * 13. `git_diff`
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  type LocalExecutionManager,
  resolveAndCheckProjectPath,
  truncateToolOutput,
} from "../execution/local-env";

export interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolExecutionContext {
  sessionId: string;
  projectDir: string;
  executionManager: LocalExecutionManager;
  signal?: AbortSignal;
  /**
   * Checks permissions (`allow` | `ask` | `deny`) and blocks awaiting user approval
   * when the rule evaluates to `ask`. Throws if denied.
   */
  checkPermission: (
    permissionName: string,
    target: string,
    input: unknown,
  ) => Promise<void>;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
  mutatedFile?: boolean;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".cache",
  "coverage",
]);

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re, "i");
}

function walkProjectFiles(
  rootDir: string,
  maxFiles = 5000,
): Array<{ absPath: string; relPath: string }> {
  const results: Array<{ absPath: string; relPath: string }> = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push({
          absPath: fullPath,
          relPath: relative(rootDir, fullPath).replace(/\\/g, "/"),
        });
      }
    }
  }
  return results;
}

export function getOpenAIToolDefinitions(): OpenAIToolSchema[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a file in the project with line numbers. Supports optional line offset (1-based) and line limit.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative or absolute path to the file to read.",
            },
            offset: {
              type: "number",
              description: "Optional 1-based starting line number (default: 1).",
            },
            limit: {
              type: "number",
              description: "Optional maximum number of lines to read (default: 2000).",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_file",
        description:
          "Create a new file (or overwrite an existing file) with the specified text content. Parent directories are created automatically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative or absolute path of the file to create.",
            },
            content: {
              type: "string",
              description: "Full text content to write to the file.",
            },
            overwrite: {
              type: "boolean",
              description:
                "Whether to overwrite the file if it already exists (default: true).",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Edit an existing file by replacing an exact string occurrence (`oldString`) with `newString`. Preserves file line endings.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative or absolute path to the file to edit.",
            },
            oldString: {
              type: "string",
              description: "The exact existing text in the file to replace.",
            },
            newString: {
              type: "string",
              description: "The replacement text.",
            },
            replaceAll: {
              type: "boolean",
              description:
                "If true, replace all occurrences of oldString; otherwise oldString must match uniquely.",
            },
          },
          required: ["path", "oldString", "newString"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description:
          "List files and subdirectories inside a project directory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Directory path relative to project root (defaults to '.').",
            },
            recursive: {
              type: "boolean",
              description:
                "Whether to list contents recursively (default: false).",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description:
          "Search for files in the project matching a glob or substring pattern (e.g. '*.ts', 'src/**/*.rs', 'package.json').",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Glob or filename pattern to match.",
            },
            path: {
              type: "string",
              description: "Optional subdirectory to restrict the search.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of file matches to return (default: 100).",
            },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_content",
        description:
          "Search file contents across the project for a text or regex query, returning matching file paths, line numbers, and lines.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text or regular expression pattern to search for.",
            },
            path: {
              type: "string",
              description: "Optional subdirectory or file path to search within.",
            },
            filePattern: {
              type: "string",
              description: "Optional glob filter for filenames (e.g. '*.ts').",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of matching lines to return (default: 100).",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Execute a shell command in the local project environment. Returns exit code, stdout, stderr, and process ID.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory (relative to project root or absolute).",
            },
            timeoutMs: {
              type: "number",
              description:
                "Optional timeout in milliseconds (default: 120000).",
            },
            background: {
              type: "boolean",
              description:
                "If true, start the process in the background and return its processId immediately so it can be monitored with read_process_output or stopped with cancel_process.",
            },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_process_output",
        description:
          "Read the current status, exit code, stdout, and stderr of a running or completed process started by run_command.",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "The processId returned by run_command.",
            },
          },
          required: ["processId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_process",
        description:
          "Cancel and terminate a running process (and its descendant process tree) by its processId.",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "The processId returned by run_command.",
            },
          },
          required: ["processId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "project_info",
        description:
          "Return metadata about the active project: root path, name, VCS status, current git branch, top-level entries, and file count.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "working_directory",
        description:
          "Return the canonical working directory of the active project session.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description:
          "Run `git status --short --branch` in the project directory and return the working tree status.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description:
          "Run `git diff` in the project directory and return the unified diff of unstaged or staged changes.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Optional file or directory path to diff.",
            },
            staged: {
              type: "boolean",
              description: "If true, show staged changes (`git diff --staged`).",
            },
          },
        },
      },
    },
  ];
}

const KNOWN_TOOL_NAMES = new Set(
  getOpenAIToolDefinitions().map((d) => d.function.name),
);

export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name);
}

/**
 * Validates and executes a single tool call against the local project environment.
 */
export async function executeDesktopTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  if (!isKnownToolName(toolName)) {
    return {
      ok: false,
      title: `Unknown tool: ${toolName}`,
      output: `Error: Tool "${toolName}" does not exist. Available tools: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
    };
  }

  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {
      ok: false,
      title: `${toolName} (invalid arguments)`,
      output: `Error: Tool arguments for "${toolName}" must be a valid JSON object.`,
    };
  }

  const args = rawArgs as Record<string, unknown>;

  try {
    switch (toolName) {
      case "read_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return {
            ok: false,
            title: "read_file (invalid path)",
            output: 'Error: Argument "path" is required and must be a non-empty string.',
          };
        }
        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, args.path);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("read_file", pathCheck.relativePath, args);

        if (!existsSync(pathCheck.resolvedPath)) {
          return {
            ok: false,
            title: `read_file ${pathCheck.relativePath}`,
            output: `Error: File not found: ${pathCheck.relativePath}`,
          };
        }
        const st = statSync(pathCheck.resolvedPath);
        if (st.isDirectory()) {
          return {
            ok: false,
            title: `read_file ${pathCheck.relativePath}`,
            output: `Error: "${pathCheck.relativePath}" is a directory. Use list_directory instead.`,
          };
        }

        const rawContent = readFileSync(pathCheck.resolvedPath, "utf-8");
        const allLines = rawContent.split(/\r?\n/);
        const offset =
          typeof args.offset === "number" && args.offset >= 1
            ? Math.floor(args.offset)
            : 1;
        const limit =
          typeof args.limit === "number" && args.limit >= 1
            ? Math.min(Math.floor(args.limit), 2000)
            : 2000;

        const slice = allLines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice
          .map((line, idx) => `${String(offset + idx).padStart(4, " ")} | ${line}`)
          .join("\n");
        const header = `File: ${pathCheck.relativePath} (lines ${offset}-${offset + slice.length - 1} of ${allLines.length})\n`;
        const bounded = truncateToolOutput(header + numbered, "read_file");

        return {
          ok: true,
          title: `Read ${pathCheck.relativePath}`,
          output: bounded.content,
          metadata: {
            path: pathCheck.relativePath,
            totalLines: allLines.length,
            truncated: bounded.truncated,
          },
        };
      }

      case "create_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return {
            ok: false,
            title: "create_file (invalid path)",
            output: 'Error: Argument "path" is required and must be a non-empty string.',
          };
        }
        if (typeof args.content !== "string") {
          return {
            ok: false,
            title: "create_file (invalid content)",
            output: 'Error: Argument "content" is required and must be a string.',
          };
        }

        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, args.path);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("create_file", pathCheck.relativePath, args);

        const overwrite = args.overwrite !== false;
        if (existsSync(pathCheck.resolvedPath) && !overwrite) {
          return {
            ok: false,
            title: `create_file ${pathCheck.relativePath}`,
            output: `Error: File "${pathCheck.relativePath}" already exists and overwrite=false.`,
          };
        }

        mkdirSync(dirname(pathCheck.resolvedPath), { recursive: true });
        writeFileSync(pathCheck.resolvedPath, args.content, "utf-8");
        const linesCount = args.content.split(/\r?\n/).length;

        return {
          ok: true,
          title: `Created ${pathCheck.relativePath}`,
          output: `Successfully wrote ${Buffer.byteLength(args.content, "utf-8")} bytes (${linesCount} lines) to ${pathCheck.relativePath}.`,
          mutatedFile: true,
          metadata: {
            path: pathCheck.relativePath,
            lines: linesCount,
          },
        };
      }

      case "edit_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return {
            ok: false,
            title: "edit_file (invalid path)",
            output: 'Error: Argument "path" is required and must be a non-empty string.',
          };
        }
        if (typeof args.oldString !== "string" || args.oldString.length === 0) {
          return {
            ok: false,
            title: "edit_file (invalid oldString)",
            output: 'Error: Argument "oldString" is required and must be a non-empty string.',
          };
        }
        if (typeof args.newString !== "string") {
          return {
            ok: false,
            title: "edit_file (invalid newString)",
            output: 'Error: Argument "newString" is required and must be a string.',
          };
        }

        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, args.path);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("edit_file", pathCheck.relativePath, args);

        if (!existsSync(pathCheck.resolvedPath)) {
          return {
            ok: false,
            title: `edit_file ${pathCheck.relativePath}`,
            output: `Error: File not found: ${pathCheck.relativePath}`,
          };
        }

        const original = readFileSync(pathCheck.resolvedPath, "utf-8");
        const usesCrLf = original.includes("\r\n");
        const normOriginal = original.replace(/\r\n/g, "\n");
        const normOld = args.oldString.replace(/\r\n/g, "\n");
        const normNew = args.newString.replace(/\r\n/g, "\n");

        const occurrences = normOriginal.split(normOld).length - 1;
        if (occurrences === 0) {
          return {
            ok: false,
            title: `edit_file ${pathCheck.relativePath}`,
            output: `Error: oldString was not found in ${pathCheck.relativePath}. Read the file first to verify exact contents and whitespace.`,
          };
        }
        if (occurrences > 1 && !args.replaceAll) {
          return {
            ok: false,
            title: `edit_file ${pathCheck.relativePath}`,
            output: `Error: oldString matched ${occurrences} locations in ${pathCheck.relativePath}. Provide more surrounding context or set replaceAll=true.`,
          };
        }

        const updatedNorm = args.replaceAll
          ? normOriginal.split(normOld).join(normNew)
          : normOriginal.replace(normOld, () => normNew);
        const finalContent = usesCrLf
          ? updatedNorm.replace(/\n/g, "\r\n")
          : updatedNorm;

        writeFileSync(pathCheck.resolvedPath, finalContent, "utf-8");

        return {
          ok: true,
          title: `Edited ${pathCheck.relativePath}`,
          output: `Successfully updated ${pathCheck.relativePath} (${args.replaceAll ? occurrences : 1} replacement${occurrences > 1 && args.replaceAll ? "s" : ""}).`,
          mutatedFile: true,
          metadata: {
            path: pathCheck.relativePath,
            replacements: args.replaceAll ? occurrences : 1,
          },
        };
      }

      case "list_directory": {
        const targetArg =
          typeof args.path === "string" && args.path.trim()
            ? args.path.trim()
            : ".";
        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, targetArg);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("list_directory", pathCheck.relativePath, args);

        if (!existsSync(pathCheck.resolvedPath)) {
          return {
            ok: false,
            title: `list_directory ${pathCheck.relativePath}`,
            output: `Error: Directory not found: ${pathCheck.relativePath}`,
          };
        }

        const st = statSync(pathCheck.resolvedPath);
        if (!st.isDirectory()) {
          return {
            ok: false,
            title: `list_directory ${pathCheck.relativePath}`,
            output: `Error: "${pathCheck.relativePath}" is a file, not a directory.`,
          };
        }

        if (args.recursive) {
          const files = walkProjectFiles(pathCheck.resolvedPath, 1000);
          const listing = files.map((f) => f.relPath).join("\n");
          const bounded = truncateToolOutput(
            `Directory (recursive): ${pathCheck.relativePath} (${files.length} files)\n${listing}`,
            "list_directory",
          );
          return {
            ok: true,
            title: `Listed ${pathCheck.relativePath} (recursive)`,
            output: bounded.content,
          };
        }

        const entries = readdirSync(pathCheck.resolvedPath, {
          withFileTypes: true,
        });
        const formatted = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => a.localeCompare(b));
        const bounded = truncateToolOutput(
          `Directory: ${pathCheck.relativePath} (${formatted.length} entries)\n${formatted.join("\n")}`,
          "list_directory",
        );

        return {
          ok: true,
          title: `Listed ${pathCheck.relativePath}`,
          output: bounded.content,
        };
      }

      case "search_files": {
        if (typeof args.pattern !== "string" || !args.pattern.trim()) {
          return {
            ok: false,
            title: "search_files (invalid pattern)",
            output: 'Error: Argument "pattern" is required and must be a non-empty string.',
          };
        }
        const subPath =
          typeof args.path === "string" && args.path.trim()
            ? args.path.trim()
            : ".";
        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, subPath);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("search_files", pathCheck.relativePath, args);

        if (!existsSync(pathCheck.resolvedPath)) {
          return {
            ok: false,
            title: `search_files ${args.pattern}`,
            output: `Error: Search path does not exist: ${pathCheck.relativePath}`,
          };
        }

        const maxResults =
          typeof args.maxResults === "number" && args.maxResults >= 1
            ? Math.min(Math.floor(args.maxResults), 500)
            : 100;

        const rawPattern = args.pattern.trim();
        const globRegex = globToRegExp(rawPattern);
        const basenameRegex = globToRegExp(basename(rawPattern));
        const allFiles = walkProjectFiles(pathCheck.resolvedPath, 5000);

        const matched: string[] = [];
        for (const file of allFiles) {
          const base = basename(file.relPath);
          if (
            globRegex.test(file.relPath) ||
            basenameRegex.test(base) ||
            file.relPath.toLowerCase().includes(rawPattern.toLowerCase())
          ) {
            matched.push(file.relPath);
            if (matched.length >= maxResults) break;
          }
        }

        const output =
          matched.length > 0
            ? `Found ${matched.length} file(s) matching "${rawPattern}":\n${matched.join("\n")}`
            : `No files found matching "${rawPattern}".`;

        return {
          ok: true,
          title: `Search files: ${rawPattern}`,
          output: truncateToolOutput(output, "search_files").content,
        };
      }

      case "search_content": {
        if (typeof args.query !== "string" || !args.query.trim()) {
          return {
            ok: false,
            title: "search_content (invalid query)",
            output: 'Error: Argument "query" is required and must be a non-empty string.',
          };
        }
        const subPath =
          typeof args.path === "string" && args.path.trim()
            ? args.path.trim()
            : ".";
        const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, subPath);
        if (!pathCheck.insideProject) {
          await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
        }
        await ctx.checkPermission("search_content", pathCheck.relativePath, args);

        if (!existsSync(pathCheck.resolvedPath)) {
          return {
            ok: false,
            title: `search_content ${args.query}`,
            output: `Error: Search path does not exist: ${pathCheck.relativePath}`,
          };
        }

        const maxResults =
          typeof args.maxResults === "number" && args.maxResults >= 1
            ? Math.min(Math.floor(args.maxResults), 500)
            : 100;

        let regex: RegExp;
        try {
          regex = new RegExp(args.query, "i");
        } catch {
          const escaped = args.query.replace(/[.+^${}()|[\]\\]/g, "\\$&");
          regex = new RegExp(escaped, "i");
        }

        const fileFilter =
          typeof args.filePattern === "string" && args.filePattern.trim()
            ? globToRegExp(args.filePattern.trim())
            : null;

        const st = statSync(pathCheck.resolvedPath);
        const filesToScan = st.isFile()
          ? [
              {
                absPath: pathCheck.resolvedPath,
                relPath: pathCheck.relativePath,
              },
            ]
          : walkProjectFiles(pathCheck.resolvedPath, 3000);

        const matches: string[] = [];
        for (const file of filesToScan) {
          if (matches.length >= maxResults) break;
          if (
            fileFilter &&
            !fileFilter.test(file.relPath) &&
            !fileFilter.test(basename(file.relPath))
          ) {
            continue;
          }
          try {
            const stat = statSync(file.absPath);
            if (stat.size > 1024 * 1024) continue; // skip files > 1 MiB
            const text = readFileSync(file.absPath, "utf-8");
            if (text.includes("\0")) continue; // skip binary files
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push(`${file.relPath}:${i + 1}: ${lines[i].trim()}`);
                if (matches.length >= maxResults) break;
              }
            }
          } catch {
            continue;
          }
        }

        const output =
          matches.length > 0
            ? `Found ${matches.length} match(es) for "${args.query}":\n${matches.join("\n")}`
            : `No matches found for "${args.query}".`;

        return {
          ok: true,
          title: `Search content: ${args.query}`,
          output: truncateToolOutput(output, "search_content").content,
        };
      }

      case "run_command": {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return {
            ok: false,
            title: "run_command (invalid command)",
            output: 'Error: Argument "command" is required and must be a non-empty string.',
          };
        }

        const cwdArg =
          typeof args.cwd === "string" && args.cwd.trim()
            ? args.cwd.trim()
            : ".";
        const cwdCheck = resolveAndCheckProjectPath(ctx.projectDir, cwdArg);
        if (!cwdCheck.insideProject) {
          await ctx.checkPermission("external_directory", cwdCheck.resolvedPath, args);
        }
        if (!existsSync(cwdCheck.resolvedPath)) {
          return {
            ok: false,
            title: `run_command (${args.command.slice(0, 40)})`,
            output: `Error: Working directory does not exist: ${cwdCheck.resolvedPath}`,
          };
        }

        await ctx.checkPermission("run_command", args.command.trim(), args);

        const procInfo = await ctx.executionManager.startCommand({
          sessionId: ctx.sessionId,
          command: args.command,
          cwd: cwdCheck.resolvedPath,
          timeoutMs:
            typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          background: Boolean(args.background),
          signal: ctx.signal,
        });

        const combinedOutput = [
          `processId: ${procInfo.id}`,
          `status: ${procInfo.status}`,
          `exitCode: ${procInfo.exitCode ?? "running"}`,
          `cwd: ${procInfo.cwd}`,
          procInfo.stdout ? `\n--- stdout ---\n${procInfo.stdout.trimEnd()}` : "",
          procInfo.stderr ? `\n--- stderr ---\n${procInfo.stderr.trimEnd()}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bounded = truncateToolOutput(combinedOutput, "run_command");
        const ok =
          procInfo.status === "completed" || procInfo.status === "running";

        return {
          ok,
          title: `Command: ${args.command.slice(0, 60)}`,
          output: bounded.content,
          metadata: {
            processId: procInfo.id,
            pid: procInfo.pid,
            status: procInfo.status,
            exitCode: procInfo.exitCode,
          },
        };
      }

      case "read_process_output": {
        if (typeof args.processId !== "string" || !args.processId.trim()) {
          return {
            ok: false,
            title: "read_process_output (invalid processId)",
            output: 'Error: Argument "processId" is required and must be a string.',
          };
        }
        const proc = ctx.executionManager.getProcess(args.processId.trim());
        if (!proc) {
          return {
            ok: false,
            title: `read_process_output ${args.processId}`,
            output: `Error: Process "${args.processId}" not found.`,
          };
        }

        const combined = [
          `processId: ${proc.id}`,
          `command: ${proc.command}`,
          `status: ${proc.status}`,
          `exitCode: ${proc.exitCode ?? "running"}`,
          proc.stdout ? `\n--- stdout ---\n${proc.stdout.trimEnd()}` : "",
          proc.stderr ? `\n--- stderr ---\n${proc.stderr.trimEnd()}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bounded = truncateToolOutput(combined, "process_output");
        return {
          ok: true,
          title: `Process output (${proc.id})`,
          output: bounded.content,
          metadata: {
            processId: proc.id,
            status: proc.status,
            exitCode: proc.exitCode,
          },
        };
      }

      case "cancel_process": {
        if (typeof args.processId !== "string" || !args.processId.trim()) {
          return {
            ok: false,
            title: "cancel_process (invalid processId)",
            output: 'Error: Argument "processId" is required and must be a string.',
          };
        }
        const proc = await ctx.executionManager.cancelProcess(
          args.processId.trim(),
        );
        if (!proc) {
          return {
            ok: false,
            title: `cancel_process ${args.processId}`,
            output: `Error: Process "${args.processId}" not found.`,
          };
        }

        return {
          ok: true,
          title: `Cancelled process ${proc.id}`,
          output: `Process ${proc.id} (PID ${proc.pid ?? "unknown"}) status is now: ${proc.status}.`,
          metadata: {
            processId: proc.id,
            pid: proc.pid,
            status: proc.status,
          },
        };
      }

      case "project_info": {
        const canonicalRoot = existsSync(ctx.projectDir)
          ? realpathSync(ctx.projectDir)
          : ctx.projectDir;
        const name = basename(canonicalRoot);
        let branch = "none";
        let vcs = "none";
        try {
          branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: canonicalRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
          }).trim();
          vcs = "git";
        } catch {
          // not a git repo
        }

        const topEntries = existsSync(canonicalRoot)
          ? readdirSync(canonicalRoot)
          : [];
        const filesCount = existsSync(canonicalRoot)
          ? walkProjectFiles(canonicalRoot, 5000).length
          : 0;

        const info = {
          name,
          rootPath: canonicalRoot,
          vcs,
          branch,
          fileCount: filesCount,
          topLevelEntries: topEntries.slice(0, 50),
        };

        return {
          ok: true,
          title: `Project info: ${name}`,
          output: JSON.stringify(info, null, 2),
          metadata: info,
        };
      }

      case "working_directory": {
        const canonicalRoot = existsSync(ctx.projectDir)
          ? realpathSync(ctx.projectDir)
          : ctx.projectDir;
        return {
          ok: true,
          title: "Working directory",
          output: canonicalRoot,
          metadata: { workingDirectory: canonicalRoot },
        };
      }

      case "git_status": {
        try {
          const out = execFileSync(
            "git",
            ["status", "--short", "--branch"],
            {
              cwd: ctx.projectDir,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 5000,
            },
          );
          return {
            ok: true,
            title: "Git status",
            output: out.trim() || "Working tree clean.",
          };
        } catch (err) {
          return {
            ok: false,
            title: "Git status",
            output: `Error running git status: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case "git_diff": {
        const gitArgs = ["diff"];
        if (args.staged) {
          gitArgs.push("--staged");
        }
        if (typeof args.path === "string" && args.path.trim()) {
          const pathCheck = resolveAndCheckProjectPath(ctx.projectDir, args.path);
          if (!pathCheck.insideProject) {
            await ctx.checkPermission("external_directory", pathCheck.resolvedPath, args);
          }
          gitArgs.push("--", pathCheck.relativePath);
        }

        try {
          const out = execFileSync("git", gitArgs, {
            cwd: ctx.projectDir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 8000,
          });
          const bounded = truncateToolOutput(
            out.trim() || "No diff changes.",
            "git_diff",
          );
          return {
            ok: true,
            title: "Git diff",
            output: bounded.content,
          };
        } catch (err) {
          return {
            ok: false,
            title: "Git diff",
            output: `Error running git diff: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      default:
        return {
          ok: false,
          title: `Unsupported tool ${toolName}`,
          output: `Error: Tool "${toolName}" is not implemented.`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      title: `${toolName} failed`,
      output: `Error executing ${toolName}: ${msg}`,
    };
  }
}
