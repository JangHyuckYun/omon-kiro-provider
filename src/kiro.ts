import { createHash, randomUUID } from "node:crypto";

import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

import type { ExtensionConfig } from "./config.js";
import { redactSensitiveString } from "./debug-logger.js";
import type { DebugLogger } from "./debug-logger.js";
import { ByteQueue, parseEventFrame, type EventPayload, type JsonRecord } from "./eventstream.js";
import { omitAuthorizationHeaders } from "./headers.js";
import { isRecord, optionalString, KIRO_PROFILE_ARN_HEADER, readJsonResponse } from "./shared/index.js";

interface KiroRuntimeState {
  cwd?: string;
}

type KiroProviderDiagnostic = {
  category: "auth" | "invalid_request" | "provider_unavailable" | "unknown";
  httpStatus: number;
  evidence: "structured_status";
};

type NativeSimpleStreamOptions = SimpleStreamOptions & {
  affinitySessionId?: string;
  fetch?: typeof globalThis.fetch;
};

type NativeAssistantMessage = AssistantMessage & {
  providerDiagnostic?: KiroProviderDiagnostic;
  abortSource?: "provider";
};

interface KiroToolSpecification {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: unknown };
  };
}

interface KiroToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: Array<{ text: string } | { json: unknown }>;
}

interface KiroUserInputMessageContext {
  tools?: KiroToolSpecification[];
  toolResults?: KiroToolResult[];
}

interface KiroUserInputMessage {
  userInputMessage: {
    content: string;
    modelId: string;
    origin?: "AI_EDITOR" | "KIRO_CLI";
    userInputMessageContext?: KiroUserInputMessageContext;
  };
}

interface KiroAssistantResponseMessage {
  assistantResponseMessage: {
    messageId?: string;
    content: string;
    toolUses?: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>;
  };
}

type KiroConversationMessage = KiroUserInputMessage | KiroAssistantResponseMessage;

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: KiroUserInputMessage;
    history: KiroConversationMessage[];
    agentContinuationId?: string;
    agentTaskType?: "vibe" | string;
  };
  profileArn?: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    };
}

interface KiroStreamState {
  textContentIndex?: number;
  thinkingContentIndex?: number;
  hasText: boolean;
  hasToolCalls: boolean;
  toolCallsById: Map<string, KiroStreamingToolCall>;
  totalContentLength: number;
  contextUsagePercentage: number;
  usage?: Usage;
  /** True once the first tool-use event arrives. Afterwards text/thinking
   * deltas are buffered and tool inputs are accumulated so the final event
   * stream emits strictly sequential content blocks (the engine's tool-call
   * recovery middleware rejects interleaved/out-of-order native tool calls). */
  buffering: boolean;
  bufferedContent: Array<
    | { kind: "text" | "thinking"; delta: string }
    | { kind: "tool"; toolUseId: string }
  >;
}

interface KiroStreamingToolCall {
  contentIndex: number;
  toolCall: ToolCall;
  inputBuffer: string;
  ended: boolean;
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const API_MAX_OUTPUT_TOKENS = 200_000;
const MAX_EVENT_FRAME_BYTES = 32 * 1024 * 1024;
const KIRO_NAMESPACE = "34f7193f-561d-4050-bc84-9547d953d6bf";
const KIRO_STREAMING_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const KIRO_CODEWHISPERER_SDK_USER_AGENT = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0";
const KIRO_CODEWHISPERER_AMZ_USER_AGENT = "aws-sdk-js/3.0.0 kiro-ide/1.0.0";
const KIRO_Q_SDK_USER_AGENT = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.14474 os/windows lang/rust/1.92.0 md/appVersion-2.3.0 app/AmazonQ-For-CLI";
const KIRO_Q_AMZ_USER_AGENT = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.14474 os/windows lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";
const KIRO_CLI_CONTEXT_BLOCK_PATTERN = /--- CONTEXT ENTRY BEGIN ---[\s\S]*?--- CONTEXT ENTRY END ---\s*/g;
const KIRO_CLI_USER_MESSAGE_PATTERN = /--- USER MESSAGE BEGIN ---([\s\S]*?)--- USER MESSAGE END ---/g;

export type KiroCredentialMode = "managed" | "env-token" | "static-config";

export interface KiroAuthFailureMetadata {
  providerId: string;
  status: number;
  reason: "unauthorized" | "auth_expired" | "auth_rejected" | "quota_or_entitlement" | "forbidden" | "missing_token" | "http_error";
  refreshable: boolean;
  credentialMode: KiroCredentialMode;
  retryAfterMs?: number;
}

class KiroProviderError extends Error {
  readonly providerDiagnostic?: KiroProviderDiagnostic;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    providerDiagnostic?: KiroProviderDiagnostic,
    retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    const retryMarker = retryAfterMs === undefined ? "" : ` (retry-after-ms: ${retryAfterMs})`;
    super(
      redactSensitiveString(`${message}${retryMarker}`),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "KiroProviderError";
    this.providerDiagnostic = providerDiagnostic;
    this.retryAfterMs = retryAfterMs;
  }
}

export class KiroAuthFailureError extends KiroProviderError {
  readonly kiroAuth: KiroAuthFailureMetadata;

