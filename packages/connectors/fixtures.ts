import {readFileSync} from "node:fs";
import type {Post} from "../core/types.ts";

export function readFixture(file: string): Post[] {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Fixture must be an array with <=10000 posts");
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Invalid post");
    for (const key of ["id", "url", "author", "username", "text"]) {
      if (typeof item[key] !== "string" || item[key].length > 200000) throw new Error("Post is missing valid " + key);
    }
    for (const key of ["urls", "quotedUrls", "images"]) {
      if (item[key] !== undefined && (!Array.isArray(item[key]) ||
        item[key].some((u: unknown) => typeof u !== "string"))) throw new Error("Invalid " + key);
    }
  }
  return value as Post[];
}
