import type { DebugLogger } from "./debug-logger.js";
import { isRecord, type JsonRecord } from "./shared/index.js";

export type { JsonRecord };
export type EventPayload = JsonRecord | unknown[];

export interface EventFrame {
  headers: Record<string, string>;
  payload: EventPayload | null;
}

const CRC32_TABLE = new Uint32Array(256);
const TEXT_DECODER = new TextDecoder();
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peekUint32BE(offset = 0): number | null {
    if (this.length < offset + 4) return null;
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      value = (value << 8) | this.byteAt(offset + i);
    }
    return value >>> 0;
  }

  read(length: number): Uint8Array | null {
    if (length < 0 || this.length < length) return null;
    const output = new Uint8Array(length);
    let written = 0;

    while (written < length) {
      const head = this.chunks[0];
      const available = head.length - this.headOffset;
      const take = Math.min(available, length - written);
      output.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;

      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    return output;
  }

  private byteAt(offset: number): number {
    let remaining = offset;
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      if (remaining < available) return chunk[start + remaining];
      remaining -= available;
    }
    return 0;
  }
}

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseEventFrame(data: Uint8Array, logger: DebugLogger): EventFrame | null {
  try {
    if (data.length < 16) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);

    if (totalLength !== data.length || totalLength < 16 || headersLength > totalLength - 16) {
      logger.warn("eventstream_invalid_lengths", { totalLength, headersLength, byteLength: data.length });
      return null;
    }

    const preludeCrc = view.getUint32(8, false);
    const computedPreludeCrc = crc32(data.subarray(0, 8));
    if (preludeCrc !== computedPreludeCrc) {
      logger.warn("eventstream_prelude_crc_mismatch", { expected: preludeCrc, actual: computedPreludeCrc });
      return null;
    }

    const messageCrc = view.getUint32(data.length - 4, false);
    const computedMessageCrc = crc32(data.subarray(0, data.length - 4));
    if (messageCrc !== computedMessageCrc) {
      logger.warn("eventstream_message_crc_mismatch", { expected: messageCrc, actual: computedMessageCrc });
      return null;
    }

    const headers: Record<string, string> = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;
    while (offset < headerEnd) {
      const nameLength = data[offset];
      offset += 1;
      if (offset + nameLength > headerEnd) {
        logger.warn("eventstream_invalid_header", { reason: "name_length_exceeds_header_section", offset, nameLength, headersLength });
        return null;
      }

      const name = TEXT_DECODER.decode(data.subarray(offset, offset + nameLength));
      offset += nameLength;
      if (offset >= headerEnd) {
        logger.warn("eventstream_invalid_header", { reason: "missing_header_type", offset, name, headersLength });
        return null;
      }
      const headerType = data[offset];
      offset += 1;

      if (headerType !== 7) {
        logger.warn("eventstream_invalid_header", { reason: "unsupported_header_type", offset, name, headerType });
        return null;
      }
      if (offset + 2 > headerEnd) {
        logger.warn("eventstream_invalid_header", { reason: "missing_string_length", offset, name, headersLength });
        return null;
      }
      const valueLength = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      if (offset + valueLength > headerEnd) {
        logger.warn("eventstream_invalid_header", { reason: "value_length_exceeds_header_section", offset, name, valueLength, headersLength });
        return null;
      }

      headers[name] = TEXT_DECODER.decode(data.subarray(offset, offset + valueLength));
      offset += valueLength;
    }

    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4;
    if (payloadEnd <= payloadStart) return { headers, payload: null };

    const payloadText = TEXT_DECODER.decode(data.subarray(payloadStart, payloadEnd));
    if (!payloadText.trim()) return { headers, payload: null };

    try {
      const parsed = JSON.parse(payloadText) as unknown;
      return { headers, payload: Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed : { value: parsed } };
    } catch (error) {
      logger.warn("eventstream_payload_parse_failed", { message: error instanceof Error ? error.message : "unknown error" });
      return { headers, payload: { raw: payloadText } };
    }
  } catch (error) {
    logger.warn("eventstream_frame_parse_failed", { message: error instanceof Error ? error.message : "unknown error" });
    return null;
  }
}
