/**
 * Weavy → Node Banana workflow converter.
 *
 * Usage:
 *   npx tsx scripts/weavy-to-nodebanana.ts <input.json> [output.json]
 *   npx tsx scripts/weavy-to-nodebanana.ts <inputDir>/ <outputDir>/
 *
 * Reads a Weavy.ai-exported workflow JSON and emits a node-banana
 * WorkflowFile that can be dropped into the workflows volume.
 *
 * The converter is best-effort: nodes without a clean equivalent are
 * emitted as `stickyNote` placeholders that hold the original Weavy
 * payload as JSON so a human can reconstruct them. Routers are bypassed
 * (their inbound edges rewire to outbound targets). custom_group nodes
 * become NB groups via the existing groupId/groups system, with child
 * membership inferred from positional bounding-box containment.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────

interface WeavyPosition { x: number; y: number }

interface WeavyNode {
  id: string;
  type: string;
  position: WeavyPosition;
  data: Record<string, unknown> & {
    name?: string;
    model?: { name?: string; service?: string } | string | null;
    params?: Record<string, unknown>;
    output?: Record<string, unknown>;
    result?: unknown;
    files?: Array<{ url?: string; type?: string; thumbnailUrl?: string }>;
    color?: string;
    width?: number;
    height?: number;
  };
  style?: { width?: number; height?: number } | null;
  measured?: { width?: number; height?: number } | null;
}

interface WeavyEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface WeavyFile {
  id?: string;
  name?: string;
  nodes: WeavyNode[];
  edges: WeavyEdge[];
}

interface NBNode {
  id: string;
  type: string;
  position: WeavyPosition;
  data: Record<string, unknown>;
  style?: { width: number; height: number };
  measured?: { width: number; height: number };
  groupId?: string;
}

interface NBEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type?: string;
  animated?: boolean;
  data?: { createdAt?: number };
}

interface NBGroup {
  id: string;
  name: string;
  color: "neutral" | "blue" | "green" | "purple" | "orange" | "red";
  position: WeavyPosition;
  size: { width: number; height: number };
}

interface NBWorkflowFile {
  version: 1;
  id?: string;
  name: string;
  nodes: NBNode[];
  edges: NBEdge[];
  edgeStyle: "smoothstep" | "default" | "step" | "straight";
  groups?: Record<string, NBGroup>;
  _conversion_report?: ConversionReport;
}

interface ConversionReport {
  inputFile: string;
  totalWeavyNodes: number;
  convertedNodes: number;
  placeholderNodes: number;
  bypassedRouters: number;
  groupsCreated: number;
  edgesIn: number;
  edgesOut: number;
  edgeOrphans: number;
  unmappedTypes: Record<string, number>;
  unmappedModels: Record<string, number>;
  warnings: string[];
}

// ─── Mapping tables ────────────────────────────────────────────────────

/**
 * Per-NB-type, map a Weavy param/handle name to the NB handle id.
 * Source handle resolution (output side) and target handle resolution
 * (input side) share this table.
 */
const HANDLE_MAP: Record<string, Record<string, string>> = {
  // common Weavy param names → NB handle ids
  prompt: { default: "text" },
  text: { default: "text" },
  image: { default: "image" },
  image_url: { default: "image" },
  image_urls: { default: "image" },
  images: { default: "image" },
  input_image: { default: "image" },
  reference_image: { default: "image" },
  system_prompt: { default: "system" },
  video: { default: "video" },
  video_url: { default: "video" },
  audio: { default: "audio" },
  audio_url: { default: "audio" },
  file: { default: "image" }, // import nodes typically carry images
  out: { default: "text" }, // router fallthrough
  in: { default: "text" }, // router fallthrough
  options: { default: "text" }, // muxv2 → listSelector splits on newline
  option: { default: "text" },
  output: { default: "text" },
};

/**
 * Resolve a Weavy handle param name to an NB handle id.
 * Weavy handle ids look like `<nodeId>-output-<paramName>` or
 * `<nodeId>-input-<paramName>`. We extract the trailing `<paramName>`.
 */
function extractHandleParam(handleId: string, nodeId: string): string {
  const prefixOut = `${nodeId}-output-`;
  const prefixIn = `${nodeId}-input-`;
  if (handleId.startsWith(prefixOut)) return handleId.slice(prefixOut.length);
  if (handleId.startsWith(prefixIn)) return handleId.slice(prefixIn.length);
  // Some Weavy handles are bare param names already
  return handleId;
}

