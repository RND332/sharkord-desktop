import { describe, expect, it } from 'vitest';
import { PcmDelivery } from '../src/main/pcm-delivery';

describe('native PCM delivery backpressure', () => {
  it('bounds queued messages and bytes while the renderer cannot acknowledge', () => {
    const delivery = new PcmDelivery();
    delivery.start(1);
    const packets: ReturnType<PcmDelivery['push']> = [];
    for (let i = 0; i < 100_000; i++) packets.push(...delivery.push(Buffer.alloc(3840)));
    expect(packets.length).toBeLessThanOrEqual(12);
    expect(packets.reduce((sum, packet) => sum + packet.chunk.length, 0)).toBeLessThanOrEqual(92_160);
  });

  it('returns acknowledged credits without replaying dropped audio or accepting stale sessions', () => {
    const delivery = new PcmDelivery();
    delivery.start(1);
    const sent = Array.from({ length: 12 }, () => delivery.push(Buffer.alloc(3840))[0]);
    expect(delivery.push(Buffer.alloc(3840))).toEqual([]);
    delivery.acknowledge(1, sent[0]!.sequence);
    const resumed = delivery.push(Buffer.alloc(3840))[0]!;
    expect(resumed.firstSample).toBe(13 * 480);
    delivery.acknowledge(1, sent[0]!.sequence); // duplicate does not create a credit
    expect(delivery.push(Buffer.alloc(3840))).toEqual([]);
    delivery.start(2);
    for (let i = 0; i < 12; i++) delivery.push(Buffer.alloc(3840));
    delivery.acknowledge(1, sent[1]!.sequence);
    expect(delivery.push(Buffer.alloc(3840))).toEqual([]);
    delivery.stop();
    expect(delivery.push(Buffer.alloc(3840))).toEqual([]);
  });

  it('splits oversized reads into bounded aligned packets and carries partial channel frames', () => {
    const delivery = new PcmDelivery();
    delivery.start(1);
    expect(delivery.push(Buffer.from([1, 2, 3]))).toEqual([]);
    const packets = delivery.push(Buffer.alloc(3840 * 100, 4));
    expect(packets.length).toBe(12);
    expect(packets.every((packet) => packet.chunk.length <= 7680 && packet.chunk.length % 8 === 0)).toBe(true);
    expect(Array.from(packets[0]!.chunk.subarray(0, 8))).toEqual([1, 2, 3, 4, 4, 4, 4, 4]);
    expect(packets.reduce((sum, packet) => sum + packet.chunk.length, 0)).toBeLessThanOrEqual(92_160);
    delivery.acknowledge(1, packets[0]!.sequence);
    const resumed = delivery.push(Buffer.alloc(5, 9))[0]!;
    expect(resumed.firstSample).toBe(48_000);
    expect(Array.from(resumed.chunk)).toEqual([4, 4, 4, 9, 9, 9, 9, 9]);
  });
});
