import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SECRET_KEYS = /api[_-]?key|authorization|access|refresh|id[_-]?token|token|secret|password|client[_-]?secret|code[_-]?verifier|verifier|state|^code$/i;
const TOKEN_QUERY_PARAM = /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|client_secret|code|state|code_verifier|verifier)=)[^&#\s]+/gi;
const AUTHORIZATION_VALUE = /\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_LIKE_VALUE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g;
const TOKEN_ASSIGNMENT = /\b((?:access|refresh|id)[_-]?token|api[_-]?key|apikey|client[_-]?secret|token|code[_-]?verifier|verifier|state|code)\s*[:=]\s*["']?[^"'\s&,;]+/gi;

export interface DebugLoggerOptions {
  extensionRoot: string;
  debug: boolean;
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(TOKEN_QUERY_PARAM, "$1[REDACTED]")
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]")
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(TOKEN_ASSIGNMENT, "$1=[REDACTED]")
    .replace(JWT_LIKE_VALUE, "[REDACTED]");
}

export function redactForDebugLog(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map((entry) => redactForDebugLog(entry));
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name,
      message: redactSensitiveString(value.message),
    };
    if (value.stack) output.stack = redactSensitiveString(value.stack);
    if (value.cause !== undefined) output.cause = redactForDebugLog(value.cause);
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === "cause") continue;
      output[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : redactForDebugLog(nestedValue);
    }
    return output;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : redactForDebugLog(nestedValue);
    }
    return output;
  }
  return value;
}

function stringifyDetails(details: unknown): string {
  if (details === undefined) return "";
  try {
    return ` ${JSON.stringify(redactForDebugLog(details))}`;
  } catch {
    return " [unserializable-details]";
  }
}

export class DebugLogger {
  private readonly debugDir: string;
  private readonly logPath: string;
  private debugDirEnsured = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: DebugLoggerOptions) {
    this.debugDir = join(options.extensionRoot, "debug");
    this.logPath = join(this.debugDir, "debug.log");
  }

  debug(event: string, details?: unknown): void {
    this.write("debug", event, details);
  }

  warn(event: string, details?: unknown): void {
    this.write("warn", event, details);
  }

  error(event: string, details?: unknown): void {
    this.write("error", event, details);
  }

  flush(): Promise<void> {
    return this.writeQueue.catch(() => undefined);
  }

  private async ensureDebugDir(): Promise<void> {
    if (this.debugDirEnsured) return;
    await mkdir(this.debugDir, { recursive: true });
    this.debugDirEnsured = true;
  }

  private write(level: "debug" | "warn" | "error", event: string, details?: unknown): void {
    if (!this.options.debug) return;
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, extension: "omon-kiro-provider", event })}${stringifyDetails(details)}\n`;
    this.writeQueue = this.writeQueue.then(
      () => this.appendLine(line),
      () => this.appendLine(line),
    );
    void this.writeQueue.catch(() => {
      // Debug logging must never affect provider behavior or terminal output.
    });
  }

  private async appendLine(line: string): Promise<void> {
    await this.ensureDebugDir();
    await appendFile(this.logPath, line, "utf-8");
  }
}
