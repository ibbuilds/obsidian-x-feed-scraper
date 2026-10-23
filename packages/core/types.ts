export type Access = "free" | "open_source" | "freemium" | "paid" | "unknown";
export type Status =
  | "discovered" | "pending_analysis" | "evaluated" | "high_quality"
  | "needs_review" | "approved" | "rejected" | "unavailable";
export interface Post {
  id: string;
  url: string;
  author: string;
  username: string;
  text: string;
  publishedAt?: string;
  urls?: string[];
  quotedUrls?: string[];
  images?: string[];
  quotedText?: string;
}
export interface Category { name: string; keywords: string[] }
export interface Profile {
  name: string;
  categories: Category[];
  excludeDomains: string[];
  scoreThreshold: number;
  confidenceThreshold: number;
  preferFree: boolean;
  referenceUrls?: string[];
}
export interface Metadata {
  title?: string;
  description?: string;
  contentType?: string;
  license?: string;
  access?: Access;
}
export interface Evaluation {
  category: string;
  score: number;
  confidence: number;
  access: Access;
  status: Status;
  reasons: string[];
}
export interface Source {
  id: number;
  url: string;
  title: string;
  category: string;
  access: Access;
  score: number;
  confidence: number;
  status: Status;
  reasons: string[];
  firstSeen: string;
  postUrl?: string;
  author?: string;
}
