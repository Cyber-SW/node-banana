"use client";

import { useState, useCallback, useRef } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { PromptWorkflowView } from "./PromptWorkflowView";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile) => void;
  onClose: () => void;
  onNewProject: () => void;
}

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>("initial");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleSelectTemplates = useCallback(() => {
    setCurrentView("templates");
  }, []);

  const handleSelectVibe = useCallback(() => {
    setCurrentView("vibe");
  }, []);

  const handleSelectLoad = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        const text = event.target?.result as string;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          alert("Failed to parse JSON file");
          return;
        }

        if (!parsed || typeof parsed !== "object") {
          alert("Invalid workflow file format");
          return;
        }

        // Sniff Weavy export — its top-level shape resembles NB's
        // (version + nodes + edges) but uses Weavy-specific node types
        // and parent reparenting. If we see any Weavy marker, route
        // through the converter.
        const obj = parsed as { workspaceId?: unknown; organizationId?: unknown; nodes?: Array<{ type?: string }> };
        const WEAVY_NODE_TYPES = new Set([
          "custommodelV2",
          "promptV3",
          "muxv2",
          "prompt_concat",
          "custom_group",
          "compv3",
          "stickynote", // Weavy uses lowercase, NB uses stickyNote
        ]);
        const looksLikeWeavy =
          obj.workspaceId !== undefined ||
          obj.organizationId !== undefined ||
          (Array.isArray(obj.nodes) && obj.nodes.some((n) => n?.type && WEAVY_NODE_TYPES.has(n.type)));

        if (looksLikeWeavy) {
          try {
            const res = await fetch("/api/import-weavy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ weavy: text, filename: file.name }),
            });
            const result = await res.json();
            if (!result.success) {
              alert(result.error || "Failed to convert Weavy workflow");
              return;
            }
            onWorkflowGenerated(result.workflow as WorkflowFile);
          } catch (err) {
            alert(err instanceof Error ? err.message : "Weavy conversion failed");
          }
          return;
        }

        // Native NB workflow
        const workflow = parsed as WorkflowFile;
        if (workflow.version && workflow.nodes && workflow.edges) {
          onWorkflowGenerated(workflow);
        } else {
          alert("Invalid workflow file format");
        }
      };
      reader.readAsText(file);

      // Reset input so same file can be loaded again
      e.target.value = "";
    },
    [onWorkflowGenerated]
  );

  const handleBack = useCallback(() => {
    setCurrentView("initial");
  }, []);

  const handleWorkflowSelected = useCallback(
    (workflow: WorkflowFile) => {
      onWorkflowGenerated(workflow);
    },
    [onWorkflowGenerated]
  );

  // Click outside to close (only on initial view)
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && currentView === "initial") {
        onClose();
      }
    },
    [onClose, currentView]
  );

  return (
    <div
      className="fixed inset-0 z-[100] bg-[var(--bg-base)]/95 backdrop-blur-sm overflow-y-auto overscroll-contain"
      onWheelCapture={(e) => e.stopPropagation()}
      onClick={handleOverlayClick}
    >
      {currentView === "initial" && (
        <QuickstartInitialView
          onNewProject={handleNewProject}
          onSelectTemplates={handleSelectTemplates}
          onSelectVibe={handleSelectVibe}
          onSelectLoad={handleSelectLoad}
          onWorkflowSelected={handleWorkflowSelected}
        />
      )}
      {currentView === "templates" && (
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="w-full max-w-6xl bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-subtle)] shadow-2xl overflow-clip max-h-[85vh] flex flex-col">
            <TemplateExplorerView
              onBack={handleBack}
              onWorkflowSelected={handleWorkflowSelected}
            />
          </div>
        </div>
      )}
      {currentView === "vibe" && (
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="w-full max-w-2xl bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-subtle)] shadow-2xl overflow-clip max-h-[80vh] flex flex-col">
            <PromptWorkflowView
              onBack={handleBack}
              onWorkflowGenerated={handleWorkflowSelected}
            />
          </div>
        </div>
      )}

      {/* Hidden file input for loading workflows */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json"
        className="hidden"
      />
    </div>
  );
}
