import { writeFile } from 'node:fs/promises';

/** 32-bit IEEE-float WAV — opens in audacity/ffmpeg for debugging captures. */
export const writeWav = async (
  path: string,
  samples: Float32Array,
  sampleRate: number,
  channels: number
): Promise<void> => {
  const dataBytes = samples.byteLength;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const payload = Buffer.from(samples.buffer, samples.byteOffset, dataBytes);
  await writeFile(path, Buffer.concat([header, payload]));
};