  constructor(message: string, metadata: KiroAuthFailureMetadata, options?: { cause?: unknown }) {
    super(message, providerDiagnosticForStatus(metadata.status), metadata.retryAfterMs, options);
    this.name = "KiroAuthFailureError";
    this.kiroAuth = { ...metadata };
  }
}

interface ResolvedKiroCredential {
  apiKey: string;
  mode: KiroCredentialMode;
}

function isKiroCliDefaultAgentInstruction(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("Follow this instruction: # Kiro CLI Default Agent") && normalized.includes("## Key Capabilities") && normalized.includes("### Code Intelligence");
}

function isKiroCliInstructionAck(text: string): boolean {
  return text.trim() === "I will fully incorporate this information when generating my responses, and explicitly acknowledge relevant parts of the summary when answering questions.";
}

function pruneKiroCliPromptScaffolding(text: string): string {
  const userMessages = [...text.matchAll(KIRO_CLI_USER_MESSAGE_PATTERN)].map((match) => match[1]?.trim()).filter((entry): entry is string => Boolean(entry));
  if (userMessages.length > 0) return userMessages.join("\n\n").trim();
  const withoutContextEntries = text.replace(KIRO_CLI_CONTEXT_BLOCK_PATTERN, "").trim();
  if (isKiroCliDefaultAgentInstruction(withoutContextEntries)) return "";
  return withoutContextEntries;
}

function textFromContent(content: string | (TextContent | ImageContent)[], options?: { pruneKiroCliScaffolding?: boolean }): string {
  const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "[image omitted]")).join("");
  return options?.pruneKiroCliScaffolding ? pruneKiroCliPromptScaffolding(text) : text;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const TOP_LEVEL_SCHEMA_COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

function schemaProperties(schema: JsonRecord): JsonRecord {
  return isRecord(schema.properties) ? schema.properties : {};
}

function schemaRequired(schema: JsonRecord): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mergePropertySchema(current: unknown, incoming: unknown): unknown {
  if (current === undefined) return incoming;
  if (JSON.stringify(current) === JSON.stringify(incoming)) return current;
  const alternatives = isRecord(current) && Array.isArray(current.anyOf)
    ? [...current.anyOf]
    : [current];
  if (!alternatives.some((entry) => JSON.stringify(entry) === JSON.stringify(incoming))) {
    alternatives.push(incoming);
  }
  return { anyOf: alternatives };
}

function mergeObjectSchemas(schemas: readonly JsonRecord[], mode: "union" | "intersection"): JsonRecord {
  const properties: JsonRecord = {};
  const requiredSets = schemas.map((schema) => new Set(schemaRequired(schema)));
  for (const schema of schemas) {
    for (const [name, property] of Object.entries(schemaProperties(schema))) {
      properties[name] = mergePropertySchema(properties[name], property);
    }
  }
  const required = mode === "intersection"
    ? [...new Set(requiredSets.flatMap((set) => [...set]))]
    : requiredSets.length === 0
      ? []
      : [...requiredSets[0]].filter((name) => requiredSets.every((set) => set.has(name)));
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(schemas.every((schema) => schema.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
}

function normalizeTopLevelToolSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return { type: "object", properties: {} };
  const base: JsonRecord = { ...schema };
  const grouped: JsonRecord[] = [];
  for (const combinator of TOP_LEVEL_SCHEMA_COMBINATORS) {
    const variants = base[combinator];
    delete base[combinator];
    if (!Array.isArray(variants)) continue;
    const objectVariants = variants.filter(isRecord);
    if (objectVariants.length === 0) continue;
    grouped.push(mergeObjectSchemas(
      objectVariants,
      combinator === "allOf" ? "intersection" : "union",
    ));
  }
  if (grouped.length === 0) return schema;
  const normalized = mergeObjectSchemas([base, ...grouped], "intersection");
  return {
    ...base,
    ...normalized,
    type: "object",
  };
}

function toolSchemaForRequest(tool: Tool): unknown {
  return normalizeTopLevelToolSchema(tool.parameters);
}

function descriptionIncludesAll(description: string, terms: string[]): boolean {
  return terms.every((term) => description.includes(term));
}

function isKiroCliInjectedTool(tool: Tool): boolean {
  const description = tool.description.toLowerCase();
  if (tool.name === "code") return descriptionIncludesAll(description, ["code intelligence", "ast"]);
  if (tool.name === "dummy") return descriptionIncludesAll(description, ["dummy tool", "list of available tools"]);
  if (tool.name === "execute_cmd") return description.includes("windows command");
  if (tool.name === "fs_read") return descriptionIncludesAll(description, ["available modes", "line", "directory"]);
  if (tool.name === "fs_write") return description.includes("str_replace") || description.includes("file_text");
  if (tool.name === "glob") return descriptionIncludesAll(description, ["totalfiles", "filepath"]);
  if (tool.name === "grep") return descriptionIncludesAll(description, ["semantic code understanding", "rg", "ag"]);
  if (tool.name === "introspect") return descriptionIncludesAll(description, ["chat application's own features", "slash commands"]);
  if (tool.name === "report_issue") return descriptionIncludesAll(description, ["pre-filled", "conversation transcript", "chat request ids"]);
  if (tool.name === "session") return descriptionIncludesAll(description, ["adjust session settings", "introspect tool first"]);
  if (tool.name === "use_aws") return descriptionIncludesAll(description, ["aws cli", "service", "operation"]);
  if (tool.name === "use_subagent") return description.includes("critical delegation tool");
  if (tool.name === "web_fetch") return descriptionIncludesAll(description, ["selective", "truncated", "full"]);
  if (tool.name === "web_search") return descriptionIncludesAll(description, ["websearch", "outside the model's training data"]);
  if (tool.name === "shell") return description.includes("command");
  return false;
}

function buildKiroTools(tools: Tool[] | undefined): KiroToolSpecification[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const filteredTools = tools.filter((tool) => !isKiroCliInjectedTool(tool));
  if (filteredTools.length === 0) return undefined;
  return filteredTools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description.trim() || `Tool: ${tool.name}`,
      inputSchema: { json: toolSchemaForRequest(tool) },
    },
  }));
}

