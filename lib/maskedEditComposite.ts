/**
 * Deterministic pixel lock for masked edits.
 *
 * GPT Image models receive the edit mask as guidance, not as a pixel lock, so
 * they often redraw the area the user meant to keep. After the provider
 * returns, restore the source wherever the submitted mask is opaque (the
 * OpenAI mask contract: alpha 0 = editable, alpha 255 = keep). Partial alpha
 * blends source and result proportionally, so a soft mask edge stays soft.
 *
 * The output keeps the source dimensions. When the backend returns a
 * different size, the result is resized to the source first so the kept area
 * stays byte-identical to the source instead of being resampled.
 */
import sharp, { type Sharp } from "sharp";

export type MaskedEditFormat = "png" | "jpeg" | "webp";

export interface PreserveOutsideMaskInput {
  source: Buffer;
  result: Buffer;
  mask: Buffer;
  format?: MaskedEditFormat;
  quality?: number;
}

function encode(pipeline: Sharp, format: MaskedEditFormat, quality: number): Sharp {
  const q = Math.max(1, Math.min(100, Math.round(quality) || 100));
  if (format === "jpeg") return pipeline.jpeg({ quality: q });
  if (format === "webp") return pipeline.webp({ quality: q });
  return pipeline.png();
}

async function keptSourceLayer(source: Buffer, mask: Buffer, width: number, height: number): Promise<Buffer> {
  const sourceRgba = await sharp(source)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const maskAlpha = await sharp(mask)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer();
  for (let pixel = 0, alpha = 3; pixel < maskAlpha.length; pixel += 1, alpha += 4) {
    sourceRgba[alpha] = Math.round((sourceRgba[alpha]! * maskAlpha[pixel]!) / 255);
  }
  return sharp(sourceRgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function preserveOutsideMask(input: PreserveOutsideMaskInput): Promise<Buffer> {
  const { width, height } = await sharp(input.source).metadata();
  if (!width || !height) throw new Error("masked edit source dimensions are unavailable");
  const kept = await keptSourceLayer(input.source, input.mask, width, height);
  const composited = await sharp(input.result)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: kept, blend: "over" }])
    .raw()
    .toBuffer();
  // An opaque result stays opaque after the source is laid over it, so drop the
  // alpha channel again rather than turning an RGB result into RGBA.
  const { hasAlpha } = await sharp(input.result).metadata();
  const flattened = sharp(composited, { raw: { width, height, channels: 4 } });
  const output = hasAlpha ? flattened : flattened.removeAlpha();
  return encode(output, input.format ?? "png", input.quality ?? 100).toBuffer();
}
