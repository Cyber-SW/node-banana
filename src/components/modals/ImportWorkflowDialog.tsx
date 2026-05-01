"use client";

import { useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore, WorkflowFile } from "@/store/workflowStore";

type ImportTab = "screenshot" | "notion" | "weavy";

interface ImportWorkflowDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export function ImportWorkflowDialog({ isOpen, onClose }: ImportWorkflowDialogProps) {
    const [activeTab, setActiveTab] = useState<ImportTab>("screenshot");
    const [image, setImage] = useState<string | null>(null);
    const [notionUrl, setNotionUrl] = useState("");
    const [weavyJson, setWeavyJson] = useState<string>("");
    const [weavyFilename, setWeavyFilename] = useState<string>("");
    const [isImporting, setIsImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<string>("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const weavyFileInputRef = useRef<HTMLInputElement>(null);
    const loadWorkflow = useWorkflowStore((state) => state.loadWorkflow);

    const getGeminiKey = (): string | undefined => {
        try {
            const settingsJson = localStorage.getItem("node-banana-provider-settings");
            const settings = settingsJson ? JSON.parse(settingsJson) : {};
            return settings?.providers?.gemini?.apiKey;
        } catch {
            return undefined;
        }
    };

    // ---- Screenshot handlers ----
    const handleImageUpload = useCallback((file: File) => {
        if (!file.type.startsWith("image/")) {
            setError("Please upload an image file (PNG, JPG, etc.)");
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            setError("Image too large. Max 20MB.");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            setImage(e.target?.result as string);
            setError(null);
        };
        reader.readAsDataURL(file);
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) handleImageUpload(file);
        },
        [handleImageUpload]
    );

    const handlePaste = useCallback(
        (e: React.ClipboardEvent) => {
            const items = e.clipboardData.items;
            for (const item of Array.from(items)) {
                if (item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file) handleImageUpload(file);
                    break;
                }
            }
        },
        [handleImageUpload]
    );

    const handleImportScreenshot = useCallback(async () => {
        if (!image) return;
        setIsImporting(true);
        setError(null);
        setProgress("AI is reading the workflow structure...");

        try {
            const headers: HeadersInit = { "Content-Type": "application/json" };
            const geminiKey = getGeminiKey();
            if (geminiKey) headers["X-Gemini-API-Key"] = geminiKey;

            const response = await fetch("/api/import-workflow", {
                method: "POST",
                headers,
                body: JSON.stringify({ image }),
            });

            const result = await response.json();
            if (!result.success) {
                setError(result.error || "Import failed");
                return;
            }

            setProgress(`Found ${result.workflow.nodes.length} nodes! Loading...`);
            await new Promise((r) => setTimeout(r, 400));
            await loadWorkflow(result.workflow as WorkflowFile);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setIsImporting(false);
            setProgress("");
        }
    }, [image, loadWorkflow, onClose]);

    // ---- Notion handlers ----
    const handleImportNotion = useCallback(async () => {
        if (!notionUrl.trim()) return;
        setIsImporting(true);
        setError(null);
        setProgress("Fetching Notion page...");

        try {
            const headers: HeadersInit = { "Content-Type": "application/json" };
            const geminiKey = getGeminiKey();
            if (geminiKey) headers["X-Gemini-API-Key"] = geminiKey;

            setProgress("Scraping SOP content & Loom transcripts...");

            const response = await fetch("/api/import-notion", {
                method: "POST",
                headers,
                body: JSON.stringify({ url: notionUrl.trim() }),
            });

            const result = await response.json();
            if (!result.success) {
                setError(result.error || "Import failed");
                return;
            }

            setProgress(`Generated ${result.workflow.nodes.length} nodes from SOP! Loading...`);
            await new Promise((r) => setTimeout(r, 400));
            await loadWorkflow(result.workflow as WorkflowFile);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setIsImporting(false);
            setProgress("");
        }
    }, [notionUrl, loadWorkflow, onClose]);

