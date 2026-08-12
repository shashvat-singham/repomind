import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepoMind — Codebase Intelligence Agent",
  description:
    "Hybrid RAG over any GitHub repo: AST-aware chunking, an agentic tool loop with cited answers, an MCP server, and a CI-gated eval harness.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
