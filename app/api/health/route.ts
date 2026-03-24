import { NextResponse } from "next/server";

/**
 * Health check endpoint - returns server status and environment info
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: {
      nodeEnv: process.env.NODE_ENV,
      blooApiKeyPresent: !!process.env.BLOO_API_KEY,
      geminiApiKeyPresent: !!process.env.GEMINI_API_KEY,
      supabaseUrlPresent: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    },
    uptime: process.uptime(),
  });
}
