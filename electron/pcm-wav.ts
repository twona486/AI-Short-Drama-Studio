export function pcm16ToWav(pcm: Buffer, sampleRate: number) {
  if (!pcm.length || pcm.length % 2) throw new Error('더빙에서 올바른 PCM 오디오를 받지 못했습니다.')
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return { wav, durationMs: Math.round(pcm.length * 1000 / (2 * sampleRate)) }
}