function resolveNBHandle(paramName: string): string {
  const lookup = HANDLE_MAP[paramName];
  if (lookup) return lookup.default;
  // Heuristic: if it contains "image" → image, "video" → video, "audio" → audio, else text
  const lower = paramName.toLowerCase();
  if (lower.includes("image") || lower.includes("photo") || lower.includes("file")) return "image";
  if (lower.includes("video")) return "video";
  if (lower.includes("audio") || lower.includes("voice") || lower.includes("sound")) return "audio";
  if (lower.includes("3d") || lower.includes("mesh") || lower.includes("glb")) return "3d";
  if (lower.includes("system")) return "system";
  return "text";
}

/**
 * custommodelV2 inner-model mapping: maps Weavy's `data.model.name` (or
 * `data.model` if it's a string) to an NB node type + model identifier.
 */
interface ModelMapping {
  nbType: "nanoBanana" | "llmGenerate" | "generateVideo" | "generate3d";
  /** node-banana model identifier (provider's own) */
  modelId: string;
  /** node-banana SelectedModel.provider */
  provider: "gemini" | "openai" | "kie" | "fal";
  displayName: string;
}

const MODEL_MAP: Record<string, ModelMapping> = {
  "fal-ai/nano-banana-pro/edit": {
    nbType: "nanoBanana",
    modelId: "nano-banana-pro",
    provider: "gemini",
    displayName: "Nano Banana Pro",
  },
  "fal-ai/nano-banana-2/edit": {
    nbType: "nanoBanana",
    modelId: "nano-banana-2",
    provider: "gemini",
    displayName: "Nano Banana 2",
  },
  any_llm: {
    nbType: "llmGenerate",
    modelId: "gemini-2.5-flash",
    provider: "gemini",
    displayName: "Gemini 2.5 Flash",
  },
  "fal-ai/hyper3d/rodin/v2": {
    nbType: "generate3d",
    modelId: "fal-ai/hyper3d/rodin/v2",
    provider: "fal",
    displayName: "Hyper3D Rodin v2",
  },
  kling: {
    nbType: "generateVideo",
    modelId: "fal-ai/kling-video/v2.1/standard/image-to-video",
    provider: "fal",
    displayName: "Kling 2.1 (i2v)",
  },
  "fal-ai/kling-video/v3/pro/image-to-video": {
    // NB has v3/standard, not v3/pro — closest match
    nbType: "generateVideo",
    modelId: "fal-ai/kling-video/v3/standard/image-to-video",
    provider: "fal",
    displayName: "Kling v3 Standard (i2v)",
  },
  "fal-ai/bytedance/seedream/v4.5/edit": {
    // map to kie.ai equivalent
    nbType: "nanoBanana",
    modelId: "seedream/4.5-edit",
    provider: "kie",
    displayName: "Seedream 4.5 Edit",
  },
  "fal-ai/flux-2-pro": {
    nbType: "nanoBanana",
    modelId: "flux-2/pro-image-to-image",
    provider: "kie",
    displayName: "Flux 2 Pro",
  },
  "google-veo3-i2v": {
    nbType: "generateVideo",
    modelId: "veo-3.1-fast-generate-001",
    provider: "gemini",
    displayName: "Veo 3.1 Fast",
  },
  sora: {
    nbType: "generateVideo",
    modelId: "sora",
    provider: "kie",
    displayName: "Sora",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Mirrors src/store/utils/nodeDefaults.ts `defaultNodeDimensions`. Kept
 * inline so the script has no compile-time dependency on the app code.
 */
const NB_DEFAULT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  imageInput: { width: 300, height: 280 },
  audioInput: { width: 300, height: 200 },
  annotation: { width: 300, height: 280 },
  prompt: { width: 320, height: 220 },
  promptConstructor: { width: 300, height: 220 },
  promptConcatenator: { width: 320, height: 240 },
  nanoBanana: { width: 300, height: 300 },
  generateVideo: { width: 300, height: 300 },
  generate3d: { width: 300, height: 300 },
  llmGenerate: { width: 320, height: 360 },
  splitGrid: { width: 300, height: 320 },
  output: { width: 320, height: 320 },
  outputGallery: { width: 320, height: 360 },
  imageCompare: { width: 400, height: 360 },
  videoStitch: { width: 400, height: 280 },
  easeCurve: { width: 340, height: 480 },
  glbViewer: { width: 360, height: 380 },
  imageIterator: { width: 340, height: 300 },
  textIterator: { width: 340, height: 280 },
  webScraper: { width: 340, height: 320 },
  stickyNote: { width: 320, height: 240 },
  soraBlueprint: { width: 320, height: 360 },
  brollBatch: { width: 380, height: 420 },
  arrayNode: { width: 320, height: 320 },
  listSelector: { width: 280, height: 200 },
  imageFilter: { width: 320, height: 400 },
  zipIterator: { width: 340, height: 380 },
  subWorkflow: { width: 320, height: 280 },
};

const GROUP_COLORS = ["neutral", "blue", "green", "purple", "orange", "red"] as const;
let groupColorCounter = 0;
function nextGroupColor(): NBGroup["color"] {
  return GROUP_COLORS[groupColorCounter++ % GROUP_COLORS.length];
}

function getModelKey(node: WeavyNode): string | null {
  const m = node.data.model;
  if (!m) return null;
  if (typeof m === "string") return m;
  if (typeof m === "object" && m.name) return m.name;
  return null;
}

function getNodeSize(node: WeavyNode): { width: number; height: number } | null {
  // For custom_group nodes, data.width/height ARE the group box size.
  // For other Weavy node types (notably `import`), data.width/height
  // describe the image's pixel dimensions, NOT the node card — using
  // them would make image cards balloon to image size on the canvas.
  if (node.type === "custom_group" && node.data.width && node.data.height) {
    return { width: node.data.width, height: node.data.height };
  }
  if (node.style?.width && node.style?.height) {
    return { width: node.style.width, height: node.style.height };
  }
  if (node.measured?.width && node.measured?.height) {
    return { width: node.measured.width, height: node.measured.height };
  }
  return null;
}

// ─── Node converters ───────────────────────────────────────────────────

/**
 * Build NB node data for a converted node. Returns null if conversion
 * is not possible — caller will emit a stickyNote placeholder.
 */
function convertWeavyNode(
  node: WeavyNode,
  report: ConversionReport
): { nbType: string; data: Record<string, unknown> } | null {
  switch (node.type) {
    case "stickynote": {
      const text = (node.data as { text?: string; content?: string; description?: string }).text
        ?? (node.data as { content?: string }).content
        ?? (node.data as { description?: string }).description
        ?? node.data.name
        ?? "";
      return { nbType: "stickyNote", data: { text: String(text), color: "yellow" } };
    }

    case "promptV3":
    case "string": {
      const promptText = (node.data as { prompt?: string }).prompt
        ?? (node.data as { value?: string }).value
        ?? (node.data.output as { prompt?: string; text?: string; value?: string } | undefined)?.prompt
        ?? (node.data.output as { text?: string } | undefined)?.text
        ?? (node.data.output as { value?: string } | undefined)?.value
        ?? "";
      return {
        nbType: "prompt",
        data: { prompt: String(promptText), prompts: [String(promptText)], activePromptIndex: 0 },
      };
    }

    case "prompt_concat": {
      const params = node.data.params as { separator?: string } | null | undefined;
      return {
        nbType: "promptConcatenator",
        data: {
          separator: params?.separator ?? "\n",
          outputText: null,
          textInputHandles: 2,
        },
      };
    }

    case "import": {
      const file = node.data.files?.[0];
      const url = file?.url ?? null;
      return {
        nbType: "imageInput",
        data: {
          image: url,
          filename: url ? path.basename(url.split("?")[0]) : null,
          dimensions: file?.type === "image"
            ? { width: (file as { width?: number }).width ?? 0, height: (file as { height?: number }).height ?? 0 }
            : null,
        },
      };
    }

    case "preview": {
      return {
        nbType: "output",
        data: { image: null, video: null, contentType: "image" },
      };
    }

    case "media_iterator": {
      return {
        nbType: "imageIterator",
        data: {
          inputImages: [],
          sourceMode: "files",
          localImages: [],
          driveUrl: "",
          mode: "all",
          randomCount: 1,
          imageInputHandles: 1,
          status: "idle",
          error: null,
        },
      };
    }

    case "array": {
      const params = node.data.params as { options?: unknown[]; stringArray?: string[] } | null | undefined;
      const items = (params?.stringArray ?? params?.options ?? [])
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      return {
        nbType: "arrayNode",
        data: {
          items: items.length > 0 ? items : ["Item 1"],
          currentItem: null,
          status: "idle",
          error: null,
        },
      };
    }

    case "muxv2": {
      // Weavy's list_selector — map to NB listSelector. Its options
      // typically come from an upstream `array` node via the `options`
      // input edge (handled by edge remap), but it can also hold static
      // `params.options` baked in.
      const params = node.data.params as { options?: unknown[] } | null | undefined;
      const baked = (params?.options ?? []).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v)
      );
      return {
        nbType: "listSelector",
        data: {
          items: baked.length > 0 ? baked : ["Option A"],
          selectedIndex: 0,
          outputText: baked[0] ?? "Option A",
          splitMode: "newline",
          customSeparator: "",
        },
      };
    }

    case "custommodelV2": {
      const modelKey = getModelKey(node);
      if (!modelKey) {
        report.warnings.push(`custommodelV2 with no model name: ${node.id}`);
        return null;
      }
      const mapping = MODEL_MAP[modelKey];
      if (!mapping) {
        report.unmappedModels[modelKey] = (report.unmappedModels[modelKey] ?? 0) + 1;
        return null;
      }
      const params = (node.data.params ?? {}) as Record<string, unknown>;

      switch (mapping.nbType) {
        case "nanoBanana":
          return {
            nbType: "nanoBanana",
            data: {
              inputImages: [],
              inputPrompt: (params.prompt as string) ?? null,
              systemPrompt: null,
              outputImage: null,
              aspectRatio: (params.aspect_ratio as string) ?? "auto",
              resolution: (params.resolution as string) ?? "1K",
              model: mapping.modelId,
              selectedModel: {
                provider: mapping.provider,
                modelId: mapping.modelId,
                displayName: mapping.displayName,
              },
              useGoogleSearch: false,
              parameters: { ...params },
              status: "idle",
              error: null,
              imageHistory: [],
              selectedHistoryIndex: 0,
              imageInputHandles: 2,
            },
          };
        case "llmGenerate":
          return {
            nbType: "llmGenerate",
            data: {
              inputPrompt: (params.prompt as string) ?? null,
              systemPrompt: (params.system_prompt as string) ?? null,
              inputImages: [],
              outputText: null,
              outputHistory: [],
              selectedHistoryIndex: -1,
              provider: mapping.provider === "openai" ? "openai" : "google",
              model: (params.model as string) ?? mapping.modelId,
              temperature: (params.temperature as number) ?? 0.7,
              maxTokens: 2048,
              status: "idle",
              error: null,
            },
          };
        case "generateVideo":
          return {
            nbType: "generateVideo",
            data: {
              inputImages: [],
              inputPrompt: (params.prompt as string) ?? null,
              outputVideo: null,
              selectedModel: {
                provider: mapping.provider,
                modelId: mapping.modelId,
                displayName: mapping.displayName,
              },
              parameters: { ...params },
              status: "idle",
              error: null,
              videoHistory: [],
              selectedVideoHistoryIndex: -1,
            },
          };
        case "generate3d":
          return {
            nbType: "generate3d",
            data: {
              inputImages: [],
              inputPrompt: (params.prompt as string) ?? null,
              output3dUrl: null,
              selectedModel: {
                provider: mapping.provider,
                modelId: mapping.modelId,
                displayName: mapping.displayName,
              },
              parameters: { ...params },
              status: "idle",
              error: null,
            },
          };
      }
      return null;
    }

    default:
      return null;
  }
}

