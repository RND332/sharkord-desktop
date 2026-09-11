import { describe, expect, it } from 'vitest';
import { amplitudeAt, frameInterleavedF32, rms } from '../src/shared/pcm';

const CHANNELS = 2;
const SAMPLE_RATE = 48000;

const tone = (freq: number, seconds: number, amplitude = 0.35): Float32Array => {
  const frames = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Float32Array(frames * CHANNELS);
  for (let i = 0; i < frames; i += 1) {
    const value = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    samples[i * CHANNELS] = value;
    samples[i * CHANNELS + 1] = value;
  }
  return samples;
};

const bytesOf = (samples: Float32Array): Uint8Array =>
  new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

const collect = (chunks: Uint8Array[]): Float32Array => {
  let carry: Uint8Array = new Uint8Array(0);
  const blocks: Float32Array[] = [];
  for (const chunk of chunks) {
    const framed = frameInterleavedF32(carry, chunk, CHANNELS);
    carry = framed.carry;
    blocks.push(...framed.frames);
  }
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
};

describe('frameInterleavedF32', () => {
  it('reassembles arbitrary chunk boundaries byte for byte', () => {
    const source = tone(440, 0.05);
    const bytes = bytesOf(source);
    const sizes = [1, 3, 5, 7, 4096, 9, 13];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
      const size = sizes[index % sizes.length]!;
      chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
      offset += size;
      index += 1;
    }

    expect(Array.from(collect(chunks))).toEqual(Array.from(source));
  });

  it('never emits a partial sample for stereo float32', () => {
    const framed = frameInterleavedF32(new Uint8Array(0), new Uint8Array(7), CHANNELS);
    expect(framed.frames).toHaveLength(0);
    expect(framed.carry).toHaveLength(7);

    const completed = frameInterleavedF32(framed.carry, new Uint8Array(1), CHANNELS);
    expect(completed.frames).toHaveLength(1);
    expect(completed.frames[0]).toHaveLength(CHANNELS);
    expect(completed.carry).toHaveLength(0);
  });

  it('carries the signal in both channels at full level', () => {
    const source = tone(880, 0.25);
    const block = frameInterleavedF32(new Uint8Array(0), bytesOf(source), CHANNELS).frames[0]!;

    const left = new Float32Array(block.length / CHANNELS);
    const right = new Float32Array(block.length / CHANNELS);
    for (let i = 0; i < left.length; i += 1) {
      left[i] = block[i * CHANNELS] ?? 0;
      right[i] = block[i * CHANNELS + 1] ?? 0;
    }

    expect(rms(left)).toBeCloseTo(0.35 / Math.SQRT2, 2);
    expect(rms(right)).toBeCloseTo(0.35 / Math.SQRT2, 2);
    expect(amplitudeAt(left, 880, SAMPLE_RATE)).toBeCloseTo(0.35, 2);
  });

  it('reports silence as silence', () => {
    const silent = new Float32Array(4800 * CHANNELS);
    const block = frameInterleavedF32(new Uint8Array(0), bytesOf(silent), CHANNELS).frames[0]!;
    expect(amplitudeAt(block, 440, SAMPLE_RATE, CHANNELS)).toBeCloseTo(0, 4);
  });
});

describe('amplitudeAt', () => {
  it('is selective about frequency', () => {
    const signal = tone(880, 0.5);
    expect(amplitudeAt(signal, 880, SAMPLE_RATE, CHANNELS)).toBeCloseTo(0.35, 2);
    expect(amplitudeAt(signal, 440, SAMPLE_RATE, CHANNELS)).toBeLessThan(0.01);
  });
});
