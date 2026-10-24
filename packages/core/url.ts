import {isIP} from "node:net";
import type {Post} from "./types.ts";

const DROP = new Set(["fbclid", "gclid", "dclid", "igshid", "mc_cid", "mc_eid", "ref_src", "ref_url", "si"]);
const X_DOMAINS = ["x.com","twitter.com"] as const;
const SECRET_QUERY_KEY = /(?:^|[_-])(?:token|accesskey|apikey|api[_-]?key|key|secret|password|passwd|pwd|session|sessionid|auth|authorization|jwt|signature|sig|cookie)(?:$|[_-])/i;

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported URL scheme");
  if (url.username || url.password) throw new Error("URL credentials prohibited");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  for (const key of [...url.searchParams.keys()]) {
    if (DROP.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  for(const key of url.searchParams.keys()){
    if(SECRET_QUERY_KEY.test(key))throw new Error("URL contains a credential-like query parameter");
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function isXUrl(raw: string): boolean {
  try {
    const host=new URL(raw).hostname.toLowerCase().replace(/\.$/,"");
    return X_DOMAINS.some(domain=>host===domain||host.endsWith("."+domain));
  }catch{return false;}
}

export function extractUrls(post: Post): string[] {
  const input = [post.text, post.quotedText || ""].join(" ");
  const candidates = [
    ...input.matchAll(/https?:\/\/[^\s<>"']+/gi)
  ].map(m => m[0].replace(/[),.;!?\]}]+$/, ""));
  candidates.push(...(post.urls || []), ...(post.quotedUrls || []));
  const urls = new Set<string>();
  for (const item of candidates) {
    try {
      const url = normalizeUrl(item);
      if (!isXUrl(url)) urls.add(url);
    } catch { /* Malformed, unsupported or non-web link. */ }
  }
  return [...urls];
}

export function isLocalOrUnsafeAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && (b === 2 || b === 88)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Only globally routable IPv6 addresses; exclude IPv4-mapped and documentation blocks.
    return !/^[23][0-9a-f]/.test(lower) || lower.startsWith("2001:db8") ||
      lower.startsWith("2001:0:") || lower.startsWith("2002:");
  }
  return true;
}

export function safeHostname(urlString: string): string {
  const url = new URL(normalizeUrl(urlString));
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || isIP(host) && isLocalOrUnsafeAddress(host)) {
    throw new Error("Local or unsafe network destination");
  }
  return host;
}
