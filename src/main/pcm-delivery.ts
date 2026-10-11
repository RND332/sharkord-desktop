export type PcmPacket = { chunk: Buffer; sessionId: number; sequence: number; firstSample: number };

const BYTES_PER_SAMPLE = 8; // 48 kHz stereo float32: one frame across both channels.
const MAX_PACKET_BYTES = 7680; // At most 20 ms per IPC message.
const MAX_PENDING_PACKETS = 12; // At most 240 ms / 92,160 bytes in flight.

/** Bound realtime audio BEFORE native IPC queues it, including while renderer JS is stalled. */
export class PcmDelivery {
  private sessionId: number | null = null;
  private sequence = 0;
  private firstSample = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly pending = new Set<number>();

  stop(): void {
    this.sessionId = null;
    this.pending.clear();
    this.carry = Buffer.alloc(0);
  }

  acknowledge(sessionId: unknown, sequence: unknown): void {
    if (sessionId === this.sessionId && typeof sequence === 'number') this.pending.delete(sequence);
  }

  start(sessionId: number): void {
    this.stop();
    this.sessionId = sessionId;
    this.sequence = 0;
    this.firstSample = 0;
  }

  push(chunk: Buffer): PcmPacket[] {
    if (this.sessionId === null) return [];
    const carry = this.carry;
    const total = carry.length + chunk.length;
    const usable = total - total % BYTES_PER_SAMPLE;
    // Copy only bounded packets/tail, never concatenate a whole oversized source read.
    const copy = (offset: number, length: number): Buffer => {
      const output = Buffer.allocUnsafe(length);
      const fromCarry = Math.min(length, Math.max(0, carry.length - offset));
      if (fromCarry) carry.copy(output, 0, offset, offset + fromCarry);
      const fromChunk = Math.max(0, offset - carry.length);
      chunk.copy(output, fromCarry, fromChunk, fromChunk + length - fromCarry);
      return output;
    };
    const packets: PcmPacket[] = [];
    for (let offset = 0; offset < usable && this.pending.size < MAX_PENDING_PACKETS;) {
      const length = Math.min(MAX_PACKET_BYTES, usable - offset);
      const sequence = ++this.sequence;
      this.pending.add(sequence);
      packets.push({ chunk: copy(offset, length), sessionId: this.sessionId, sequence,
        firstSample: this.firstSample + offset / BYTES_PER_SAMPLE });
      offset += length;
    }
    this.carry = copy(usable, total - usable);
    // Dropped audio is not buffered or replayed. Absolute positions keep the video/audio clocks aligned.
    this.firstSample += usable / BYTES_PER_SAMPLE;
    return packets;
  }
}