function makePlaceholder(node: WeavyNode, reason: string): NBNode {
  const summary = `[Weavy ${node.type}${
    node.data.name ? ` — ${node.data.name}` : ""
  }]\n${reason}\n\nOriginal payload:\n${JSON.stringify(node.data, null, 2).slice(0, 1500)}`;
  const size = NB_DEFAULT_DIMENSIONS.stickyNote;
  return {
    id: node.id,
    type: "stickyNote",
    position: node.position,
    style: size,
    measured: size,
    data: {
      text: summary,
      color: "pink",
    },
  };
}

// ─── Group inference ───────────────────────────────────────────────────

function pointInBox(
  pt: WeavyPosition,
  box: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    pt.x >= box.x &&
    pt.x <= box.x + box.width &&
    pt.y >= box.y &&
    pt.y <= box.y + box.height
  );
}

function inferGroups(
  weavyNodes: WeavyNode[],
  nbNodesById: Map<string, NBNode>,
  report: ConversionReport
): Record<string, NBGroup> {
  const groups: Record<string, NBGroup> = {};
  const groupNodes = weavyNodes.filter((n) => n.type === "custom_group");
  if (groupNodes.length === 0) return groups;

  // Sort largest area first so smaller groups (nested) take precedence
  groupNodes.sort((a, b) => {
    const aSize = getNodeSize(a);
    const bSize = getNodeSize(b);
    const aArea = (aSize?.width ?? 0) * (aSize?.height ?? 0);
    const bArea = (bSize?.width ?? 0) * (bSize?.height ?? 0);
    return bArea - aArea;
  });

  for (const g of groupNodes) {
    const size = getNodeSize(g);
    if (!size) {
      report.warnings.push(`group ${g.id} has no size; skipping`);
      continue;
    }
    const groupId = g.id;
    groups[groupId] = {
      id: groupId,
      name: (g.data.name as string) || "Group",
      color: nextGroupColor(),
      position: g.position,
      size,
    };

    // Assign children by bbox containment (last assignment wins, which
    // is the smallest containing group due to sort order)
    const box = { ...g.position, ...size };
    for (const [, child] of nbNodesById) {
      if (child.id === groupId) continue;
      if (pointInBox(child.position, box)) {
        child.groupId = groupId;
      }
    }
  }
  report.groupsCreated = Object.keys(groups).length;
  return groups;
}

