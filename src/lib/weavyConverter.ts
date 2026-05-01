/**
 * Weavy → Node Banana workflow converter (browser/server-safe).
 *
 * Converts a Weavy.ai workflow JSON into an NB WorkflowFile shape that
 * can be loaded by `useWorkflowStore.loadWorkflow`. Best-effort: nodes
 * without a clean equivalent become stickyNote placeholders that hold
 * the original Weavy payload as JSON.
 *
 * No filesystem or process access — safe to import in API routes and
 * client components alike.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface WeavyPosition { x: number; y: number }

export interface WeavyNode {
  id: string;
  type: string;
  position: WeavyPosition;
  /** React Flow parent reference. Child positions are RELATIVE to this parent. */
  parentId?: string | null;
  parentNode?: string | null;
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

export interface WeavyEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface WeavyFile {
  id?: string;
  name?: string;
  nodes: WeavyNode[];
  edges: WeavyEdge[];
}

export interface NBNode {
  id: string;
  type: string;
  position: WeavyPosition;
  data: Record<string, unknown>;
  style?: { width: number; height: number };
  measured?: { width: number; height: number };
  groupId?: string;
}

export interface NBEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type?: string;
  animated?: boolean;
  data?: { createdAt?: number };
}

export interface NBGroup {
  id: string;
  name: string;
  color: "neutral" | "blue" | "green" | "purple" | "orange" | "red";
  position: WeavyPosition;
  size: { width: number; height: number };
}

export interface NBWorkflowFile {
  version: 1;
  id?: string;
  name: string;
  nodes: NBNode[];
  edges: NBEdge[];
  edgeStyle: "smoothstep" | "default" | "step" | "straight";
  groups?: Record<string, NBGroup>;
  _conversion_report?: ConversionReport;
}

export interface ConversionReport {
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
  out: { default: "text" },   // router fallthrough
  in: { default: "text" },    // router fallthrough
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
  return handleId;
}

function resolveNBHandle(paramName: string): string {
  const lookup = HANDLE_MAP[paramName];
  if (lookup) return lookup.default;
  const lower = paramName.toLowerCase();
  if (lower.includes("image") || lower.includes("photo") || lower.includes("file")) return "image";
  if (lower.includes("video")) return "video";
  if (lower.includes("audio") || lower.includes("voice") || lower.includes("sound")) return "audio";
  if (lower.includes("3d") || lower.includes("mesh") || lower.includes("glb")) return "3d";
  if (lower.includes("system")) return "system";
  return "text";
}

interface ModelMapping {
  nbType: "nanoBanana" | "llmGenerate" | "generateVideo" | "generate3d";
  modelId: string;
  provider: "gemini" | "openai" | "kie" | "fal";
  displayName: string;
}

