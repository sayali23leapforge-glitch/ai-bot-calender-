import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Global middleware to catch unhandled errors and prevent server crashes
 */
export function middleware(request: NextRequest) {
  try {
    // Log all incoming requests to help debug issues
    if (request.url.includes("/api/")) {
      console.log(`[Middleware] ${request.method} ${request.nextUrl.pathname}`);
    }
    return NextResponse.next();
  } catch (error) {
    console.error("[Middleware] Unhandled error:", error);
    // Return 500 but keep server alive
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Only run middleware on API routes
export const config = {
  matcher: ["/api/:path*"],
};
