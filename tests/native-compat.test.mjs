import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { loadConfig } = await import(fromBuild("src/config.js"));
const { crc32, parseEventFrame } = await import(fromBuild("src/eventstream.js"));
const { createKiroStream } = await import(fromBuild("src/kiro.js"));

const encoder = new TextEncoder();
const logger = { debug() {}, warn() {}, error() {} };
const config = {
  enabled: true,
  debug: false,
  providerId: "kiro",
  displayName: "Kiro",
  upstreamUrl: "https://example.invalid",
  endpoint: "codewhisperer",
  apiKey: "test-key",
  requestTimeoutMs: 1_000,
  headers: {},
  models: [],
  oauth: {},
};
const model = {
  id: "gpt-5.6-sol",
  name: "GPT 5.6 Sol",
  api: "kiro",
  provider: "kiro",
  baseUrl: config.upstreamUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};
const textContext = {
  systemPrompt: "",
  messages: [{ role: "user", content: "test", timestamp: 1 }],
  tools: [],
};

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  output[0] = nameBytes.length;
  output.set(nameBytes, 1);
  output[1 + nameBytes.length] = 7;
  new DataView(output.buffer).setUint16(2 + nameBytes.length, valueBytes.length, false);
  output.set(valueBytes, 4 + nameBytes.length);
  return output;
}

function encodeFrame(eventType, payload) {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 16 + headers.length + payloadBytes.length;
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(output.subarray(0, 8)), false);
  output.set(headers, 12);
  output.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, crc32(output.subarray(0, totalLength - 4)), false);
  return output;
}

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function responseFor(body, status = 200, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), { status, headers });
}

async function runStream(body, context = textContext, options = {}, configOverride = {}) {
  const stream = createKiroStream({ ...config, ...configOverride }, {}, logger)(
    model,
    context,
    {
      fetch: async () => responseFor(body),
      ...options,
    },
  );
  const events = [];
  for await (const event of stream) events.push(event.type);
  return { events, result: await stream.result() };
}

function countingSignal() {
  const counts = { added: 0, removed: 0 };
  const signal = new AbortController().signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    counts.added += 1;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    counts.removed += 1;
    return remove(...args);
  };
  return { signal, counts };
}

test("Native preserves JSON-array tool payloads", async () => {
  const payload = [
    { toolUseId: "a", name: "read", input: { path: "a" } },
    { toolUseId: "b", name: "read", input: { path: "b" } },
  ];
  const encoded = encodeFrame("toolUseEvent", payload);
  const frame = parseEventFrame(encoded, logger);
  assert.equal(Array.isArray(frame?.payload), true);
  assert.equal(frame.payload.length, 2);

  const { result } = await runStream(encoded);
  assert.deepEqual(
    result.content.map((part) => part.type === "toolCall" ? part.id : part.type),
    ["a", "b"],
  );
});

test("Native resynchronizes after malformed event prefixes", async () => {
  const valid = encodeFrame("assistantResponseEvent", { content: "RESYNC_OK" });
  const { events, result } = await runStream(concatBytes([new Uint8Array(16), valid]));

  assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.deepEqual(result.content, [{ type: "text", text: "RESYNC_OK" }]);
});

test("Native preserves semantic order for interleaved tools", async () => {
  const body = concatBytes([
    encodeFrame("toolUseEvent", { toolUseId: "A", name: "read", input: '{"path":' }),
    encodeFrame("assistantResponseEvent", { content: "ABCDEFGH" }),
    encodeFrame("toolUseEvent", { toolUseId: "B", name: "read", input: { path: "b" } }),
    encodeFrame("toolUseEvent", { toolUseId: "A", input: '"a"}' }),
  ]);
  const { events, result } = await runStream(body);

  assert.deepEqual(events, [
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ]);
  assert.deepEqual(
    result.content.map((part) => part.type === "toolCall" ? `tool:${part.id}` : part.type),
    ["tool:A", "text", "tool:B"],
  );
  assert.equal(result.usage.output, 2);
});

test("Native preserves mixed history and affinity", async () => {
  const historyContext = {
    systemPrompt: "",
    messages: [
      { role: "user", content: `${"x".repeat(4_500)}A`, timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "preface" },
          { type: "toolCall", id: "call_abc", name: "read", arguments: { path: "a" } },
        ],
        api: "kiro",
        provider: "kiro",
        model: "gpt-5.6-sol",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_abc",
        toolName: "read",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "next", timestamp: 4 },
    ],
    tools: [],
  };
  const requests = [];
  for (const affinitySessionId of ["session-a", "session-b"]) {
    await runStream(new Uint8Array(), historyContext, {
      affinitySessionId,
      onPayload(request) {
        requests.push(request);
        return request;
      },
    });
  }

  const assistant = requests[0].conversationState.history
    .find((item) => item.assistantResponseMessage?.toolUses)?.assistantResponseMessage;
  const resultMessage = requests[0].conversationState.currentMessage;
  assert.equal(assistant.content, "preface");
  assert.notEqual(
    requests[0].conversationState.conversationId,
    requests[1].conversationState.conversationId,
  );
});

