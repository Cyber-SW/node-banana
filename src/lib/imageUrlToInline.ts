/**
 * Normalize an image input to `{ data, mimeType }` for providers that need
 * inline base64 (Gemini `inlineData`, Anthropic `source.data`).
 *
 * Accepts three input shapes:
 *  - `data:<mime>;base64,<b64>`  → split into parts as-is
 *  - `http(s)://...`             → fetched and base64-encoded server-side
 *  - anything else               → treated as raw base64, mime defaulted to image/png
 *
 * Used to bridge Weavy-imported workflows that store CDN URLs in `data.image`
 * (e.g. https://media.weavy.ai/...) — Gemini rejects raw URLs in `inline_data`.
 */
export interface InlineImage {
  data: string;
  mimeType: string;
}

const FETCH_TIMEOUT_MS = 30_000;

export async function imageInputToInline(input: string): Promise<InlineImage> {
  const dataUrlMatch = input.match(/^data:(.+?);base64,(.+)$/);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1], data: dataUrlMatch[2] };
  }

  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status}): ${input}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return { data: buffer.toString("base64"), mimeType };
  }

  return { data: input, mimeType: "image/png" };
}

export async function imageInputsToInline(inputs: string[]): Promise<InlineImage[]> {
  return Promise.all(inputs.map(imageInputToInline));
}
