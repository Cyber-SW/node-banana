/**
 * Gemini Provider for Generate API Route
 *
 * Handles image generation using Google's Gemini API models.
 */

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GenerateResponse, ModelType } from "@/types";
import { imageInputsToInline } from "@/lib/imageUrlToInline";

/**
 * Map model types to Gemini API model IDs.
 * These are the "friendly" names exposed in the UI.
 */
export const MODEL_MAP: Record<string, string> = {
  "nano-banana": "gemini-2.5-flash-image",                    // Flash-quality image generation
  "nano-banana-2": "gemini-3.1-flash-image-preview",          // Nano Banana 2 (Gemini 3.1 Flash)
  "nano-banana-pro": "gemini-3.1-flash-image-preview",         // Pro remapped to 3.1 Flash (Pro model times out behind Cloudflare)
  "veo-2.0-generate-video-001": "veo-2.0-generate-video-001",
  "veo-3.1-fast-generate-001": "veo-3.1-fast-generate-001",
  // Allow direct Gemini model IDs to pass through
  "gemini-2.5-flash-image": "gemini-2.5-flash-image",
  "gemini-2.5-flash-preview-image-generation": "gemini-2.5-flash-image", // Legacy alias
  "gemini-2.0-flash-exp": "gemini-3.1-flash-image-preview",               // Deprecated → 3.1 Flash
  "gemini-2.0-flash-exp-image-generation": "gemini-2.0-flash-exp-image-generation",
  "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
  "nano-banana-pro-preview": "nano-banana-pro-preview",
};

/**
 * Resolve a model type/ID to the actual Gemini API model ID.
 * If the model is not in the map, pass it through as-is (allows future models).
 */
function resolveGeminiModelId(model: string): string {
  return MODEL_MAP[model] || model;
}


/**
 * Generate image using Gemini API (legacy/default path)
 */
