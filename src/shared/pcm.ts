const EMPTY = new Uint8Array(0);

/**
 * Splits an interleaved float32 stream into blocks of complete channel frames.
 * The carry holds 0..(4*channels-1) bytes so a chunk boundary can never split a sample,
 * and every returned block is usable as `AudioData({ format: 'f32', … })` data as-is.
 */
export const frameInterleavedF32 = (
  carry: Uint8Array,
  chunk: Uint8Array,
  channels: number
): { carry: Uint8Array; frames: Float32Array[] } => {
  const bytesPerFrame = 4 * channels;
  const total = carry.length + chunk.length;
  const usable = total - (total % bytesPerFrame);

  if (usable === 0) {
    if (carry.length === 0) return { carry: chunk, frames: [] };
    const merged = new Uint8Array(total);
    merged.set(carry, 0);
    merged.set(chunk, carry.length);
    return { carry: merged, frames: [] };
  }

  const merged = carry.length === 0 ? chunk : new Uint8Array(total);
  if (carry.length > 0) {
    merged.set(carry, 0);
    merged.set(chunk, carry.length);
  }

  const block = new Float32Array(usable / 4);
  new Uint8Array(block.buffer).set(merged.subarray(0, usable));

  const rest = merged.subarray(usable);
  return { carry: rest.length === 0 ? EMPTY : new Uint8Array(rest), frames: [block] };
};

/** Peak amplitude estimate at `freq` (Goertzel), averaged over channels. */
export const amplitudeAt = (
  samples: Float32Array,
  freq: number,
  sampleRate: number,
  channels = 1
): number => {
  const frames = Math.floor(samples.length / channels);
  if (frames === 0 || sampleRate <= 0) return 0;

  const k = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let total = 0;

  for (let channel = 0; channel < channels; channel += 1) {
    let s1 = 0;
    let s2 = 0;
    for (let i = channel; i < frames * channels; i += channels) {
      const s0 = (samples[i] ?? 0) + k * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    total += (Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / frames) * 2;
  }

  return total / channels;
};

export const rms = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
};
