import { randomInt } from 'node:crypto'
import { Client, credentials, status, type ServiceError } from '@grpc/grpc-js'
import { Builder } from 'flatbuffers'
import protobuf from 'protobufjs'
import {
  drawThingsPreset, qwenImage21Components, type DrawThingsProgress, type DrawThingsReply, type DrawThingsRequest
} from '../src/services/ai/drawThingsOptions'

// Fields used from draw-things-community's Libraries/GRPC/Models/Sources/imageService/imageService.proto.
const protocol = protobuf.parse(`
  syntax = "proto3";
  message EchoRequest { string name = 1; optional string sharedSecret = 2; }
  message EchoReply { string message = 1; repeated string files = 2; Metadata override = 3; bool sharedSecretMissing = 4; }
  message Metadata { bytes models = 1; }
  message GenerateRequest {
    bytes image = 1;
    int32 scaleFactor = 2;
    repeated Hint hints = 4;
    string prompt = 5;
    string negativePrompt = 6;
    bytes configuration = 7;
    string user = 10;
    int32 device = 11;
    optional string sharedSecret = 13;
    bool chunked = 14;
  }
  message Hint { string hintType = 1; repeated WeightedTensor tensors = 2; }
  message WeightedTensor { bytes tensor = 1; float weight = 2; }
  message GenerateResponse { repeated bytes generatedImages = 1; Signpost currentSignpost = 2; uint32 chunkState = 8; }
  message Signpost { Sampling sampling = 3; }
  message Sampling { int32 step = 1; }
`).root

const echoRequest = protocol.lookupType('EchoRequest')
const echoReply = protocol.lookupType('EchoReply')
const generateRequest = protocol.lookupType('GenerateRequest')
const generateResponse = protocol.lookupType('GenerateResponse')
const service = '/ImageGenerationService'
const maxTensorBytes = 32 * 1024 * 1024
const maxRequestTensorBytes = maxTensorBytes - 256 * 1024
const headerSize = 68

export function grpcReferencesFit(width: number, height: number, count: number) {
  return count * (headerSize + width * height * 6) <= maxRequestTensorBytes
}

export const drawThingsGrpcTimeouts = { probeMs: 8_000, generationMs: 20 * 60_000 }

type GenerateRequest = Extract<DrawThingsRequest, { kind: 'generate' }>
type Preset = NonNullable<ReturnType<typeof drawThingsPreset>>

function configuration(request: GenerateRequest, preset: Preset) {
  // Stable field IDs from Libraries/DataModels/Sources/config.fbs, including deprecated slots.
  const fields = {
    width: 1, height: 2, seed: 3, steps: 4, guidance: 5, strength: 6,
    model: 7, sampler: 8, seedMode: 17, shift: 49, resolutionDependentShift: 71
  }
  const builder = new Builder(512)
  const model = builder.createString(request.model)
  builder.startObject(fields.resolutionDependentShift + 1)
  builder.addFieldInt16(fields.width, request.width / 64, 0)
  builder.addFieldInt16(fields.height, request.height / 64, 0)
  builder.addFieldInt32(fields.seed, randomInt(0, 2 ** 32), 0)
  builder.addFieldInt32(fields.steps, preset.steps, 0)
  builder.addFieldFloat32(fields.guidance, preset.cfg_scale, 0)
  builder.addFieldFloat32(fields.strength, 1, 0)
  builder.addFieldOffset(fields.model, model, 0)
  builder.addFieldInt8(fields.sampler, preset.sampler_name === 'DDIM Trailing' ? 16 : 17, 0)
  builder.addFieldInt8(fields.seedMode, 2, 0)
  builder.addFieldFloat32(fields.shift, preset.shift, 1)
  builder.addFieldInt8(fields.resolutionDependentShift, Number(preset.resolution_dependent_shift), 1)
  builder.finish(builder.endObject())
  return builder.asUint8Array()
}

// NNC tensors use a 68-byte header and little-endian NHWC samples.
const float16 = 0x20000
const float32 = 0x4000
const nhwc = 2
const compressed = 1012247
const cpu = 1
const toHalf = Array.from({ length: 256 }, (_, value) => {
  const number = value / 127.5 - 1
  const magnitude = Math.abs(number)
  const exponent = Math.floor(Math.log2(magnitude))
  const mantissa = Math.round(magnitude * 2 ** (10 - exponent))
  return (number < 0 ? 0x8000 : 0) | ((exponent + 14) * 1024 + mantissa)
})

