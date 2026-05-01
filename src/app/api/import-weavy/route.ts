/**
 * Import Weavy Workflow API
 *
 * Accepts a Weavy.ai workflow JSON (either as a parsed object or a
 * raw string) and returns the converted node-banana WorkflowFile.
 *
 * POST /api/import-weavy
 * Body: { weavy: object | string, filename?: string }
 * Response:
 *   { success: true, workflow: NBWorkflowFile, report: ConversionReport }
 *   | { success: false, error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { convertWeavyToNB, type WeavyFile } from "@/lib/weavyConverter";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const filename = typeof body.filename === "string" ? body.filename : "weavy.json";

    let weavy: WeavyFile;
    if (typeof body.weavy === "string") {
      try {
        weavy = JSON.parse(body.weavy) as WeavyFile;
      } catch {
        return NextResponse.json(
          { success: false, error: "Could not parse the JSON. Make sure the file is a valid Weavy export." },
          { status: 400 }
        );
      }
    } else if (body.weavy && typeof body.weavy === "object") {
      weavy = body.weavy as WeavyFile;
    } else {
      return NextResponse.json(
        { success: false, error: "Missing 'weavy' field — pass the workflow JSON as a string or object." },
        { status: 400 }
      );
    }

    if (!Array.isArray(weavy.nodes) || !Array.isArray(weavy.edges)) {
      return NextResponse.json(
        { success: false, error: "JSON does not look like a Weavy workflow (missing nodes/edges arrays)." },
        { status: 400 }
      );
    }

    const workflow = convertWeavyToNB(weavy, filename);
    const report = workflow._conversion_report;

    return NextResponse.json({
      success: true,
      workflow,
      report,
    });
  } catch (error) {
    console.error("[ImportWeavy] error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Import failed",
      },
      { status: 500 }
    );
  }
}