// ─── Edge bypass for routers ───────────────────────────────────────────

function bypassRouters(
  weavyNodes: WeavyNode[],
  weavyEdges: WeavyEdge[],
  report: ConversionReport
): WeavyEdge[] {
  const routerIds = new Set(
    weavyNodes.filter((n) => n.type === "router").map((n) => n.id)
  );
  if (routerIds.size === 0) return weavyEdges;

  const incomingByRouter = new Map<string, WeavyEdge[]>();
  const outgoingByRouter = new Map<string, WeavyEdge[]>();
  const passThrough: WeavyEdge[] = [];

  for (const e of weavyEdges) {
    if (routerIds.has(e.target)) {
      const arr = incomingByRouter.get(e.target) ?? [];
      arr.push(e);
      incomingByRouter.set(e.target, arr);
    } else if (routerIds.has(e.source)) {
      const arr = outgoingByRouter.get(e.source) ?? [];
      arr.push(e);
      outgoingByRouter.set(e.source, arr);
    } else {
      passThrough.push(e);
    }
  }

  const newEdges: WeavyEdge[] = [...passThrough];
  for (const routerId of routerIds) {
    const ins = incomingByRouter.get(routerId) ?? [];
    const outs = outgoingByRouter.get(routerId) ?? [];
    for (const inEdge of ins) {
      for (const outEdge of outs) {
        newEdges.push({
          id: `bypass-${inEdge.id}-${outEdge.id}`,
          source: inEdge.source,
          sourceHandle: inEdge.sourceHandle,
          target: outEdge.target,
          targetHandle: outEdge.targetHandle,
          type: "custom",
        });
      }
    }
  }
  report.bypassedRouters = routerIds.size;
  return newEdges;
}