function imageTensor(rgba: ArrayBuffer, width: number, height: number) {
  const pixels = new Uint8Array(rgba)
  const tensor = Buffer.alloc(headerSize + width * height * 6)
  const header = [0, cpu, nhwc, float16, 0, 1, height, width, 3]
  header.forEach((field, index) => tensor.writeUInt32LE(field, index * 4))
  for (let i = 0, offset = headerSize; i < pixels.length; i += 4, offset += 6) {
    tensor.writeUInt16LE(toHalf[pixels[i]], offset)
    tensor.writeUInt16LE(toHalf[pixels[i + 1]], offset + 2)
    tensor.writeUInt16LE(toHalf[pixels[i + 2]], offset + 4)
  }
  return tensor
}

function fromHalf(value: number) {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >>> 10) & 0x1f
  const mantissa = value & 1023
  if (exponent === 31) return 0
  if (exponent === 0) return sign * mantissa * 2 ** -24
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

function outputPixels(tensor: Buffer): DrawThingsReply {
  if (tensor.length < headerSize) return { kind: 'invalidResponse' }
  const codec = tensor.readUInt32LE(0)
  if (codec === compressed) return { kind: 'grpcCompression' }
  const datatype = tensor.readUInt32LE(12)
  const [batch, height, width, channels] = [20, 24, 28, 32].map(offset => tensor.readUInt32LE(offset))
  const stride = datatype === float16 ? 2 : datatype === float32 ? 4 : 0
  if (codec !== 0 || tensor.readUInt32LE(8) !== nhwc || batch !== 1 || (channels !== 3 && channels !== 4) ||
    !stride || width < 1 || height < 1 || width > 2048 || height > 2048 ||
    tensor.length !== headerSize + width * height * channels * stride) return { kind: 'invalidResponse' }
  const pixels = new Uint8ClampedArray(width * height * 4)
  let offset = headerSize
  const sample = () => {
    const value = stride === 2 ? fromHalf(tensor.readUInt16LE(offset)) : tensor.readFloatLE(offset)
    offset += stride
    return value
  }
  for (let i = 0; i < pixels.length; i += 4) {
    // RGBA models such as Qwen Image 2.1 return alpha first in the [0, 1] range.
    pixels[i + 3] = channels === 4 ? sample() * 255 : 255
    for (let channel = 0; channel < 3; channel++) {
      pixels[i + channel] = (sample() + 1) * 127.5
    }
  }
  return { kind: 'pixels', data: pixels.buffer, width, height }
}

const serialize = (type: protobuf.Type) => (message: object) => Buffer.from(type.encode(message).finish())

function grpcError(error: ServiceError): DrawThingsReply {
  if (error.code === status.DEADLINE_EXCEEDED) return { kind: 'timeout' }
  if (error.code === status.CANCELLED) return { kind: 'cancelled' }
  if (error.code === status.PERMISSION_DENIED || error.code === status.UNAUTHENTICATED) return { kind: 'grpcSecret' }
  if (error.code === status.UNAVAILABLE) return { kind: 'offline' }
  return { kind: 'invalidResponse' }
}

type EchoReply = { message?: string; files?: string[]; sharedSecretMissing?: boolean; override?: { models?: Uint8Array } }

