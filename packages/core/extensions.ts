import {createRequire} from "node:module";
import {resolve} from "node:path";
import {builtinSources} from "../adapters/builtin.ts";
import {builtinProcessing} from "../processors/builtin.ts";
import {builtinOutputs} from "../outputs/builtin.ts";
import {webhookOutput} from "../outputs/webhook.ts";
import {registry,registerExtension} from "./registry.ts";
import type {Registry,Extension} from "../sdk/contracts.ts";
/**
 * Explicitly opt-in local CJS modules only. Extensions execute user-approved
 * JavaScript with the current user's OS privileges: never auto-install/enable.
 */
export function createDefaultRegistry(extensionPaths:readonly string[]=[]):Registry{
  const result=registry();
  registerExtension(result,builtinSources);
  registerExtension(result,builtinProcessing);
  registerExtension(result,builtinOutputs);
  registerExtension(result,{apiVersion:1,outputs:[webhookOutput]});
  if(extensionPaths.length>16)throw new Error("Too many external extensions");
  const require=createRequire(resolve("discovery-extension-loader.cjs"));
  for(const file of extensionPaths){
    if(!file||!file.endsWith(".cjs"))throw new Error("External extensions must be explicit local .cjs files");
    const abs=resolve(file);
    const mod:unknown=require(abs);
    if(!mod||typeof mod!=="object")throw new Error("Invalid extension module");
    const ext=(mod as {default?:unknown}).default??mod;
    registerExtension(result,ext as Extension);
  }
  return result;
}
