/**
 * Bounded Server-Sent Events reader for MCP Streamable HTTP responses.
 *
 * An MCP POST may be answered with `text/event-stream` carrying interleaved
 * notifications, server->client requests, and the response(s) to the client's
 * request. This reader yields each parsed `data:` payload as it arrives while
 * enforcing a hard byte ceiling so a hostile or buggy server cannot exhaust
 * memory.
 */

import { ConnectorError } from "../types";

export type SseEvent = {
  event: string;
  data: string;
};

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ConnectorError(
          "response_too_large",
          `MCP response exceeded ${maxBytes} bytes`,
          502
        );
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = findSeparator(buffer);
      while (separator) {
        const rawEvent = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const parsed = parseEvent(rawEvent);
        if (parsed) {
          yield parsed;
        }
        separator = findSeparator(buffer);
      }
    }

    const tail = parseEvent(buffer);
    if (tail) {
      yield tail;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function parseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join("\n") };
}
