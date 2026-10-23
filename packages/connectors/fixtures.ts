import {readFileSync} from "node:fs";
import type {Post} from "../core/types.ts";

export function readFixture(file: string): Post[] {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Fixture must be an array with <=10000 posts");
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Invalid post");
    const record = item as Record<string, unknown>;
    for (const key of ["id", "url", "author", "username", "text"]) {
      if (typeof record[key] !== "string" || (record[key] as string).length > 200000) throw new Error("Post is missing valid " + key);
    }
    for (const key of ["urls", "quotedUrls", "images"]) {
      if (record[key] !== undefined && (!Array.isArray(record[key]) ||
        (record[key] as unknown[]).some((u: unknown) => typeof u !== "string"))) throw new Error("Invalid " + key);
    }
  }
  return value as Post[];
}
