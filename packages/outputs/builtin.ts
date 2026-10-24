import type {Extension,OutputAdapter} from "../sdk/contracts.ts";

/** JSON is the primary built-in output; no GUI or Obsidian dependency. */
const json:OutputAdapter={
  id:"json",offline:true,
  export({records}){return {entities:records.length,records};}
};
export const builtinOutputs:Extension={apiVersion:1,outputs:[json]};
