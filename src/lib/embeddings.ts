import { config } from '../config.js'
import { logger } from './logger.js'

// Local, in-process text embeddings via @huggingface/transformers (transformers.js).
//
// No external service and no API key: the model runs inside the app process on
// CPU. The pipeline is loaded lazily (the first embed() call) so startup stays
// fast and nothing is loaded at all when EMBEDDING_ENABLED=false.
//
// The model weights (~25 MB quantized) download once on first use and are cached
// in EMBEDDING_CACHE_DIR. onnxruntime-node ships glibc-only prebuilt binaries,
// which is why the Docker image is node:22-slim (Debian) rather than -alpine.

// transformers.js is ESM and fairly heavy, so we import it dynamically the first
// time it is needed instead of at module load.
type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>

let extractorPromise: Promise<FeatureExtractor> | null = null
let warnedUnavailable = false

// Roughly the model's context window in characters. all-MiniLM truncates at
// ~256 tokens; slicing keeps us from feeding huge posts into the tokenizer.
const MAX_CHARS = 2000

export function embeddingsEnabled(): boolean {
  return config.EMBEDDING_ENABLED
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      // Persist weights to a writable, mountable directory and never reach out
      // to the Hub once cached.
      env.cacheDir = config.EMBEDDING_CACHE_DIR
      logger.info(
        { model: config.EMBEDDING_MODEL, dtype: config.EMBEDDING_DTYPE },
        'Loading embedding model (first use; downloads weights if not cached)',
      )
      const extractor = await pipeline('feature-extraction', config.EMBEDDING_MODEL, {
        // dtype is a string in our config; transformers.js types it as a union.
        dtype: config.EMBEDDING_DTYPE as 'q8' | 'fp32' | 'fp16' | 'auto',
      })
      logger.info('Embedding model ready')
      return extractor as unknown as FeatureExtractor
    })().catch((err) => {
      // Reset so a later call can retry (e.g. transient download failure).
      extractorPromise = null
      throw err
    })
  }
  return extractorPromise
}

/**
 * Embed a single piece of text into a unit-length vector.
 *
 * Returns null (never throws) when embeddings are disabled, the text is empty,
 * or the model fails to load/run — callers treat null as "fall back to keyword".
 */
export async function embedText(text: string | null | undefined): Promise<number[] | null> {
  if (!config.EMBEDDING_ENABLED) return null
  const trimmed = text?.trim()
  if (!trimmed) return null

  try {
    const extractor = await getExtractor()
    const output = await extractor(trimmed.slice(0, MAX_CHARS), {
      pooling: 'mean',
      normalize: true,
    })
    const vec = Array.from(output.data as ArrayLike<number>)
    if (vec.length !== config.EMBEDDING_DIMENSIONS) {
      logger.warn(
        { expected: config.EMBEDDING_DIMENSIONS, got: vec.length },
        'Embedding dimension mismatch — check EMBEDDING_MODEL vs EMBEDDING_DIMENSIONS and the vector(N) column',
      )
      return null
    }
    return vec
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      logger.warn({ err }, 'Embedding model unavailable — semantic search will fall back to keyword')
    }
    return null
  }
}

/** Format a JS number[] as a pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}