const MODEL_MAP: Record<string, ModelMapping> = {
  "fal-ai/nano-banana-pro/edit": {
    nbType: "nanoBanana", modelId: "nano-banana-pro", provider: "gemini", displayName: "Nano Banana Pro",
  },
  "fal-ai/nano-banana-2/edit": {
    nbType: "nanoBanana", modelId: "nano-banana-2", provider: "gemini", displayName: "Nano Banana 2",
  },
  any_llm: {
    nbType: "llmGenerate", modelId: "gemini-2.5-flash", provider: "gemini", displayName: "Gemini 2.5 Flash",
  },
  "fal-ai/hyper3d/rodin/v2": {
    nbType: "generate3d", modelId: "fal-ai/hyper3d/rodin/v2", provider: "fal", displayName: "Hyper3D Rodin v2",
  },
  kling: {
    nbType: "generateVideo", modelId: "fal-ai/kling-video/v2.1/standard/image-to-video", provider: "fal", displayName: "Kling 2.1 (i2v)",
  },
  "fal-ai/kling-video/v3/pro/image-to-video": {
    nbType: "generateVideo", modelId: "fal-ai/kling-video/v3/standard/image-to-video", provider: "fal", displayName: "Kling v3 Standard (i2v)",
  },
  "fal-ai/bytedance/seedream/v4.5/edit": {
    nbType: "nanoBanana", modelId: "seedream/4.5-edit", provider: "kie", displayName: "Seedream 4.5 Edit",
  },
  "fal-ai/flux-2-pro": {
    nbType: "nanoBanana", modelId: "flux-2/pro-image-to-image", provider: "kie", displayName: "Flux 2 Pro",
  },
  "google-veo3-i2v": {
    nbType: "generateVideo", modelId: "veo-3.1-fast-generate-001", provider: "gemini", displayName: "Veo 3.1 Fast",
  },
  sora: {
    nbType: "generateVideo", modelId: "sora", provider: "kie", displayName: "Sora",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────

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

function basenameFromUrl(url: string): string {
  // Strip query string, then take the trailing path segment.
  const noQuery = url.split("?")[0];
  const lastSlash = noQuery.lastIndexOf("/");
  return lastSlash >= 0 ? noQuery.slice(lastSlash + 1) : noQuery;
}

function getModelKey(node: WeavyNode): string | null {
  const m = node.data.model;
  if (!m) return null;
  if (typeof m === "string") return m;
  if (typeof m === "object" && m.name) return m.name;
  return null;
}

function getNodeSize(node: WeavyNode): { width: number; height: number } | null {
  // For custom_group, data.width/height ARE the group box. For other
  // types (notably `import`), those describe the IMAGE pixel size and
  // must not be applied to the node card.
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
 *
 * `incomingEdgeCount` is the number of edges (post router-bypass) that
 * target this node. Some Weavy types (notably `array`) behave
 * differently when used as aggregators vs. static sources.
 */
function convertWeavyNode(
  node: WeavyNode,
  report: ConversionReport,
  incomingEdgeCount: number
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
          textInputHandles: Math.max(2, incomingEdgeCount),
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
          filename: url ? basenameFromUrl(url) : null,
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
      // Aggregator (incoming edges) → promptConcatenator
      // Static source (no edges) → arrayNode
      const params = node.data.params as { options?: unknown[]; stringArray?: string[] } | null | undefined;
      const items = (params?.stringArray ?? params?.options ?? [])
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      if (incomingEdgeCount > 0) {
        return {
          nbType: "promptConcatenator",
          data: {
            separator: "\n",
            outputText: null,
            textInputHandles: Math.max(2, incomingEdgeCount),
          },
        };
      }
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

/**
 * Resolve absolute position for a Weavy node by walking up its
 * parentId chain. Weavy stores child positions relative to their
 * parent group; NB groups don't reparent.
 */
function resolveAbsolutePosition(
  node: WeavyNode,
  byId: Map<string, WeavyNode>
): WeavyPosition {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId ?? node.parentNode ?? null;
  const seen = new Set<string>([node.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId ?? parent.parentNode ?? null;
  }
  return { x, y };
}

function buildGroups(
  weavyNodes: WeavyNode[],
  weavyById: Map<string, WeavyNode>,
  nbNodesById: Map<string, NBNode>,
  report: ConversionReport
): Record<string, NBGroup> {
  const groups: Record<string, NBGroup> = {};
  const groupNodes = weavyNodes.filter((n) => n.type === "custom_group");
  if (groupNodes.length === 0) return groups;

  let colorIdx = 0;
  for (const g of groupNodes) {
    const size = getNodeSize(g);
    if (!size) {
      report.warnings.push(`group ${g.id} has no size; skipping`);
      continue;
    }
    const groupId = g.id;
    const absPos = resolveAbsolutePosition(g, weavyById);
    groups[groupId] = {
      id: groupId,
      name: (g.data.name as string) || "Group",
      color: GROUP_COLORS[colorIdx++ % GROUP_COLORS.length],
      position: absPos,
      size,
    };
  }

  for (const wnode of weavyNodes) {
    if (wnode.type === "custom_group") continue;
    let pid = wnode.parentId ?? wnode.parentNode ?? null;
    while (pid) {
      if (groups[pid]) {
        const nb = nbNodesById.get(wnode.id);
        if (nb) nb.groupId = pid;
        break;
      }
      const parent = weavyById.get(pid);
      pid = parent ? parent.parentId ?? parent.parentNode ?? null : null;
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
  inputFileLabel = "weavy.json"
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

  const edgesAfterBypass = bypassRouters(weavy.nodes, weavy.edges, report);

  const incomingByNode = new Map<string, number>();
  for (const e of edgesAfterBypass) {
    incomingByNode.set(e.target, (incomingByNode.get(e.target) ?? 0) + 1);
  }

  const weavyById = new Map<string, WeavyNode>();
  for (const n of weavy.nodes) weavyById.set(n.id, n);

  const nbNodesById = new Map<string, NBNode>();
  for (const wnode of weavy.nodes) {
    if (wnode.type === "router") continue;
    if (wnode.type === "custom_group") continue;

    const inCount = incomingByNode.get(wnode.id) ?? 0;
    const converted = convertWeavyNode(wnode, report, inCount);
    const absPos = resolveAbsolutePosition(wnode, weavyById);
    if (converted) {
      const size =
        getNodeSize(wnode) ??
        NB_DEFAULT_DIMENSIONS[converted.nbType] ??
        { width: 300, height: 280 };
      const nb: NBNode = {
        id: wnode.id,
        type: converted.nbType,
        position: absPos,
        data: converted.data,
        style: size,
        measured: size,
      };
      nbNodesById.set(wnode.id, nb);
      report.convertedNodes++;
    } else {
      report.unmappedTypes[wnode.type] = (report.unmappedTypes[wnode.type] ?? 0) + 1;
      const ph = makePlaceholder(wnode, `Type "${wnode.type}" has no NB equivalent yet.`);
      ph.position = absPos;
      nbNodesById.set(wnode.id, ph);
      report.placeholderNodes++;
    }
  }

  const groups = buildGroups(weavy.nodes, weavyById, nbNodesById, report);

  // Edge mapping with multi-input slot indexing.
  const TEXT_MULTI = new Set(["promptConcatenator", "promptConstructor"]);
  const IMAGE_MULTI = new Set([
    "nanoBanana",
    "llmGenerate",
    "generateVideo",
    "generate3d",
    "soraBlueprint",
    "brollBatch",
    "imageIterator",
    "imageFilter",
    "zipIterator",
  ]);

  const slotCount = new Map<string, number>();
  const slotKey = (target: string, base: string) => `${target}|${base}`;
  function indexedHandle(target: string, baseHandle: string, targetType: string): string {
    const isMulti =
      (baseHandle === "text" && TEXT_MULTI.has(targetType)) ||
      (baseHandle === "image" && IMAGE_MULTI.has(targetType));
    if (!isMulti) return baseHandle;
    const k = slotKey(target, baseHandle);
    const idx = slotCount.get(k) ?? 0;
    slotCount.set(k, idx + 1);
    return idx === 0 ? baseHandle : `${baseHandle}-${idx}`;
  }

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
    const targetBase = resolveNBHandle(targetParam);
    const targetHandle = indexedHandle(e.target, targetBase, targetNode.type);
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

  for (const [k, count] of slotCount) {
    const [targetId, base] = k.split("|");
    const node = nbNodesById.get(targetId);
    if (!node) continue;
    if (base === "text" && TEXT_MULTI.has(node.type)) {
      const data = node.data as { textInputHandles?: number; inputCount?: number };
      if ("textInputHandles" in data) {
        data.textInputHandles = Math.max(data.textInputHandles ?? 2, count);
      }
      if ("inputCount" in data) {
        data.inputCount = Math.max(data.inputCount ?? 2, count);
      }
    } else if (base === "image" && IMAGE_MULTI.has(node.type)) {
      const data = node.data as { imageInputHandles?: number };
      data.imageInputHandles = Math.max(data.imageInputHandles ?? 1, count);
    }
  }

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

  // Density normalization + anti-overlap repulsion. Weavy spreads
  // nodes ~3.5x wider than native NB, so we scale down then push
  // apart any clusters that ended up overlapping.
  rescaleLayout(out, 0.3);
  separateOverlappingNodes(out);
  refitGroups(out);

  return out;
}

/**
 * Iteratively push apart any pair of node cards whose bounding boxes
 * overlap. Pushes along the smaller-overlap axis to minimize layout
 * disruption.
 */
function separateOverlappingNodes(
  wf: NBWorkflowFile,
  iterations = 300,
  gap = 20
): void {
  if (wf.nodes.length < 2) return;
  const n = wf.nodes.length;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = wf.nodes[i];
      const aw = a.style?.width ?? 300;
      const ah = a.style?.height ?? 280;
      for (let j = i + 1; j < n; j++) {
        const b = wf.nodes[j];
        const bw = b.style?.width ?? 300;
        const bh = b.style?.height ?? 280;

        const acx = a.position.x + aw / 2;
        const acy = a.position.y + ah / 2;
        const bcx = b.position.x + bw / 2;
        const bcy = b.position.y + bh / 2;
        const dx = bcx - acx;
        const dy = bcy - acy;

        const overlapX = (aw + bw) / 2 + gap - Math.abs(dx);
        const overlapY = (ah + bh) / 2 + gap - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        if (overlapX < overlapY) {
          const push = overlapX / 2;
          if (dx === 0) {
            a.position.x -= push;
            b.position.x += push;
          } else if (dx < 0) {
            a.position.x += push;
            b.position.x -= push;
          } else {
            a.position.x -= push;
            b.position.x += push;
          }
        } else {
          const push = overlapY / 2;
          if (dy === 0) {
            a.position.y -= push;
            b.position.y += push;
          } else if (dy < 0) {
            a.position.y += push;
            b.position.y -= push;
          } else {
            a.position.y -= push;
            b.position.y += push;
          }
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const node of wf.nodes) {
    node.position = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    };
  }
}

function refitGroups(wf: NBWorkflowFile): void {
  if (!wf.groups) return;
  const PAD = 40;
  const HEADER = 40;
  for (const groupId of Object.keys(wf.groups)) {
    const members = wf.nodes.filter((n) => n.groupId === groupId);
    if (members.length === 0) {
      delete wf.groups[groupId];
      continue;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const w = m.style?.width ?? 300;
      const h = m.style?.height ?? 280;
      if (m.position.x < minX) minX = m.position.x;
      if (m.position.y < minY) minY = m.position.y;
      if (m.position.x + w > maxX) maxX = m.position.x + w;
      if (m.position.y + h > maxY) maxY = m.position.y + h;
    }
    wf.groups[groupId].position = { x: minX - PAD, y: minY - PAD - HEADER };
    wf.groups[groupId].size = {
      width: maxX - minX + PAD * 2,
      height: maxY - minY + PAD * 2 + HEADER,
    };
  }
}

function rescaleLayout(wf: NBWorkflowFile, scale: number): void {
  if (wf.nodes.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  for (const n of wf.nodes) {
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.y < minY) minY = n.position.y;
  }
  if (wf.groups) {
    for (const g of Object.values(wf.groups)) {
      if (g.position.x < minX) minX = g.position.x;
      if (g.position.y < minY) minY = g.position.y;
    }
  }
  if (!isFinite(minX)) minX = 0;
  if (!isFinite(minY)) minY = 0;

  for (const n of wf.nodes) {
    n.position = {
      x: Math.round((n.position.x - minX) * scale),
      y: Math.round((n.position.y - minY) * scale),
    };
  }
  if (wf.groups) {
    for (const g of Object.values(wf.groups)) {
      g.position = {
        x: Math.round((g.position.x - minX) * scale),
        y: Math.round((g.position.y - minY) * scale),
      };
      g.size = {
        width: Math.round(g.size.width * scale),
        height: Math.round(g.size.height * scale),
      };
    }
  }
}
