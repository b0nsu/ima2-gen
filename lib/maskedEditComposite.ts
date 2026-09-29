/**
 * Deterministic pixel lock for masked edits.
 *
 * GPT Image models receive the edit mask as guidance, not as a pixel lock, so
 * they often redraw the area the user meant to keep. After the provider
 * returns, restore the source wherever the submitted mask is opaque (the
 * OpenAI mask contract: alpha 0 = editable, alpha 255 = keep). Partial alpha
 * blends source and result proportionally, so a soft mask edge stays soft.
 *
 * The blend covers all four RGBA channels, so a transparent source pixel in
 * the kept area stays transparent instead of letting the result show through.
 *
 * The output keeps the source dimensions. When the backend returns a
 * different size, the result is resized to the source first so the kept area
 * stays byte-identical to the source instead of being resampled.
 *
 * Memory is bounded twice: every decode refuses inputs above
 * MASKED_EDIT_MAX_PIXELS, and composites run one at a time, so at most one set
 * of full-size raw buffers exists however many edits run in parallel. A
 * refused input throws; the edit route then keeps the provider bytes.
 */
import sharp, { type Sharp } from "sharp";

export type MaskedEditFormat = "png" | "jpeg" | "webp";

/** 4096 x 4096: one composite then holds about 4 raw buffers of 64 MiB. */
export const MASKED_EDIT_MAX_PIXELS = 4096 * 4096;

export interface PreserveOutsideMaskInput {
  source: Buffer;
  result: Buffer;
  mask: Buffer;
  format?: MaskedEditFormat;
  quality?: number;
}

function decode(input: Buffer): Sharp {
  return sharp(input, { limitInputPixels: MASKED_EDIT_MAX_PIXELS });
}

function encode(pipeline: Sharp, format: MaskedEditFormat, quality: number): Sharp {
  const q = Math.max(1, Math.min(100, Math.round(quality) || 100));
  if (format === "jpeg") return pipeline.jpeg({ quality: q });
  if (format === "webp") return pipeline.webp({ quality: q });
  return pipeline.png();
}

function rgbaAt(input: Buffer, width: number, height: number): Promise<Buffer> {
  return decode(input).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
}

function maskAlphaAt(mask: Buffer, width: number, height: number): Promise<Buffer> {
  return decode(mask).resize(width, height, { fit: "fill" }).ensureAlpha().extractChannel("alpha").raw().toBuffer();
}

/**
 * result = source * keep + result * (1 - keep) per channel, keep = mask alpha / 255.
 * Returns whether any output pixel is not fully opaque.
 */
function blendInto(result: Buffer, source: Buffer, keep: Buffer): boolean {
  let translucent = false;
  for (let pixel = 0, base = 0; pixel < keep.length; pixel += 1, base += 4) {
    const k = keep[pixel]!;
    if (k === 255) source.copy(result, base, base, base + 4);
    else if (k !== 0) {
      for (let c = 0; c < 4; c += 1) {
        result[base + c] = Math.round((source[base + c]! * k + result[base + c]! * (255 - k)) / 255);
      }
    }
    if (result[base + 3]! < 255) translucent = true;
  }
  return translucent;
}

async function composite(input: PreserveOutsideMaskInput): Promise<Buffer> {
  const { width, height } = await decode(input.source).metadata();
  if (!width || !height) throw new Error("masked edit source dimensions are unavailable");
  if (width * height > MASKED_EDIT_MAX_PIXELS) throw new Error("masked edit source exceeds the composite pixel limit");
  const source = await rgbaAt(input.source, width, height);
  const result = await rgbaAt(input.result, width, height);
  const keep = await maskAlphaAt(input.mask, width, height);
  const translucent = blendInto(result, source, keep);
  // An all-opaque output is saved without an alpha channel, so alphaVerified
  // keeps meaning "some pixel is actually transparent".
  const pipeline = sharp(result, { raw: { width, height, channels: 4 } });
  const output = translucent ? pipeline : pipeline.removeAlpha();
  return encode(output, input.format ?? "png", input.quality ?? 100).toBuffer();
}

let queueTail: Promise<unknown> = Promise.resolve();

/** Composites run one at a time; see the memory note above. */
export function preserveOutsideMask(input: PreserveOutsideMaskInput): Promise<Buffer> {
  const run = queueTail.then(() => composite(input));
  queueTail = run.catch(() => undefined);
  return run;
}
