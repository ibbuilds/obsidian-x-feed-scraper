import type {Access, Evaluation, Metadata, Profile} from "../core/types.ts";
import {normalizeUrl} from "../core/url.ts";

export function evaluate(url: string, title: string, context: string, metadata: Metadata, profile: Profile,
  existingReferences: ReadonlySet<string> = new Set()): Evaluation {
  const reasons: string[] = [];
  const host = new URL(url).hostname.toLowerCase();
  if (profile.excludeDomains.some(d => host === d || host.endsWith("." + d))) {
    return {category: "excluded", score: 0, confidence: 1, status: "rejected", access: "unknown", reasons: ["Excluded domain by profile"]};
  }
  if (existingReferences.has(normalizeUrl(url))) {
    return {category: "existing_reference", score: 0, confidence: 1, status: "needs_review", access: "unknown", reasons: ["Already present in References.md"]};
  }
  const text = (title + " " + context + " " + (metadata.description || "")).toLowerCase();
  let category = "uncategorized";
  let matches = 0;
  for (const c of profile.categories) {
    const count = c.keywords.filter(k => text.includes(k.toLowerCase())).length;
    if (count > matches) { matches = count; category = c.name; }
  }
  let score = 0;
  if (matches) {score += Math.min(42, 17 + matches * 8); reasons.push("Topic matches " + category);}
  else reasons.push("No strong profile relevance signal");
  if (metadata.title && metadata.title.length >= 8) {score += 12; reasons.push("Public title detected");}
  if (metadata.description && metadata.description.length >= 50) {score += 18; reasons.push("Substantive description available");}
  if (metadata.contentType?.includes("html")) {score += 8; reasons.push("HTML page metadata");}
  if (host === "github.com" && url.split("/").filter(Boolean).length >= 5) {
    score += 9; reasons.push("Public GitHub repository URL (license not assumed)");
  }
  const access: Access = metadata.access || "unknown";
  if (profile.preferFree && (access === "free" || access === "open_source")) {
    score += 12; reasons.push("Verified free or open-source access");
  } else if (access === "paid") {score = Math.max(0, score - 12); reasons.push("Paid access");}
  if (metadata.license) {score += 5; reasons.push("License evidence: " + metadata.license);}
  const evidence = [Boolean(metadata.title), Boolean(metadata.description), Boolean(metadata.contentType),
    access !== "unknown", Boolean(metadata.license)].filter(Boolean).length;
  // Relevance in a post is a lead, not proof of a source's quality.
  const confidence = Math.min(0.95, Number((0.15 + evidence * 0.15 + (matches ? 0.08 : 0)).toFixed(2)));
  score = Math.min(100, Math.round(score));
  const status = score >= profile.scoreThreshold && confidence >= profile.confidenceThreshold
    ? "high_quality" : "needs_review";
  if (confidence < profile.confidenceThreshold) reasons.push("Insufficient external evidence for automatic high-quality status");
  reasons.push("Score is heuristic; aesthetic quality requires human review");
  return {category, score, confidence, status, access, reasons};
}