function assistantText(message: Extract<Context["messages"][number], { role: "assistant" }>): string {
  return message.content
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => (part.type === "text" ? part.text : part.thinking))
    .join("\n")
    .trim();
}

/** Normalize a cross-provider compound call ID to the primary ID accepted by Kiro. */
function normalizeToolUseId(id: string): string {
  const pipeIndex = id.indexOf("|");
  return pipeIndex === -1 ? id : id.slice(0, pipeIndex);
}

function assistantToolUses(message: Extract<Context["messages"][number], { role: "assistant" }>): Array<{ toolUseId: string; name: string; input: Record<string, unknown> }> | undefined {
  const toolUses = message.content
    .filter((part): part is ToolCall => part.type === "toolCall")
    .map((part) => ({ toolUseId: normalizeToolUseId(part.id), name: part.name, input: parseToolInput(part.arguments) }));
  return toolUses.length > 0 ? toolUses : undefined;
}

function toolResultFromMessage(message: Extract<Context["messages"][number], { role: "toolResult" }>): KiroToolResult {
  return {
    toolUseId: normalizeToolUseId(message.toolCallId),
    status: message.isError ? "error" : "success",
    content: [{ text: textFromContent(message.content) }],
  };
}

function makeUserMessage(content: string, modelId: string, context?: KiroUserInputMessageContext, current = false): KiroUserInputMessage {
  const trimmedContent = content.trim();
  const hasToolResults = Boolean(context?.toolResults?.length);
  const userInputMessage: KiroUserInputMessage["userInputMessage"] = {
    content: trimmedContent || (hasToolResults ? "" : "continue"),
    modelId,
  };
  if (current) userInputMessage.origin = "AI_EDITOR";
  if (context && (context.tools?.length || context.toolResults?.length)) userInputMessage.userInputMessageContext = context;
  return { userInputMessage };
}