test("observed invalid tool format strips compound IDs from calls and results", async () => {
  const compoundId = "call_GXLRJu0eIxGFn3zSR3inUWh5|fc_031408d87ea3b6ab016abb32e85e1887d0a787c61392c4ea3e";
  const requests = [];
  const context = {
    systemPrompt: "",
    messages: [
      { role: "user", content: "run eval", timestamp: 1 },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: compoundId,
          name: "eval",
          arguments: { language: "js", code: "1 + 1" },
        }],
        api: "openai-codex-responses",
        provider: "chatgpt-subscription",
        model: "gpt-5.6-sol",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: compoundId,
        toolName: "eval",
        content: [{ type: "text", text: "2" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "continue", timestamp: 4 },
    ],
    tools: [],
  };

  await runStream(new Uint8Array(), context, {
    onPayload(request) {
      requests.push(request);
      return request;
    },
  });

  const assistant = requests[0].conversationState.history
    .find((item) => item.assistantResponseMessage?.toolUses)?.assistantResponseMessage;
  const result = requests[0].conversationState.currentMessage
    .userInputMessage.userInputMessageContext.toolResults[0];
  assert.equal(assistant.toolUses[0].toolUseId, "call_GXLRJu0eIxGFn3zSR3inUWh5");
  assert.equal(result.toolUseId, "call_GXLRJu0eIxGFn3zSR3inUWh5");
});

test("Native aborts stalled payload hooks and removes listeners", async () => {
  const parent = countingSignal();
  const { events, result } = await runStream(
    new Uint8Array(),
    textContext,
    {
      signal: parent.signal,
      onPayload: () => new Promise(() => {}),
    },
    { requestTimeoutMs: 10 },
  );

  assert.deepEqual(events, ["start", "error"]);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.abortSource, "provider");
  assert.deepEqual(parent.counts, { added: 1, removed: 1 });
});

test("Native aborts stalled response hooks and removes listeners", async () => {
  const parent = countingSignal();
  const { events, result } = await runStream(
    new Uint8Array(),
    textContext,
    {
      signal: parent.signal,
      onResponse: () => new Promise(() => {}),
    },
    { requestTimeoutMs: 10 },
  );

  assert.deepEqual(events, ["start", "error"]);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.abortSource, "provider");
  assert.deepEqual(parent.counts, { added: 1, removed: 1 });
});

test("Native emits start before a missing-token error", async () => {
  const stream = createKiroStream(
    { ...config, apiKey: "KIRO_MISSING_TEST_TOKEN" },
    {},
    logger,
  )(model, textContext);
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();

  assert.deepEqual(events, ["start", "error"]);
  assert.match(result.errorMessage, /No Kiro access token configured/);
});

test("Native emits configured provider diagnostics and Retry-After markers", async () => {
  const authStream = createKiroStream(
    { ...config, providerId: "kiro-custom" },
    {},
    logger,
  )(model, textContext, {
    fetch: async () => new Response('{"message":"rejected"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  for await (const _event of authStream) {}
  const authResult = await authStream.result();
  assert.deepEqual(authResult.providerDiagnostic, {
    category: "auth",
    httpStatus: 401,
    evidence: "structured_status",
  });
  assert.equal(authResult.errorMetadata.providerId, "kiro-custom");

  const retryStream = createKiroStream(config, {}, logger)(model, textContext, {
    fetch: async () => new Response('{"message":"slow down"}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    }),
  });
  for await (const _event of retryStream) {}
  const retryResult = await retryStream.result();
  assert.match(retryResult.errorMessage, /\(retry-after-ms: 3000\)$/);
});

test("Native recovers a single credential from a transient Kiro 429", async () => {
  const waits = [];
  let fetchCalls = 0;
  const recoveredBody = encodeFrame("assistantResponseEvent", { content: "RATE_LIMIT_RECOVERED" });
  const { events, result } = await runStream(
    recoveredBody,
    textContext,
    {
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response(JSON.stringify({ message: "Too many requests, please wait before trying again." }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return responseFor(recoveredBody);
      },
      delay: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
    {
      rateLimitMaxRetries: 1,
      rateLimitRetryBaseMs: 30_000,
      rateLimitRetryMaxMs: 120_000,
    },
  );

  assert.equal(fetchCalls, 2);
  assert.deepEqual(waits, [30_000]);
  assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.deepEqual(result.content, [{ type: "text", text: "RATE_LIMIT_RECOVERED" }]);
  assert.equal(result.stopReason, "stop");
});

test("Native normalizes top-level tool schema unions", async () => {
  const requests = [];
  const context = {
    ...textContext,
    tools: [{
      name: "union_tool",
      description: "Exercises a discriminated object union.",
      parameters: {
        oneOf: [
          {
            type: "object",
            properties: { op: { const: "read" }, path: { type: "string" } },
            required: ["op", "path"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { op: { const: "list" }, depth: { type: "number" } },
            required: ["op"],
            additionalProperties: false,
          },
        ],
      },
    }],
  };
  await runStream(new Uint8Array(), context, {
    onPayload(request) {
      requests.push(request);
      return request;
    },
  });

  const schema = requests[0].conversationState.currentMessage
    .userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;
  assert.equal(schema.type, "object");
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(schema.required, ["op"]);
  assert.deepEqual(schema.properties.op, {
    anyOf: [{ const: "read" }, { const: "list" }],
  });
});

test("fork defaults include Opus 5.5 and exact 80 percent compaction metadata", () => {
  const extensionRoot = mkdtempSync(join(tmpdir(), "pi-kiro-provider-defaults-"));
  const loaded = loadConfig(extensionRoot);
  const matches = loaded.config.models.filter((entry) => entry.id === "claude-opus-5.5");

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    ...matches[0],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    rateMultiplier: 2,
    compactionTriggerRatio: 0.8,
  });
  assert.equal(matches[0].thinkingLevelMap.off, null);
  assert.equal(matches[0].thinkingLevelMap.max, "max");
});