// ─── Top-level convert ─────────────────────────────────────────────────

export function convertWeavyToNB(
  weavy: WeavyFile,
  inputFileLabel: string
): NBWorkflowFile {
  const report: ConversionReport = {
    inputFile: inputFileLabel,
    totalWeavyNodes: weavy.nodes.length,
    convertedNodes: 0,
    placeholderNodes: 0,
    bypassedRouters: 0,
    groupsCreated: 0,
    edgesIn: weavy.edges.length,
    edgesOut: 0,
    edgeOrphans: 0,
    unmappedTypes: {},
    unmappedModels: {},
    warnings: [],
  };

  // Step 1: bypass routers
  const edgesAfterBypass = bypassRouters(weavy.nodes, weavy.edges, report);

  // Step 2: convert each node (except routers and groups, handled separately)
  const nbNodesById = new Map<string, NBNode>();
  for (const wnode of weavy.nodes) {
    if (wnode.type === "router") continue; // dropped by bypass
    if (wnode.type === "custom_group") continue; // handled by inferGroups; we don't emit a node

    const converted = convertWeavyNode(wnode, report);
    if (converted) {
      const size =
        getNodeSize(wnode) ??
        NB_DEFAULT_DIMENSIONS[converted.nbType] ??
        { width: 300, height: 280 };
      const nb: NBNode = {
        id: wnode.id,
        type: converted.nbType,
        position: wnode.position,
        data: converted.data,
        style: size,
        measured: size,
      };
      nbNodesById.set(wnode.id, nb);
      report.convertedNodes++;
    } else {
      report.unmappedTypes[wnode.type] = (report.unmappedTypes[wnode.type] ?? 0) + 1;
      const ph = makePlaceholder(wnode, `Type "${wnode.type}" has no NB equivalent yet.`);
      nbNodesById.set(wnode.id, ph);
      report.placeholderNodes++;
    }
  }

  // Step 3: groups (assigns groupId on nbNodes by bbox)
  const groups = inferGroups(weavy.nodes, nbNodesById, report);

  // Step 4: remap edges
  const nbEdges: NBEdge[] = [];
  for (const e of edgesAfterBypass) {
    const sourceNode = nbNodesById.get(e.source);
    const targetNode = nbNodesById.get(e.target);
    if (!sourceNode || !targetNode) {
      report.edgeOrphans++;
      continue;
    }
    const sourceParam = extractHandleParam(e.sourceHandle, e.source);
    const targetParam = extractHandleParam(e.targetHandle, e.target);
    const sourceHandle = resolveNBHandle(sourceParam);
    const targetHandle = resolveNBHandle(targetParam);
    nbEdges.push({
      id: `edge-${e.source}-${e.target}-${sourceHandle}-${targetHandle}-${nbEdges.length}`,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      type: "editable",
      animated: false,
      data: { createdAt: Date.now() },
    });
  }
  report.edgesOut = nbEdges.length;

  const out: NBWorkflowFile = {
    version: 1,
    id: weavy.id,
    name: weavy.name ?? "Imported Weavy Workflow",
    nodes: Array.from(nbNodesById.values()),
    edges: nbEdges,
    edgeStyle: "smoothstep",
    ...(Object.keys(groups).length > 0 ? { groups } : {}),
    _conversion_report: report,
  };
  return out;
}