export async function generateWithGemini(
  requestId: string,
  apiKey: string,
  prompt: string,
  images: string[],
  model: ModelType,
  aspectRatio?: string,
  resolution?: string,
  useGoogleSearch?: boolean
): Promise<NextResponse<GenerateResponse>> {
  console.log(`[API:${requestId}] Gemini generation - Model: ${model}, Images: ${images?.length || 0}, Prompt: ${prompt?.length || 0} chars`);

  // Normalize inputs to inline base64. Handles data URLs, raw base64, and
  // http(s) URLs (e.g. Weavy CDN URLs left in imported workflows).
  const imageData = await imageInputsToInline(images || []);
  imageData.forEach(({ data, mimeType }, idx) => {
    console.log(`[API:${requestId}]   Image ${idx + 1}: ${mimeType}, ${(data.length / 1024).toFixed(1)}KB`);
  });

  // Initialize Gemini client
  const ai = new GoogleGenAI({ apiKey });

  // Convert first image for potentially Use in Veo 2
  let firstImageData: { data: string, mimeType: string } | undefined;
  if (imageData.length > 0) {
    firstImageData = imageData[0];
  }

  // Handle Veo Video Generation (Veo 2 and Veo 3.1 Fast)
  const VEO_MODELS = ["veo-2.0-generate-video-001", "veo-3.1-fast-generate-001"];
  if (VEO_MODELS.includes(model)) {
    const resolvedModel = resolveGeminiModelId(model);
    console.log(`[API:${requestId}] Starting ${resolvedModel} video generation`);
    try {
      const operation = await ai.models.generateVideos({
        model: resolvedModel,
        prompt: prompt,
        // Wait, the new API has `image` as input
        ...(firstImageData && {
          image: {
            imageBytes: firstImageData.data,
            mimeType: firstImageData.mimeType,
          }
        })
      });

      console.log(`[API:${requestId}] Veo operation started: ${operation.name || 'unknown'}`);

      // Poll for completion
      let currentOp = operation;
      let attempts = 0;
      const MAX_ATTEMPTS = 60; // 5 minutes max

      while (!currentOp.done && attempts < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 5000));
        attempts++;
        if (attempts % 6 === 0) {
          console.log(`[API:${requestId}] Polling Veo operation... (${attempts * 5}s)`);
        }

        try {
          if (ai.operations && (ai.operations as any).get) {
            currentOp = await (ai.operations as any).get({ name: currentOp.name });
          } else {
            currentOp = await (ai.models as any).getVideosOperation({ operation: { name: currentOp.name } } as any);
          }
        } catch (e) {
          console.error(`[API:${requestId}] Polling error:`, e);
          // Don't break immediately, might be a transient network error
        }
      }

      if (!currentOp.done) {
        throw new Error("Video generation timed out after 5 minutes.");
      }

      if (currentOp.error) {
        throw new Error(`Video generation failed: ${JSON.stringify(currentOp.error)}`);
      }

      const generatedVideos = currentOp.response?.generatedVideos;
      if (!generatedVideos || generatedVideos.length === 0 || !generatedVideos[0].video) {
        throw new Error("API returned no video data.");
      }

      const videoData = generatedVideos[0].video;

      // Ensure we return data URI correctly
      if (videoData.videoBytes) {
        const mimeType = videoData.mimeType || "video/mp4";
        const videoDataUri = `data:${mimeType};base64,${videoData.videoBytes}`;
        return NextResponse.json<GenerateResponse>({
          success: true,
          video: videoDataUri,
          contentType: "video",
        });
      } else if (videoData.uri) {
        return NextResponse.json<GenerateResponse>({
          success: true,
          videoUrl: videoData.uri,
          contentType: "video",
        });
      } else {
        throw new Error("Video output contained neither bytes nor URI.");
      }
    } catch (e) {
      console.error(`[API:${requestId}] Veo Error:`, e);
      return NextResponse.json<GenerateResponse>({
        success: false,
        error: e instanceof Error ? e.message : "Unknown Veo error",
      }, { status: 500 });
    }
  }

  // Build request parts array with prompt and all images for standard Gemini Image Generation
  const requestParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
    ...imageData.map(({ data, mimeType }) => ({
      inlineData: {
        mimeType,
        data,
      },
    })),
  ];

  // Build config object based on model capabilities
  const config: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };

  // Add imageConfig for both models (both support aspect ratio)
  if (aspectRatio) {
    config.imageConfig = {
      aspectRatio,
    };
  }

  // Add resolution for Pro and Nano Banana 2
  if ((model === "nano-banana-pro" || model === "nano-banana-2") && resolution) {
    if (!config.imageConfig) {
      config.imageConfig = {};
    }
    (config.imageConfig as Record<string, unknown>).imageSize = resolution;
  }

  // Add tools array for Google Search (Pro and Nano Banana 2)
  const tools = [];
  if ((model === "nano-banana-pro" || model === "nano-banana-2") && useGoogleSearch) {
    tools.push({ googleSearch: {} });
  }

  console.log(`[API:${requestId}] Config: ${JSON.stringify(config)}`);

  // Make request to Gemini
  const geminiStartTime = Date.now();

  const response = await ai.models.generateContent({
    model: resolveGeminiModelId(model),
    contents: [
      {
        role: "user",
        parts: requestParts,
      },
    ],
    config,
    ...(tools.length > 0 && { tools }),
  });

  const geminiDuration = Date.now() - geminiStartTime;
  console.log(`[API:${requestId}] Gemini API completed in ${geminiDuration}ms`);

  // Extract image from response
  const candidates = response.candidates;

  if (!candidates || candidates.length === 0) {
    console.error(`[API:${requestId}] No candidates in Gemini response`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No response from AI model",
      },
      { status: 500 }
    );
  }

  const parts = candidates[0].content?.parts;
  console.log(`[API:${requestId}] Response parts: ${parts?.length || 0}`);

  if (!parts) {
    console.error(`[API:${requestId}] No parts in Gemini candidate content`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No content in response",
      },
      { status: 500 }
    );
  }

  // Find image part in response
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      const mimeType = part.inlineData.mimeType || "image/png";
      const imgData = part.inlineData.data;
      const imageSizeKB = (imgData.length / 1024).toFixed(1);

      console.log(`[API:${requestId}] Output image: ${mimeType}, ${imageSizeKB}KB`);

      const dataUrl = `data:${mimeType};base64,${imgData}`;

      const responsePayload = { success: true, image: dataUrl };
      const responseSize = JSON.stringify(responsePayload).length;
      const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);

      if (responseSize > 4.5 * 1024 * 1024) {
        console.warn(`[API:${requestId}] Response size (${responseSizeMB}MB) approaching Next.js 5MB limit`);
      }

      console.log(`[API:${requestId}] SUCCESS - Returning ${responseSizeMB}MB payload`);

      return NextResponse.json<GenerateResponse>(responsePayload);
    }
  }

  // If no image found, check for text error
  for (const part of parts) {
    if (part.text) {
      console.error(`[API:${requestId}] Gemini returned text instead of image: ${part.text.substring(0, 100)}`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Model returned text instead of image: ${part.text.substring(0, 200)}`,
        },
        { status: 500 }
      );
    }
  }

  console.error(`[API:${requestId}] No image or text found in Gemini response`);
  return NextResponse.json<GenerateResponse>(
    {
      success: false,
      error: "No image in response",
    },
    { status: 500 }
  );
}