function convertMessages(context: Context, modelId: string): { history: KiroConversationMessage[]; currentMessage: KiroUserInputMessage } {
  const history: KiroConversationMessage[] = [];
  const tools = buildKiroTools(context.tools);
  let pendingUserContent: string[] = [];
  let pendingToolResults: KiroToolResult[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let currentMessage: KiroUserInputMessage | null = null;
  let skippedKiroCliInstruction = false;

  const flushUser = (): void => {
    const userContext: KiroUserInputMessageContext = {};
    if (pendingToolResults.length > 0) userContext.toolResults = pendingToolResults;
    const message = makeUserMessage(pendingUserContent.join("\n\n"), modelId, userContext);
    history.push(message);
    currentMessage = message;
    pendingUserContent = [];
    pendingToolResults = [];
  };

  const flushRole = (): void => {
    if (currentRole === "user") flushUser();
    currentRole = null;
  };

  for (const message of context.messages) {
    if (message.role === "user") {
      const userContent = textFromContent(message.content, { pruneKiroCliScaffolding: true });
      if (!userContent) {
        skippedKiroCliInstruction = true;
        continue;
      }
      if (currentRole !== "user") flushRole();
      currentRole = "user";
      pendingUserContent.push(userContent);
      skippedKiroCliInstruction = false;
      continue;
    }

    if (message.role === "toolResult") {
      if (currentRole !== "user") flushRole();
      currentRole = "user";
      pendingToolResults.push(toolResultFromMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      const toolUses = assistantToolUses(message);
      const assistantContent = assistantText(message);
      if (skippedKiroCliInstruction && !toolUses && isKiroCliInstructionAck(assistantContent)) {
        skippedKiroCliInstruction = false;
        continue;
      }
      skippedKiroCliInstruction = false;
      flushRole();
      const content = assistantContent || (toolUses ? "" : "...");
      history.push({
        assistantResponseMessage: {
          content,
          ...(toolUses ? { messageId: message.responseId ?? uuidFromHash(`${message.model}:${message.timestamp}:${toolUses.map((toolUse) => toolUse.toolUseId).join(",")}`), toolUses } : {}),
        },
      });
    }
  }

  flushRole();

  if (history.length > 0 && "userInputMessage" in history[history.length - 1]) {
    currentMessage = history.pop() as KiroUserInputMessage;
  }

  if (!currentMessage) {
    currentMessage = makeUserMessage("Continue", modelId);
  }

  const currentContext = currentMessage.userInputMessage.userInputMessageContext ?? {};
  if (tools && tools.length > 0) currentContext.tools = tools;
  if (Object.keys(currentContext).length > 0) currentMessage.userInputMessage.userInputMessageContext = currentContext;
  currentMessage.userInputMessage.origin = "AI_EDITOR";
  currentMessage.userInputMessage.modelId = modelId;

  for (const item of history) {
    if ("userInputMessage" in item) {
      item.userInputMessage.modelId = modelId;
      delete item.userInputMessage.origin;
      if (item.userInputMessage.userInputMessageContext?.tools) delete item.userInputMessage.userInputMessageContext.tools;
      if (item.userInputMessage.userInputMessageContext && Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
        delete item.userInputMessage.userInputMessageContext;
      }
    }
  }

  return { history, currentMessage };
}

function uuidFromHash(value: string): string {
  const bytes = createHash("sha1").update(`${KIRO_NAMESPACE}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildSystemPrefix(context: Context): string {
  const systemPrompt = typeof context.systemPrompt === "string" ? context.systemPrompt.trim() : "";
  if (!systemPrompt || isKiroCliDefaultAgentInstruction(systemPrompt)) return "";
  return `<Pi system instructions>\n${systemPrompt}\n</Pi system instructions>`;
}

function firstUserConversationContent(history: KiroConversationMessage[], currentMessage: KiroUserInputMessage): string {
  const firstUserHistoryItem = history.find((item): item is KiroUserInputMessage => "userInputMessage" in item);
  return firstUserHistoryItem?.userInputMessage.content || currentMessage.userInputMessage.content;
}

function prependSystemInstructionHistory(history: KiroConversationMessage[], systemPrefix: string, modelId: string): void {
  if (!systemPrefix) return;
  history.unshift(
    makeUserMessage(systemPrefix, modelId),
    {
      assistantResponseMessage: {
        content: "Understood. I will follow the Pi system instructions.",
      },
    },
  );
}

function isAmazonQEndpoint(config: ExtensionConfig): boolean {
  if (config.endpoint === "amazonq") return true;
  try {
    return new URL(config.upstreamUrl).hostname.toLowerCase() === "q.us-east-1.amazonaws.com";
  } catch {
    return false;
  }
}

function setUserMessageOrigin(history: KiroConversationMessage[], currentMessage: KiroUserInputMessage, origin: "AI_EDITOR" | "KIRO_CLI"): void {
  currentMessage.userInputMessage.origin = origin;
  for (const item of history) {
    if ("userInputMessage" in item) item.userInputMessage.origin = origin;
  }
}

function resolveMaxTokens(model: Model<Api>, options?: SimpleStreamOptions): number {
  const requested = options?.maxTokens ?? Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  return Math.max(1, Math.min(requested, API_MAX_OUTPUT_TOKENS));
}

function getHeaderCaseInsensitive(headers: ProviderHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const normalizedName = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName && typeof headerValue === "string" && headerValue.trim()) return headerValue.trim();
  }
  return undefined;
}

function omitInternalKiroHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        entry[0].toLowerCase() !== KIRO_PROFILE_ARN_HEADER && entry[1] !== null,
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildRequest(model: Model<Api>, context: Context, config: ExtensionConfig, options?: NativeSimpleStreamOptions): KiroRequest {
  const { history, currentMessage } = convertMessages(context, model.id);
  const firstContent = firstUserConversationContent(history, currentMessage);
  prependSystemInstructionHistory(history, buildSystemPrefix(context), model.id);
  const amazonQEndpoint = isAmazonQEndpoint(config);
  if (amazonQEndpoint) setUserMessageOrigin(history, currentMessage, "KIRO_CLI");
  const profileArn = getHeaderCaseInsensitive(options?.headers, KIRO_PROFILE_ARN_HEADER) ?? config.profileArn;
  const conversationIdentity = options?.affinitySessionId?.trim() || firstContent || currentMessage.userInputMessage.content;
  const conversationState: KiroRequest["conversationState"] = {
    chatTriggerType: "MANUAL",
    conversationId: conversationIdentity ? uuidFromHash(conversationIdentity) : randomUUID(),
    currentMessage,
    history,
  };
  if (amazonQEndpoint) {
    conversationState.agentContinuationId = randomUUID();
    conversationState.agentTaskType = "vibe";
  }
  const request: KiroRequest = { conversationState };
  if (profileArn) request.profileArn = profileArn;

  const maxTokens = resolveMaxTokens(model, options);
  if (!amazonQEndpoint && (maxTokens || options?.temperature !== undefined)) {
    request.inferenceConfig = { maxTokens };
    if (options?.temperature !== undefined) request.inferenceConfig.temperature = options.temperature;
  }
  return request;
}

function missingTokenError(envVarName: string, providerId: string): KiroAuthFailureError {
  return new KiroAuthFailureError(
    `No Kiro access token configured. Static environment token mode (${envVarName}) is unmanaged and non-rotating; set ${envVarName}, run /login ${providerId}, or enable pi-multi-auth credentials for ${providerId}.`,
    {
      providerId,
      status: 0,
      reason: "missing_token",
      refreshable: false,
      credentialMode: "env-token",
    },
  );
}

function resolveKiroCredential(config: ExtensionConfig, options?: SimpleStreamOptions): ResolvedKiroCredential {
  const optionKey = options?.apiKey;
  if (optionKey && optionKey !== config.apiKey) return { apiKey: optionKey, mode: "managed" };
  if (ENV_VAR_PATTERN.test(config.apiKey)) {
    const envKey = process.env[config.apiKey];
    if (envKey) return { apiKey: envKey, mode: "env-token" };
    if (optionKey) return { apiKey: optionKey, mode: "managed" };
    throw missingTokenError(config.apiKey, config.providerId);
  }
  if (optionKey) return { apiKey: optionKey, mode: "managed" };
  return { apiKey: config.apiKey, mode: "static-config" };
}

export function buildHeaders(config: ExtensionConfig, apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
  const amazonQEndpoint = isAmazonQEndpoint(config);
  const headers: Record<string, string> = amazonQEndpoint ? {
    "Content-Type": "application/x-amz-json-1.0",
    Accept: "*/*",
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_Q_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_Q_AMZ_USER_AGENT,
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "x-amzn-codewhisperer-optout": "false",
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(config.headers)),
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(options?.headers)),
  } : {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_CODEWHISPERER_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_CODEWHISPERER_AMZ_USER_AGENT,
    "Amz-Sdk-Request": "attempt=1; max=3",
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "x-amzn-bedrock-cache-control": "enable",
    "anthropic-beta": "prompt-caching-2024-07-31",
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(config.headers)),
    ...omitAuthorizationHeaders(omitInternalKiroHeaders(options?.headers)),
  };
  // CodeWhisperer rejects Kiro API keys (ksk_ prefix) unless the token
  // type is declared; OAuth bearer tokens are unaffected by this header.
  if (apiKey.startsWith("ksk_")) headers.tokentype = "API_KEY";
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function createRequestSignal(
  options: SimpleStreamOptions | undefined,
  timeoutMs: number,
): { signal: AbortSignal; providerTimedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    if (!disposed) {
      timedOut = true;
      controller.abort(new Error(`Kiro request timed out after ${timeoutMs}ms.`));
    }
  }, timeoutMs);
  const abortFromParent = (): void => {
    if (!disposed) controller.abort(options?.signal?.reason ?? new Error("Kiro request aborted."));
  };
  if (options?.signal?.aborted) abortFromParent();
  options?.signal?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    providerTimedOut: () => timedOut,
    dispose() {
      disposed = true;
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Kiro request aborted.", "AbortError");
}

function awaitAbortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (result: T) => void) => (result: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => fail(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(finish(resolve), fail);
  });
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function providerDiagnosticForStatus(status: number): KiroProviderDiagnostic | undefined {
  if (!Number.isInteger(status) || status < 400 || status > 599) return undefined;
  const category = status === 401
    ? "auth"
    : status === 400
      ? "invalid_request"
      : status >= 500
        ? "provider_unavailable"
        : "unknown";
  return { category, httpStatus: status, evidence: "structured_status" };
}

function retryAfterMsFromHeaders(status: number, headers: Headers): number | undefined {
  if (status !== 429) return undefined;
  const explicitMilliseconds = headers.get("retry-after-ms");
  if (explicitMilliseconds && /^\d+(?:\.\d+)?$/.test(explicitMilliseconds)) {
    return Math.ceil(Number(explicitMilliseconds));
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1_000;
  const retryAt = Date.parse(retryAfter);
  if (!Number.isFinite(retryAt)) return undefined;
  const responseDate = headers.get("date");
  const referenceTime = responseDate && Number.isFinite(Date.parse(responseDate))
    ? Date.parse(responseDate)
    : Date.now();
  return Math.max(0, retryAt - referenceTime);
}

function extractErrorMessage(payload: JsonRecord, status: number): string {
  if (typeof payload.message === "string" && payload.message.trim()) return redactSensitiveString(payload.message.trim());
  if (typeof payload.error === "string" && payload.error.trim()) return redactSensitiveString(payload.error.trim());
  if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) return redactSensitiveString(payload.error.message.trim());
  return `Kiro request failed with HTTP ${status}.`;
}

function payloadSearchText(payload: JsonRecord): string {
  try {
    return JSON.stringify(payload).toLowerCase();
  } catch {
    return "";
  }
}

function classifyAuthReason(status: number, payload: JsonRecord): KiroAuthFailureMetadata["reason"] {
  if (status === 401) return "unauthorized";
  const text = payloadSearchText(payload);
  if (/quota|entitlement|subscription|billing|plan|limit exceeded|too many requests/.test(text)) return "quota_or_entitlement";
  if (/auth[_-]?expired|token expired|expired token|expired.*token/.test(text)) return "auth_expired";
  if (/auth[_-]?rejected|token rejected|invalid token|invalid[_-]?grant|unauthorized/.test(text)) return "auth_rejected";
  return status === 403 ? "forbidden" : "http_error";
}

function isPotentiallyRefreshable(reason: KiroAuthFailureMetadata["reason"]): boolean {
  return reason === "unauthorized" || reason === "auth_expired" || reason === "auth_rejected";
}

function authFailureMessage(status: number, reason: KiroAuthFailureMetadata["reason"], credentialMode: KiroCredentialMode, refreshable: boolean): string {
  const unmanagedSuffix = credentialMode === "env-token" ? " Static environment token mode is unmanaged and non-rotating; refresh retry is not available for this credential source." : "";
  return `Kiro request failed with HTTP ${status} (${reason}); refreshable=${refreshable}; credentialMode=${credentialMode}.${unmanagedSuffix}`;
}

export function classifyKiroHttpFailure(
  status: number,
  payload: JsonRecord,
  credentialMode: KiroCredentialMode,
  providerId = "kiro",
  retryAfterMs?: number,
): Error {
  const reason = classifyAuthReason(status, payload);
  const potentiallyRefreshable = isPotentiallyRefreshable(reason);
  const metadata: KiroAuthFailureMetadata = {
    providerId,
    status,
    reason,
    refreshable: potentiallyRefreshable && credentialMode === "managed",
    credentialMode,
    retryAfterMs,
  };
  if (status === 401 || status === 403) {
    return new KiroAuthFailureError(authFailureMessage(status, reason, credentialMode, metadata.refreshable), metadata);
  }
  return new KiroProviderError(
    extractErrorMessage(payload, status),
    providerDiagnosticForStatus(status),
    retryAfterMs,
  );
}

function getKiroAuthFailure(error: unknown): KiroAuthFailureMetadata | undefined {
  return error instanceof KiroAuthFailureError ? error.kiroAuth : undefined;
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildUsage(model: Model<Api>, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): Usage {
  const usage: Usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function usageFromMetrics(model: Model<Api>, metrics: JsonRecord): Usage | undefined {
  const input = numberFrom(metrics.inputTokens);
  const output = numberFrom(metrics.outputTokens);
  const cacheRead = numberFrom(metrics.cacheReadTokens);
  const cacheWrite = numberFrom(metrics.cacheCreationTokens);
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return undefined;
  return buildUsage(model, { input, output, cacheRead, cacheWrite });
}

function estimatedUsage(model: Model<Api>, state: KiroStreamState): Usage | undefined {
  const output = state.totalContentLength > 0 ? Math.max(1, Math.floor(state.totalContentLength / 4)) : 0;
  const input = state.contextUsagePercentage > 0 ? Math.floor((state.contextUsagePercentage * model.contextWindow) / 100) : 0;
  if (input <= 0 && output <= 0) return undefined;
  return buildUsage(model, { input, output, cacheRead: 0, cacheWrite: 0 });
}

function closeBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking"): void {
  const contentIndex = kind === "text" ? state.textContentIndex : state.thinkingContentIndex;
  if (contentIndex === undefined) return;
  const block = output.content[contentIndex];
  let content = "";
  if (kind === "text" && block?.type === "text") content = block.text;
  else if (kind === "thinking" && block?.type === "thinking") content = block.thinking;
  stream.push({ type: kind === "text" ? "text_end" : "thinking_end", contentIndex, content, partial: output });
  if (kind === "text") state.textContentIndex = undefined;
  else state.thinkingContentIndex = undefined;
}

function closeTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  closeBlock(stream, output, state, "text");
}

function closeThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  closeBlock(stream, output, state, "thinking");
}

function ensureBlock(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking"): number {
  const existingIndex = kind === "text" ? state.textContentIndex : state.thinkingContentIndex;
  if (existingIndex !== undefined) return existingIndex;
  const contentIndex = output.content.length;
  if (kind === "text") {
    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex, partial: output });
    state.textContentIndex = contentIndex;
  } else {
    output.content.push({ type: "thinking", thinking: "" });
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    state.thinkingContentIndex = contentIndex;
  }
  return contentIndex;
}

function emitDelta(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, kind: "text" | "thinking", delta: string): void {
  if (!delta) return;
  if (kind === "text") closeThinkingBlock(stream, output, state);
  else closeTextBlock(stream, output, state);
  const contentIndex = ensureBlock(stream, output, state, kind);
  const block = output.content[contentIndex];
  if (kind === "text" && block?.type === "text") block.text += delta;
  else if (kind === "thinking" && block?.type === "thinking") block.thinking += delta;
  if (kind === "text") state.hasText = true;
  state.totalContentLength += delta.length;
  stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex, delta, partial: output });
}

function parseStreamingToolInput(toolCall: ToolCall, existingInputBuffer: string, rawInput: unknown): { delta: string; inputBuffer: string } {
  if (rawInput === undefined) return { delta: "", inputBuffer: existingInputBuffer };
  if (typeof rawInput === "string") {
    if (!rawInput) return { delta: "", inputBuffer: existingInputBuffer };
    const parsedInput = parseToolInput(rawInput);
    if (Object.keys(parsedInput).length > 0) {
      toolCall.arguments = parsedInput;
      return { delta: rawInput, inputBuffer: rawInput };
    }

    const inputBuffer = `${existingInputBuffer}${rawInput}`;
    toolCall.arguments = parseToolInput(inputBuffer);
    return { delta: rawInput, inputBuffer };
  }

  if (isRecord(rawInput)) {
    if (Object.keys(rawInput).length === 0) return { delta: "", inputBuffer: existingInputBuffer };
    const inputBuffer = JSON.stringify(rawInput);
    toolCall.arguments = rawInput;
    return { delta: inputBuffer, inputBuffer };
  }

  return { delta: "", inputBuffer: existingInputBuffer };
}

function ensureToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, payload: JsonRecord): KiroStreamingToolCall {
  const toolUseId = optionalString(payload.toolUseId) ?? `kiro-tool-${state.toolCallsById.size}`;
  const existing = state.toolCallsById.get(toolUseId);
  if (existing) {
    const name = optionalString(payload.name);
    if (name && existing.toolCall.name === "tool") existing.toolCall.name = name;
    return existing;
  }

  const toolCall: ToolCall = {
    type: "toolCall",
    id: toolUseId,
    name: optionalString(payload.name) ?? "tool",
    arguments: {},
  };
  state.hasToolCalls = true;
  closeTextBlock(stream, output, state);
  closeThinkingBlock(stream, output, state);
  const contentIndex = state.buffering ? -1 : output.content.length;
  if (!state.buffering) {
    output.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
  }
  const entry: KiroStreamingToolCall = {
    contentIndex,
    toolCall,
    inputBuffer: "",
    ended: false,
  };
  state.toolCallsById.set(toolUseId, entry);
  return entry;
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, payload: JsonRecord): void {
  const toolUseId = optionalString(payload.toolUseId) ?? `kiro-tool-${state.toolCallsById.size}`;
  const isNew = !state.toolCallsById.has(toolUseId);
  const entry = ensureToolCall(stream, output, state, payload);
  if (state.buffering && isNew) state.bufferedContent.push({ kind: "tool", toolUseId });
  const { delta, inputBuffer } = parseStreamingToolInput(entry.toolCall, entry.inputBuffer, payload.input);
  entry.inputBuffer = inputBuffer;
  if (delta && !state.buffering) stream.push({ type: "toolcall_delta", contentIndex: entry.contentIndex, delta, partial: output });
}

/** Emit buffered content in strict first-seen block order for Native recovery. */
function flushBufferedContent(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  if (!state.buffering) {
    closeToolCalls(stream, output, state);
    return;
  }
  for (const buffered of state.bufferedContent) {
    if (buffered.kind !== "tool") {
      emitDelta(stream, output, state, buffered.kind, buffered.delta);
      continue;
    }
    closeThinkingBlock(stream, output, state);
    closeTextBlock(stream, output, state);
    const entry = state.toolCallsById.get(buffered.toolUseId);
    if (!entry || entry.ended) continue;
    entry.toolCall.arguments = parseToolInput(entry.inputBuffer);
    entry.contentIndex = output.content.length;
    output.content.push(entry.toolCall);
    stream.push({ type: "toolcall_start", contentIndex: entry.contentIndex, partial: output });
    if (entry.inputBuffer) {
      stream.push({ type: "toolcall_delta", contentIndex: entry.contentIndex, delta: entry.inputBuffer, partial: output });
    }
    entry.ended = true;
    stream.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: entry.toolCall, partial: output });
  }
  closeThinkingBlock(stream, output, state);
  closeTextBlock(stream, output, state);
  closeToolCalls(stream, output, state);
}

function closeToolCalls(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState): void {
  for (const entry of state.toolCallsById.values()) {
    if (entry.ended) continue;
    entry.toolCall.arguments = parseToolInput(entry.inputBuffer);
    entry.ended = true;
    stream.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: entry.toolCall, partial: output });
  }
}

function getPayloadText(payload: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function getReasoningPayloadText(payload: JsonRecord): string {
  const direct = getPayloadText(payload, ["content", "text"]);
  if (direct) return direct;
  const nested = payload.reasoningContentEvent;
  return isRecord(nested) ? getPayloadText(nested, ["content", "text"]) : "";
}

function appendKiroMeteringDiagnostic(output: AssistantMessage, payload: JsonRecord): void {
  const usage = numberFrom(payload.usage);
  const unit = optionalString(payload.unit);
  const unitPlural = optionalString(payload.unitPlural);
  if (usage <= 0 && !unit && !unitPlural) return;
  output.diagnostics ??= [];
  output.diagnostics.push({
    type: "kiro_metering",
    timestamp: Date.now(),
    details: {
      usage,
      ...(unit ? { unit } : {}),
      ...(unitPlural ? { unitPlural } : {}),
    },
  });
}

function captureResponseId(output: AssistantMessage, payload: JsonRecord): void {
  const messageId = optionalString(payload.messageId);
  if (messageId) output.responseId = messageId;
}

function handleEvent(stream: AssistantMessageEventStream, output: AssistantMessage, state: KiroStreamState, model: Model<Api>, eventType: string, payload: EventPayload | null): void {
  if (!payload) return;
  if (Array.isArray(payload)) {
    if (eventType === "toolUseEvent") {
      state.buffering = true;
      for (const entry of payload) if (isRecord(entry)) emitToolCall(stream, output, state, entry);
    }
    return;
  }
  captureResponseId(output, payload);
  if (eventType === "assistantResponseEvent" || eventType === "codeEvent") {
    const delta = getPayloadText(payload, ["content", "text"]);
    if (!delta) return;
    if (state.buffering) {
      state.bufferedContent.push({ kind: "text", delta });
      return;
    }
    emitDelta(stream, output, state, "text", delta);
    return;
  }
  if (eventType === "reasoningContentEvent") {
    const delta = getReasoningPayloadText(payload);
    if (!delta) return;
    if (state.buffering) {
      state.bufferedContent.push({ kind: "thinking", delta });
      return;
    }
    emitDelta(stream, output, state, "thinking", delta);
    return;
  }
  if (eventType === "meteringEvent") {
    appendKiroMeteringDiagnostic(output, payload);
    return;
  }
  if (eventType === "toolUseEvent") {
    // Buffer from the first tool event so interleaved tool inputs never violate
    // Native's one-active-block and increasing-content-index contract.
    state.buffering = true;
    emitToolCall(stream, output, state, payload);
    return;
  }
  if (eventType === "contextUsageEvent") {
    const percentage = numberFrom(payload.contextUsagePercentage);
    if (percentage > 0) state.contextUsagePercentage = percentage;
    return;
  }
  if (eventType === "metricsEvent") {
    const metrics = isRecord(payload.metricsEvent) ? payload.metricsEvent : payload;
    state.usage = usageFromMetrics(model, metrics);
  }
}

async function consumeKiroEventStream(response: Response, stream: AssistantMessageEventStream, output: AssistantMessage, model: Model<Api>, logger: DebugLogger): Promise<void> {
  if (!response.body) throw new Error("Kiro response did not include a readable body.");
  const state: KiroStreamState = {
    hasText: false,
    hasToolCalls: false,
    toolCallsById: new Map(),
    totalContentLength: 0,
    contextUsagePercentage: 0,
    buffering: false,
    bufferedContent: [],
  };
  const queue = new ByteQueue();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    queue.push(chunk);
    let iterations = 0;
    while (queue.length >= 16 && iterations < 1000) {
      iterations += 1;
      const totalLength = queue.peekUint32BE(0);
      if (totalLength === null) break;
      if (totalLength < 16 || totalLength > MAX_EVENT_FRAME_BYTES) {
        logger.warn("eventstream_invalid_prefix", { totalLength, remainingBytes: queue.length });
        queue.read(1);
        continue;
      }
      if (totalLength > queue.length) break;
      const frameBytes = queue.read(totalLength);
      if (!frameBytes) break;
      const frame = parseEventFrame(frameBytes, logger);
      if (!frame) continue;
      handleEvent(stream, output, state, model, frame.headers[":event-type"] ?? "", frame.payload);
    }
    if (iterations >= 1000) logger.warn("eventstream_iteration_limit_reached", { remainingBytes: queue.length });
  }

  flushBufferedContent(stream, output, state);
  closeThinkingBlock(stream, output, state);
  closeTextBlock(stream, output, state);
  output.usage = state.usage ?? estimatedUsage(model, state) ?? output.usage;
  output.stopReason = state.hasToolCalls ? "toolUse" : "stop";
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end(output);
}

async function executeKiroRequest(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
  context: Context,
  config: ExtensionConfig,
  logger: DebugLogger,
  options?: NativeSimpleStreamOptions,
): Promise<void> {
  let signal: { signal: AbortSignal; providerTimedOut(): boolean; dispose(): void } | undefined;
  try {
    const credential = resolveKiroCredential(config, options);
    signal = createRequestSignal(options, options?.timeoutMs ?? config.requestTimeoutMs);
    const request = buildRequest(model, context, config, options);
    const payload = options?.onPayload
      ? (await awaitAbortable(options.onPayload(request, model), signal.signal)) ?? request
      : request;
    const requestFetch = options?.fetch ?? globalThis.fetch;
    const response = await requestFetch(config.upstreamUrl, {
      method: "POST",
      headers: buildHeaders(config, credential.apiKey, options),
      body: JSON.stringify(payload),
      signal: signal.signal,
    });

    if (options?.onResponse) {
      await awaitAbortable(
        options.onResponse({ status: response.status, headers: responseHeadersToRecord(response.headers) }, model),
        signal.signal,
      );
    }

    if (!response.ok) {
      const errorPayload = await readJsonResponse(response, "Kiro returned a non-object JSON response.");
      throw classifyKiroHttpFailure(
        response.status,
        errorPayload,
        credential.mode,
        config.providerId,
        retryAfterMsFromHeaders(response.status, response.headers),
      );
    }

    await consumeKiroEventStream(response, stream, output, model, logger);
  } catch (error) {
    const aborted = (signal?.signal.aborted ?? false) || error instanceof DOMException && error.name === "AbortError";
    output.stopReason = aborted ? "aborted" : "error";
    const authFailure = getKiroAuthFailure(error);
    output.errorMessage = error instanceof Error ? redactSensitiveString(error.message) : "Unknown Kiro request error.";
    if (error instanceof KiroProviderError && error.providerDiagnostic) {
      (output as NativeAssistantMessage).providerDiagnostic = error.providerDiagnostic;
    }
    if (signal?.providerTimedOut()) (output as NativeAssistantMessage).abortSource = "provider";
    if (authFailure) {
      (output as AssistantMessage & { authFailure?: KiroAuthFailureMetadata; errorMetadata?: Record<string, unknown> }).authFailure = { ...authFailure };
      (output as AssistantMessage & { authFailure?: KiroAuthFailureMetadata; errorMetadata?: Record<string, unknown> }).errorMetadata = { providerId: config.providerId, authFailure: { ...authFailure } };
    }
    logger.error("request_failed", { model: model.id, stopReason: output.stopReason, error });
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end(output);
  } finally {
    signal?.dispose();
  }
}

export function createKiroStream(config: ExtensionConfig, _runtime: KiroRuntimeState, logger: DebugLogger) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    stream.push({ type: "start", partial: output });
    void executeKiroRequest(stream, output, model, context, config, logger, options as NativeSimpleStreamOptions | undefined);
    return stream;
  };
}
