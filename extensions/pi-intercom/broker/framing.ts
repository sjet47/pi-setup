import type { Socket } from "net";

/**
 * Maximum allowed frame payload size. Anything larger is treated as a
 * corrupt or hostile stream rather than a legitimate message.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 4;

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 * Throws if the encoded payload exceeds MAX_FRAME_BYTES.
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(
      `Intercom message payload is ${payload.length} bytes, exceeding the ${MAX_FRAME_BYTES} byte frame limit`,
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError so the caller can close
 * the socket; the reader stops processing any further data after an error.
 *
 * Incoming chunks are accumulated in an array and only stitched together once
 * a complete frame has arrived, so feeding a large frame in many small chunks
 * stays O(n) instead of re-concatenating the whole buffer per chunk.
 */
export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Error) => void,
) {
  let chunks: Buffer[] = [];
  let buffered = 0;
  let failed = false;

  const fail = (error: Error) => {
    failed = true;
    chunks = [];
    buffered = 0;
    onError(error);
  };

  return (data: Buffer) => {
    if (failed) {
      return;
    }

    if (data.length > 0) {
      chunks.push(data);
      buffered += data.length;
    }

    while (buffered >= HEADER_BYTES) {
      if (chunks[0].length < HEADER_BYTES) {
        // The length header itself is split across chunks; merge once so it
        // can be read contiguously.
        chunks = [Buffer.concat(chunks)];
      }

      const length = chunks[0].readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        fail(new Error(
          `Intercom frame announces ${length} bytes, exceeding the ${MAX_FRAME_BYTES} byte frame limit`,
        ));
        return;
      }

      if (buffered < HEADER_BYTES + length) {
        break;
      }

      // A complete frame is buffered: stitch at most once, then slice.
      const merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const payload = merged.subarray(HEADER_BYTES, HEADER_BYTES + length);
      const rest = merged.subarray(HEADER_BYTES + length);
      chunks = rest.length > 0 ? [rest] : [];
      buffered = rest.length;

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
