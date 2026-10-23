import {readFileSync} from "node:fs";
import type {Profile} from "./types.ts";

export function loadProfile(path: string): Profile {
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!config || typeof config !== "object") throw new Error("Invalid profile");
  const v = config as Record<string, unknown>;
  if (typeof v.name !== "string" || !Array.isArray(v.categories) || !Array.isArray(v.excludeDomains) ||
      typeof v.scoreThreshold !== "number" || v.scoreThreshold < 0 || v.scoreThreshold > 100 ||
      typeof v.confidenceThreshold !== "number" || v.confidenceThreshold < 0 || v.confidenceThreshold > 1 ||
      typeof v.preferFree !== "boolean") throw new Error("Invalid profile fields");
  for (const category of v.categories) {
    if (typeof category?.name !== "string" || !Array.isArray(category.keywords) ||
        category.keywords.some((word: unknown) => typeof word !== "string")) {
      throw new Error("Invalid profile category");
    }
  }
  return v as unknown as Profile;
}