    // ---- Weavy JSON handlers ----
    const handleWeavyFile = useCallback((file: File) => {
        if (!file.name.endsWith(".json") && file.type !== "application/json") {
            setError("Please upload a .json file exported from Weavy.");
            return;
        }
        if (file.size > 25 * 1024 * 1024) {
            setError("File too large. Max 25MB.");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            setWeavyJson(text);
            setWeavyFilename(file.name);
            setError(null);
        };
        reader.readAsText(file);
    }, []);

    const handleWeavyDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) handleWeavyFile(file);
        },
        [handleWeavyFile]
    );

    const handleImportWeavy = useCallback(async () => {
        if (!weavyJson.trim()) return;
        setIsImporting(true);
        setError(null);
        setProgress("Converting Weavy workflow...");

        try {
            const response = await fetch("/api/import-weavy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ weavy: weavyJson, filename: weavyFilename || "weavy.json" }),
            });
            const result = await response.json();
            if (!result.success) {
                setError(result.error || "Import failed");
                return;
            }
            const r = result.report;
            const ratio = r ? Math.round((r.convertedNodes / Math.max(1, r.totalWeavyNodes)) * 100) : 100;
            setProgress(`Converted ${result.workflow.nodes.length} nodes (${ratio}%). Loading...`);
            await new Promise((r) => setTimeout(r, 400));
            await loadWorkflow(result.workflow as WorkflowFile);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setIsImporting(false);
            setProgress("");
        }
    }, [weavyJson, weavyFilename, loadWorkflow, onClose]);

    const handleClose = useCallback(() => {
        if (isImporting) return;
        setImage(null);
        setNotionUrl("");
        setWeavyJson("");
        setWeavyFilename("");
        setError(null);
        setProgress("");
        onClose();
    }, [isImporting, onClose]);

    if (!isOpen) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            onClick={handleClose}
            onPaste={handlePaste}
        >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

            <div
                className="relative w-full max-w-[640px] mx-4 rounded-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: "linear-gradient(180deg, #1a1a1e 0%, #131315 100%)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 25px 100px rgba(0,0,0,0.6), 0 0 60px rgba(249,115,22,0.05)",
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-3">
                        <div
                            className="w-8 h-8 rounded-xl flex items-center justify-center"
                            style={{
                                background: "linear-gradient(135deg, #f97316, #ef4444)",
                                boxShadow: "0 2px 10px rgba(249,115,22,0.3)",
                            }}
                        >
                            {activeTab === "screenshot" ? (
                                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                                </svg>
                            ) : (
                                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                </svg>
                            )}
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-white">Import Workflow</h2>
                            <p className="text-[11px] text-[#666]">
                                {activeTab === "screenshot" ? "From workflow screenshot"
                                    : activeTab === "notion" ? "From Notion SOP page"
                                    : "From Weavy.ai JSON export"}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleClose}
                        disabled={isImporting}
                        className="w-7 h-7 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center text-[#666] hover:text-white transition-all disabled:opacity-30"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Tab bar */}
                <div className="px-6 pt-3 flex gap-1">
                    <button
                        onClick={() => { if (!isImporting) { setActiveTab("screenshot"); setError(null); } }}
                        className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${activeTab === "screenshot"
                                ? "bg-white/[0.08] text-white"
                                : "text-[#666] hover:text-[#999] hover:bg-white/[0.03]"
                            }`}
                    >
                        📷 Screenshot
                    </button>
                    <button
                        onClick={() => { if (!isImporting) { setActiveTab("notion"); setError(null); } }}
                        className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${activeTab === "notion"
                                ? "bg-white/[0.08] text-white"
                                : "text-[#666] hover:text-[#999] hover:bg-white/[0.03]"
                            }`}
                    >
                        📋 Notion SOP
                    </button>
                    <button
                        onClick={() => { if (!isImporting) { setActiveTab("weavy"); setError(null); } }}
                        className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${activeTab === "weavy"
                                ? "bg-white/[0.08] text-white"
                                : "text-[#666] hover:text-[#999] hover:bg-white/[0.03]"
                            }`}
                    >
                        🧬 Weavy JSON
                    </button>
                </div>

                {/* Content */}
                <div className="px-6 py-4">
                    {/* ===== Screenshot tab ===== */}
                    {activeTab === "screenshot" && (
                        <>
                            {image ? (
                                <div className="relative rounded-xl overflow-hidden border border-white/[0.08] bg-black">
                                    <img src={image} alt="Workflow screenshot" className="w-full max-h-[360px] object-contain" />
                                    {!isImporting && (
                                        <button
                                            onClick={() => { setImage(null); setError(null); }}
                                            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/60 backdrop-blur-sm border border-white/10 flex items-center justify-center text-[#999] hover:text-white hover:bg-black/80 transition-all"
                                        >✕</button>
                                    )}
                                    {isImporting && (
                                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                                            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-orange-500 animate-spin" />
                                            <span className="text-sm text-white/90 font-medium">{progress}</span>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <label
                                    className="flex flex-col items-center justify-center w-full h-[200px] rounded-xl border-2 border-dashed border-white/[0.08] hover:border-orange-500/30 hover:bg-orange-500/[0.02] cursor-pointer transition-all duration-300 group"
                                    onDrop={handleDrop}
                                    onDragOver={(e) => e.preventDefault()}
                                >
                                    <div
                                        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300"
                                        style={{ background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.12)" }}
                                    >
                                        <svg className="w-6 h-6 text-[#555] group-hover:text-orange-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                                        </svg>
                                    </div>
                                    <span className="text-sm text-[#666] group-hover:text-[#999] transition-colors mb-1">
                                        Drop screenshot or click to upload
                                    </span>
                                    <span className="text-[11px] text-[#444]">
                                        Or press <kbd className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[#888] text-[10px] font-mono">⌘V</kbd> to paste
                                    </span>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleImageUpload(file);
                                        }}
                                    />
                                </label>
                            )}
                            <div className="mt-3 flex items-center gap-2">
                                <span className="text-[10px] text-[#444] uppercase tracking-widest">Works with</span>
                                <div className="flex items-center gap-1.5">
                                    {["Weavy", "ComfyUI", "n8n", "Make", "Zapier"].map((tool) => (
                                        <span key={tool} className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-[#777]">
                                            {tool}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {/* ===== Notion SOP tab ===== */}
                    {activeTab === "notion" && (
                        <>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-[#777] mb-1.5 block">Notion Page URL</label>
                                    <input
                                        type="url"
                                        value={notionUrl}
                                        onChange={(e) => { setNotionUrl(e.target.value); setError(null); }}
                                        placeholder="https://notion.so/your-sop-page-..."
                                        disabled={isImporting}
                                        className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08] text-white text-sm placeholder:text-[#444] focus:outline-none focus:border-orange-500/40 focus:ring-1 focus:ring-orange-500/20 transition-all duration-200 disabled:opacity-50"
                                    />
                                </div>

                                {isImporting && (
                                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-orange-500/[0.04] border border-orange-500/[0.08]">
                                        <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-orange-500 animate-spin shrink-0" />
                                        <span className="text-sm text-orange-300">{progress}</span>
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <p className="text-xs text-[#555]">
                                        The AI will extract SOP steps and convert them into workflow nodes:
                                    </p>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        {[
                                            { from: "Upload steps", to: "→ Image Input" },
                                            { from: "Generate image", to: "→ Generate Image" },
                                            { from: "Write/describe", to: "→ LLM Generate" },
                                            { from: "Review/approve", to: "→ Output Gallery" },
                                            { from: "Repeat/iterate", to: "→ Iterator nodes" },
                                            { from: "Loom transcripts", to: "→ Sticky Notes" },
                                        ].map(({ from, to }) => (
                                            <div key={from} className="flex items-center gap-1.5 text-[11px]">
                                                <span className="text-[#666]">{from}</span>
                                                <span className="text-orange-400/70">{to}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                                <p className="text-[10px] text-[#555]">
                                    ⓘ The Notion page must be <strong className="text-[#888]">shared publicly</strong> (Share → Share to web).
                                    Embedded Loom videos will have their transcripts extracted automatically.
                                </p>
                            </div>
                        </>
                    )}

                    {/* ===== Weavy JSON tab ===== */}
                    {activeTab === "weavy" && (
                        <>
                            {weavyJson ? (
                                <div className="rounded-xl border border-white/[0.08] bg-black/40 p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <svg className="w-4 h-4 text-orange-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                            <span className="text-sm text-white truncate">{weavyFilename || "pasted JSON"}</span>
                                            <span className="text-[11px] text-[#555] shrink-0">{Math.round(weavyJson.length / 1024)} KB</span>
                                        </div>
                                        {!isImporting && (
                                            <button
                                                onClick={() => { setWeavyJson(""); setWeavyFilename(""); setError(null); }}
                                                className="text-[#999] hover:text-white text-xs ml-3"
                                            >Clear</button>
                                        )}
                                    </div>
                                    {isImporting && (
                                        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-orange-500/[0.04] border border-orange-500/[0.08]">
                                            <div className="w-4 h-4 rounded-full border-2 border-white/10 border-t-orange-500 animate-spin shrink-0" />
                                            <span className="text-xs text-orange-300">{progress}</span>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <label
                                    className="flex flex-col items-center justify-center w-full h-[200px] rounded-xl border-2 border-dashed border-white/[0.08] hover:border-orange-500/30 hover:bg-orange-500/[0.02] cursor-pointer transition-all duration-300 group"
                                    onDrop={handleWeavyDrop}
                                    onDragOver={(e) => e.preventDefault()}
                                >
                                    <div
                                        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300"
                                        style={{ background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.12)" }}
                                    >
                                        <svg className="w-6 h-6 text-[#555] group-hover:text-orange-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    </div>
                                    <span className="text-sm text-[#666] group-hover:text-[#999] transition-colors mb-1">
                                        Drop a Weavy export .json or click to upload
                                    </span>
                                    <span className="text-[11px] text-[#444]">
                                        Workspace exports work too — anything with nodes + edges.
                                    </span>
                                    <input
                                        ref={weavyFileInputRef}
                                        type="file"
                                        accept=".json,application/json"
                                        className="hidden"
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleWeavyFile(file);
                                        }}
                                    />
                                </label>
                            )}
                            <div className="mt-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                                <p className="text-[10px] text-[#555]">
                                    ⓘ Conversion runs locally — no AI calls, no upload. Unmappable nodes
                                    (compv3, levels, etc.) become sticky-note placeholders so you can rebuild them.
                                </p>
                            </div>
                        </>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="mt-3 px-4 py-2.5 rounded-xl bg-red-500/[0.06] border border-red-500/[0.12]">
                            <p className="text-sm text-red-400">{error}</p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-between">
                    <p className="text-[11px] text-[#444] max-w-[300px]">
                        {activeTab === "screenshot"
                            ? "AI will analyze the screenshot and recreate the workflow."
                            : activeTab === "notion"
                                ? "AI will read the SOP and build a workflow from its steps."
                                : "Direct conversion of a Weavy export — no AI."}
                    </p>
                    {(() => {
                        const onClick = activeTab === "screenshot"
                            ? handleImportScreenshot
                            : activeTab === "notion"
                                ? handleImportNotion
                                : handleImportWeavy;
                        const empty = activeTab === "screenshot"
                            ? !image
                            : activeTab === "notion"
                                ? !notionUrl.trim()
                                : !weavyJson.trim();
                        return (
                            <button
                                onClick={onClick}
                                disabled={empty || isImporting}
                                className="px-5 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 hover:brightness-110"
                                style={{
                                    background: empty || isImporting
                                        ? "rgba(255,255,255,0.06)"
                                        : "linear-gradient(135deg, #f97316, #ef4444)",
                                    boxShadow: empty || isImporting
                                        ? "none"
                                        : "0 2px 12px rgba(249,115,22,0.3)",
                                }}
                            >
                                {isImporting ? "Importing..." : "Import Workflow"}
                            </button>
                        );
                    })()}
                </div>
            </div>
        </div>,
        document.body
    );
}
