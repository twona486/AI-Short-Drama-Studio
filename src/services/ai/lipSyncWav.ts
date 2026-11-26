const SAMPLE_RATE = 24_000
const HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2
const LTX_FPS = 24
const LTX_FRAME_STEP = 8
const LTX_MIN_AUDIO_SECONDS = 2

/** 더빙에서 저장하는 24 kHz, 16비트 모노 PCM WAV를 읽는다. */
export function lipSyncPcm(wav: ArrayBuffer): Uint8Array {
  const data = new DataView(wav)
  if (data.byteLength <= HEADER_BYTES || data.byteLength % 2 ||
    data.getUint32(0) !== 0x52494646 || data.getUint32(4, true) !== wav.byteLength - 8 ||
    data.getUint32(8) !== 0x57415645 || data.getUint32(12) !== 0x666d7420 ||
    data.getUint32(16, true) !== 16 || data.getUint16(20, true) !== 1 ||
    data.getUint16(22, true) !== 1 || data.getUint32(24, true) !== SAMPLE_RATE ||
    data.getUint32(28, true) !== SAMPLE_RATE * BYTES_PER_SAMPLE ||
    data.getUint16(32, true) !== BYTES_PER_SAMPLE || data.getUint16(34, true) !== 16 ||
    data.getUint32(36) !== 0x64617461 || data.getUint32(40, true) !== wav.byteLength - HEADER_BYTES) {
    throw new Error('립싱크에 사용할 더빙 WAV 형식을 확인하지 못했습니다.')
  }
  return new Uint8Array(wav, HEADER_BYTES)
}

export function lipSyncDuration(pcm: Uint8Array) {
  return pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE)
}

export function joinLipSyncWavs(wavs: ArrayBuffer[]) {
  if (!wavs.length) throw new Error('립싱크로 합성할 대사가 없습니다.')
  const samples = wavs.map(lipSyncPcm)
  const gap = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.15
  const speechBytes = samples.reduce((sum, pcm) => sum + pcm.byteLength, 0) + gap * (samples.length - 1)
  const bytesPerFrame = SAMPLE_RATE / LTX_FPS * BYTES_PER_SAMPLE
  const minBytes = LTX_MIN_AUDIO_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE
  // LTX Desktop A2V는 8k+1 프레임으로 내린다. 다음 경계에 한 프레임 여유를 둔다.
  const frames = Math.max(minBytes, speechBytes) / bytesPerFrame
  const boundary = Math.ceil((frames - 1) / LTX_FRAME_STEP) * LTX_FRAME_STEP + 1
  const totalBytes = (boundary + 1) * bytesPerFrame
  const wav = new Uint8Array(HEADER_BYTES + totalBytes)
  wav.set(new Uint8Array(wavs[0], 0, HEADER_BYTES))
  const header = new DataView(wav.buffer)
  header.setUint32(4, wav.length - 8, true)
  header.setUint32(40, totalBytes, true)
  let offset = HEADER_BYTES
  for (const pcm of samples) {
    wav.set(pcm, offset)
    offset += pcm.byteLength + gap
  }
  return {
    wav: wav.buffer,
    duration: speechBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE),
    uploadDuration: totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)
  }
}
