/**
 * OS Credential Store for Entry Desktop V1
 *
 * Stores authentication tokens securely using the host OS credential facility:
 * - Windows: Windows DPAPI (`ConvertTo-SecureString` / `ConvertFrom-SecureString`)
 *   bound strictly to the current Windows user account (`CurrentUser` scope),
 *   stored at `%APPDATA%/Entry/Desktop/credentials.dpapi`.
 * - macOS: macOS Keychain via `/usr/bin/security` (`find-generic-password` / `add-generic-password` / `delete-generic-password`).
 * - Linux: `secret-tool` (libsecret / GNOME Keyring / KWallet) when available, with fallback to
 *   an AES-256-GCM encrypted file with strict `0600` user-only permissions (`~/.entry/desktop/credentials.enc`).
 *
 * Never stores plaintext tokens in world-readable files or embeds privileged backend secrets.
 */
import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

export interface StoredCredentials {
  accountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number | null;
  baseUrl: string;
}

const SERVICE_NAME = "entry-desktop-auth";
const ACCOUNT_NAME = "active-session";

export class OsCredentialStore {
  private readonly storageDir: string;
  private readonly dpapiPath: string;
  private readonly encPath: string;

  constructor(customDir?: string) {
    const defaultDir =
      process.platform === "win32" && process.env.APPDATA
        ? join(process.env.APPDATA, "Entry", "Desktop")
        : join(homedir(), ".entry", "desktop");
    this.storageDir =
      customDir ?? process.env.ENTRY_CREDENTIAL_DIR ?? defaultDir;
    mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    this.dpapiPath = join(this.storageDir, "credentials.dpapi");
    this.encPath = join(this.storageDir, "credentials.enc");
  }

  saveCredentials(creds: StoredCredentials): void {
    const serialized = JSON.stringify(creds);

    if (process.platform === "win32") {
      if (this.trySaveWindowsDpapi(serialized)) {
        return;
      }
    } else if (process.platform === "darwin") {
      if (this.trySaveMacKeychain(serialized)) {
        return;
      }
    } else if (process.platform === "linux") {
      if (this.trySaveLinuxSecretTool(serialized)) {
        return;
      }
    }

    this.saveEncryptedFile(serialized);
  }

  loadCredentials(): StoredCredentials | null {
    let raw: string | null = null;

    if (process.platform === "win32") {
      raw = this.tryLoadWindowsDpapi();
    } else if (process.platform === "darwin") {
      raw = this.tryLoadMacKeychain();
    } else if (process.platform === "linux") {
      raw = this.tryLoadLinuxSecretTool();
    }

    if (!raw) {
      raw = this.loadEncryptedFile();
    }

    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (!parsed.accessToken || !parsed.accountId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  clearCredentials(): void {
    if (process.platform === "win32") {
      try {
        if (existsSync(this.dpapiPath)) rmSync(this.dpapiPath, { force: true });
      } catch {
        // ignore
      }
    } else if (process.platform === "darwin") {
      try {
        execFileSync(
          "security",
          [
            "delete-generic-password",
            "-s",
            SERVICE_NAME,
            "-a",
            ACCOUNT_NAME,
          ],
          { stdio: "ignore", timeout: 3000 },
        );
      } catch {
        // ignore
      }
    } else if (process.platform === "linux") {
      try {
        execFileSync(
          "secret-tool",
          ["clear", "service", SERVICE_NAME, "account", ACCOUNT_NAME],
          { stdio: "ignore", timeout: 3000 },
        );
      } catch {
        // ignore
      }
    }

    try {
      if (existsSync(this.encPath)) rmSync(this.encPath, { force: true });
    } catch {
      // ignore
    }
  }

  private trySaveWindowsDpapi(serialized: string): boolean {
    try {
      const b64 = Buffer.from(serialized, "utf-8").toString("base64");
      const escapedPath = this.dpapiPath.replace(/'/g, "''");
      const psScript = [
        `$bytes = [Convert]::FromBase64String('${b64}');`,
        `$plain = [System.Text.Encoding]::UTF8.GetString($bytes);`,
        `$sec = ConvertTo-SecureString $plain -AsPlainText -Force;`,
        `$enc = ConvertFrom-SecureString $sec;`,
        `[System.IO.File]::WriteAllText('${escapedPath}', $enc);`,
      ].join(" ");
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          psScript,
        ],
        { stdio: "ignore", timeout: 5000, windowsHide: true },
      );
      return existsSync(this.dpapiPath);
    } catch {
      return false;
    }
  }

  private tryLoadWindowsDpapi(): string | null {
    if (!existsSync(this.dpapiPath)) return null;
    try {
      const escapedPath = this.dpapiPath.replace(/'/g, "''");
      const psScript = [
        `$enc = [System.IO.File]::ReadAllText('${escapedPath}').Trim();`,
        `$sec = ConvertTo-SecureString $enc;`,
        `$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);`,
        `try {`,
        `  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr);`,
        `  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain));`,
        `} finally {`,
        `  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr);`,
        `}`,
      ].join(" ");
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          psScript,
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
          windowsHide: true,
        },
      ).trim();
      if (!out) return null;
      return Buffer.from(out, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }

  private trySaveMacKeychain(serialized: string): boolean {
    try {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-U",
          "-s",
          SERVICE_NAME,
          "-a",
          ACCOUNT_NAME,
          "-w",
          serialized,
        ],
        { stdio: "ignore", timeout: 3000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private tryLoadMacKeychain(): string | null {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        },
      ).trim();
    } catch {
      return null;
    }
  }

  private trySaveLinuxSecretTool(serialized: string): boolean {
    try {
      execFileSync(
        "secret-tool",
        [
          "store",
          "--label=Entry Desktop Auth",
          "service",
          SERVICE_NAME,
          "account",
          ACCOUNT_NAME,
        ],
        {
          input: serialized,
          stdio: ["pipe", "ignore", "ignore"],
          timeout: 2000,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private tryLoadLinuxSecretTool(): string | null {
    try {
      const out = execFileSync(
        "secret-tool",
        ["lookup", "service", SERVICE_NAME, "account", ACCOUNT_NAME],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        },
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private deriveMachineKey(): Buffer {
    let username = "entry-user";
    try {
      username = userInfo().username;
    } catch {
      // ignore
    }
    const material = `entry-desktop-v1:${hostname()}:${username}:${homedir()}`;
    return createHash("sha256").update(material).digest();
  }

  private saveEncryptedFile(serialized: string): void {
    const key = this.deriveMachineKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(serialized, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const payload = JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    });
    mkdirSync(dirname(this.encPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.encPath, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(this.encPath, 0o600);
    } catch {
      // Windows ignores POSIX mode bits
    }
  }

  private loadEncryptedFile(): string | null {
    if (!existsSync(this.encPath)) return null;
    try {
      const raw = readFileSync(this.encPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        v: number;
        iv: string;
        tag: string;
        data: string;
      };
      const key = this.deriveMachineKey();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(parsed.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf-8");
    } catch {
      return null;
    }
  }
}