async function probe(client: Client, signal: AbortSignal, timeoutMs: number, sharedSecret?: string): Promise<DrawThingsReply> {
  return new Promise((resolve) => {
    const call = client.makeUnaryRequest(
      `${service}/Echo`, serialize(echoRequest), (bytes) => echoReply.decode(bytes) as EchoReply,
      { name: 'Drama Flow Studio', sharedSecret }, { deadline: Date.now() + timeoutMs },
      (error, reply) => {
        signal.removeEventListener('abort', cancel)
        if (error) return resolve(grpcError(error))
        if (reply?.sharedSecretMissing) return resolve({ kind: 'grpcSecret' })
        if (!reply?.message?.startsWith('HELLO ')) return resolve({ kind: 'invalidResponse' })
        const files = reply.files?.filter((file) => Boolean(drawThingsPreset(file))) ?? []
        if (!reply.override?.models?.length) {
          return resolve({ kind: 'ready', ...(reply.files?.length ? { models: [...new Set(files)] } : {}) })
        }
        try {
          const list: unknown = JSON.parse(Buffer.from(reply.override.models).toString('utf8'))
          if (!Array.isArray(list)) return resolve({ kind: 'invalidResponse' })
          const models = list.map((entry) => entry?.file)
            .filter((file): file is string => typeof file === 'string' && Boolean(drawThingsPreset(file)))
          // Some Echo replies expose the checkpoint and its dependencies in files before
          // the model metadata reflects the installation.
          const inventory = new Set(reply.files)
          const unlisted = [...new Set(files.filter((file) => !models.includes(file)))]
          const incompleteModels: string[] = []
          const missingComponents = new Set<string>()
          for (const file of unlisted) {
            const components = qwenImage21Components(file)
            const missing = components.filter((component) => !inventory.has(component))
            if (components.length && !missing.length) {
              models.push(file)
            } else {
              incompleteModels.push(file)
              for (const component of missing) missingComponents.add(component)
            }
          }
          resolve({
            kind: 'ready', models: [...new Set(models)],
            ...(incompleteModels.length ? { incompleteModels } : {}),
            ...(missingComponents.size ? { missingComponents: [...missingComponents] } : {})
          })
        } catch {
          resolve({ kind: 'invalidResponse' })
        }
      }
    )
    const cancel = () => call.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

type GenerateResponse = {
  generatedImages?: Uint8Array[]
  currentSignpost?: { sampling?: { step: number } }
  chunkState?: number
}

async function generate(
  client: Client, request: GenerateRequest, preset: Preset,
  signal: AbortSignal, progress: (progress: DrawThingsProgress) => void, timeoutMs: number
): Promise<DrawThingsReply> {
  const { width, height } = request
  const [image, ...refs] = (request.referencePixels || []).map((pixels) => imageTensor(pixels, width, height))
  const call = client.makeServerStreamRequest(
    `${service}/GenerateImage`, serialize(generateRequest),
    (bytes) => generateResponse.decode(bytes) as GenerateResponse,
    {
      image, scaleFactor: 1,
      hints: refs.length ? [{ hintType: 'shuffle', tensors: refs.map(tensor => ({ tensor, weight: 1 })) }] : [],
      prompt: request.prompt, negativePrompt: preset.mode === 'edit' ? ' ' : '',
      configuration: configuration(request, preset), user: 'Drama Flow Studio', device: 2, chunked: true,
      sharedSecret: request.sharedSecret || undefined
    },
    { deadline: Date.now() + timeoutMs }
  )
  const cancel = () => call.cancel()
  try {
    return await new Promise((resolve) => {
      const chunks: Buffer[] = []
      let length = 0
      let result: DrawThingsReply | undefined
      call.on('data', (reply: GenerateResponse) => {
        const sample = reply.currentSignpost?.sampling
        if (sample) progress({ step: Math.min(preset.steps, sample.step + 1), total: preset.steps })
        if (result || !reply.generatedImages?.length) return
        for (const bytes of reply.generatedImages) {
          length += bytes.length
          if (length > maxTensorBytes) {
            result = { kind: 'invalidResponse' }
            call.cancel()
            return
          }
          chunks.push(Buffer.from(bytes))
        }
        if (!reply.chunkState) result = outputPixels(Buffer.concat(chunks, length))
      })
      call.on('error', (error: ServiceError) => resolve(
        result?.kind === 'invalidResponse' ? result : grpcError(error)
      ))
      call.on('end', () => resolve(result ?? { kind: 'invalidResponse' }))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function requestDrawThingsGrpc(
  address: string, port: string, request: DrawThingsRequest, signal: AbortSignal,
  progress: (progress: DrawThingsProgress) => void, timeouts: typeof drawThingsGrpcTimeouts
): Promise<DrawThingsReply> {
  if (signal.aborted) return { kind: 'cancelled' }
  const client = new Client(`${address}:${port}`, credentials.createInsecure(), {
    'grpc.enable_http_proxy': 0,
    'grpc.enable_retries': 0,
    'grpc.max_send_message_length': maxTensorBytes,
    'grpc.max_receive_message_length': maxTensorBytes
  })
  try {
    const ready = await probe(client, signal, timeouts.probeMs, request.sharedSecret || undefined)
    if (request.kind === 'check' || ready.kind !== 'ready') return ready
    if (ready.models && !ready.models.includes(request.model)) {
      if (ready.incompleteModels?.includes(request.model)) {
        const missingComponents = qwenImage21Components(request.model)
          .filter((file) => ready.missingComponents?.includes(file))
        return { kind: 'modelIncomplete', models: ready.models, ...(missingComponents.length ? { missingComponents } : {}) }
      }
      return { kind: 'modelUnavailable', models: ready.models }
    }
    const preset = drawThingsPreset(request.model)
    if (!preset) return { kind: 'invalidRequest' }
    if (signal.aborted) return { kind: 'cancelled' }
    return await generate(client, request, preset, signal, progress, timeouts.generationMs)
  } finally {
    client.close()
  }
}
