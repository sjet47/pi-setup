import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { createMessageReader, writeMessage, MAX_FRAME_BYTES } from "./framing.js";

function captureWrites(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = [];
  const socket = {
    write(data: Buffer) {
      written.push(data);
      return true;
    },
  } as unknown as Socket;
  return { socket, written };
}

function encode(msg: unknown): Buffer {
  const { socket, written } = captureWrites();
  writeMessage(socket, msg);
  return Buffer.concat(written);
}

function collectingReader(): {
  reader: (data: Buffer) => void;
  messages: unknown[];
  errors: Error[];
} {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (msg) => messages.push(msg),
    (error) => errors.push(error),
  );
  return { reader, messages, errors };
}

test("writeMessage/createMessageReader roundtrip", () => {
  const { reader, messages, errors } = collectingReader();
  const msg = { type: "register", session: { name: "planner", pid: 42 } };

  reader(encode(msg));

  assert.deepEqual(messages, [msg]);
  assert.equal(errors.length, 0);
});

test("reader handles multiple frames in a single chunk", () => {
  const { reader, messages, errors } = collectingReader();
  const first = { type: "list", requestId: "a" };
  const second = { type: "list", requestId: "b" };
  const third = { type: "presence", status: "idle" };

  reader(Buffer.concat([encode(first), encode(second), encode(third)]));

  assert.deepEqual(messages, [first, second, third]);
  assert.equal(errors.length, 0);
});

test("reader handles a length header split across chunks", () => {
  const { reader, messages, errors } = collectingReader();
  const msg = { type: "presence", name: "orchestrator" };
  const frame = encode(msg);

  reader(frame.subarray(0, 2));
  assert.equal(messages.length, 0);
  reader(frame.subarray(2));

  assert.deepEqual(messages, [msg]);
  assert.equal(errors.length, 0);
});

test("reader handles a payload split across chunks", () => {
  const { reader, messages, errors } = collectingReader();
  const msg = { type: "send", to: "planner", text: "x".repeat(1000) };
  const frame = encode(msg);

  reader(frame.subarray(0, 100));
  assert.equal(messages.length, 0);
  reader(frame.subarray(100, 600));
  assert.equal(messages.length, 0);
  reader(frame.subarray(600));

  assert.deepEqual(messages, [msg]);
  assert.equal(errors.length, 0);
});

test("reader handles byte-by-byte delivery of consecutive frames", () => {
  const { reader, messages, errors } = collectingReader();
  const first = { type: "list", requestId: "byte-1" };
  const second = { type: "list", requestId: "byte-2" };
  const stream = Buffer.concat([encode(first), encode(second)]);

  for (let i = 0; i < stream.length; i++) {
    reader(stream.subarray(i, i + 1));
  }

  assert.deepEqual(messages, [first, second]);
  assert.equal(errors.length, 0);
});

test("reader rejects frames whose header exceeds MAX_FRAME_BYTES", () => {
  const { reader, messages, errors } = collectingReader();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);

  reader(header);

  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, new RegExp(String(MAX_FRAME_BYTES + 1)));
  assert.match(errors[0].message, new RegExp(String(MAX_FRAME_BYTES)));

  // The reader must stop processing after the protocol error.
  reader(encode({ type: "list", requestId: "after-error" }));
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
});

test("reader accepts a frame header of exactly MAX_FRAME_BYTES without erroring", () => {
  const { reader, messages, errors } = collectingReader();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES, 0);

  // Only the header arrives; the reader should wait for the payload, not error.
  reader(header);

  assert.equal(messages.length, 0);
  assert.equal(errors.length, 0);
});

test("writeMessage throws when the payload exceeds MAX_FRAME_BYTES", () => {
  const { socket, written } = captureWrites();
  const oversized = { text: "x".repeat(MAX_FRAME_BYTES + 1) };

  assert.throws(() => writeMessage(socket, oversized), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /frame limit/);
    return true;
  });
  assert.equal(written.length, 0);
});

test("reader reports malformed JSON payloads via onError", () => {
  const { reader, messages, errors } = collectingReader();
  const payload = Buffer.from("{not json", "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);

  reader(Buffer.concat([header, payload]));

  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to parse intercom message/);
});

test("reader reports onMessage handler failures via onError", () => {
  const errors: Error[] = [];
  const reader = createMessageReader(
    () => {
      throw new Error("handler exploded");
    },
    (error) => errors.push(error),
  );

  reader(encode({ type: "list", requestId: "boom" }));

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to handle intercom message: handler exploded/);
});
