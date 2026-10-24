import {createDefaultRegistry} from "../core/extensions.ts";
import {registerExtension} from "../core/registry.ts";
import {obsidianOutput} from "./obsidian-output.ts";
import type {Registry} from "../sdk/contracts.ts";

/** Optional Obsidian client registry: the core registry never imports this module. */
export function createObsidianRegistry(extensionPaths:readonly string[]=[]):Registry{
  const registry=createDefaultRegistry(extensionPaths);
  registerExtension(registry,{apiVersion:1,outputs:[obsidianOutput]});
  return registry;
}
