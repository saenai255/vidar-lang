// DAP framing: `Content-Length: N\r\n\r\n` followed by N bytes of JSON.
export interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: any;
  body?: any;
}

export function frame(msg: DapMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Splits a byte stream into messages; a malformed frame is skipped. */
export class MessageReader {
  private buf = Buffer.alloc(0);

  constructor(private readonly onMessage: (msg: DapMessage) => void) {}

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = /Content-Length: *(\d+)/i.exec(this.buf.subarray(0, sep).toString("ascii"))?.[1];
      if (len === undefined) {
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const end = sep + 4 + Number(len);
      if (this.buf.length < end) return;
      const text = this.buf.subarray(sep + 4, end).toString("utf8");
      this.buf = this.buf.subarray(end);
      try {
        this.onMessage(JSON.parse(text));
      } catch {
        // not JSON: dropped
      }
    }
  }
}