// ─── CLI ───────────────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/_+/g, "_");
}

function processFile(inputPath: string, outputPath: string): ConversionReport {
  const raw = fs.readFileSync(inputPath, "utf8");
  const weavy = JSON.parse(raw) as WeavyFile;
  const nb = convertWeavyToNB(weavy, path.basename(inputPath));

  fs.writeFileSync(outputPath, JSON.stringify(nb, null, 2));
  return nb._conversion_report!;
}

function printReport(r: ConversionReport): void {
  const ratio = r.totalWeavyNodes > 0
    ? Math.round((r.convertedNodes / r.totalWeavyNodes) * 100)
    : 0;
  console.log(`\n${r.inputFile}`);
  console.log(`  ${r.convertedNodes}/${r.totalWeavyNodes} nodes converted (${ratio}%), ${r.placeholderNodes} placeholders`);
  console.log(`  edges: ${r.edgesIn} → ${r.edgesOut} (${r.edgeOrphans} orphans), ${r.bypassedRouters} routers bypassed, ${r.groupsCreated} groups`);
  if (Object.keys(r.unmappedTypes).length > 0) {
    console.log(`  unmapped types:`, r.unmappedTypes);
  }
  if (Object.keys(r.unmappedModels).length > 0) {
    console.log(`  unmapped models:`, r.unmappedModels);
  }
  if (r.warnings.length > 0) {
    console.log(`  warnings: ${r.warnings.length}`);
    for (const w of r.warnings.slice(0, 3)) console.log(`    - ${w}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/weavy-to-nodebanana.ts <input.json|dir/> [output.json|dir/]");
    process.exit(1);
  }
  const inputArg = args[0];
  const outputArg = args[1];

  if (isDir(inputArg)) {
    const outDir = outputArg ?? path.join(path.dirname(inputArg), "converted");
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(inputArg).filter((f) => f.endsWith(".json"));
    let totalIn = 0, totalConv = 0, totalPh = 0;
    for (const f of files) {
      const inP = path.join(inputArg, f);
      const outP = path.join(outDir, sanitizeFilename(f.replace(/^weavy-/, "").replace(/\.json$/, "") + ".json"));
      const r = processFile(inP, outP);
      printReport(r);
      totalIn += r.totalWeavyNodes;
      totalConv += r.convertedNodes;
      totalPh += r.placeholderNodes;
    }
    console.log(`\n=== Summary: ${files.length} files, ${totalConv}/${totalIn} nodes converted (${totalPh} placeholders) ===`);
  } else {
    const outputPath = outputArg ?? inputArg.replace(/\.json$/, ".nb.json");
    const r = processFile(inputArg, outputPath);
    printReport(r);
    console.log(`\nWrote: ${outputPath}`);
  }
}

main();
