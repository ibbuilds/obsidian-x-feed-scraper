import {normalizeUrl} from "../../packages/core/url.ts";
export interface LibrarySource {url:string;title:string;category:string;status:string}
export function libraryContains(markdown:string,target:string):boolean {
  const expected=normalizeUrl(target);
  for(const match of markdown.matchAll(/https?:\/\/[^\s<>"')]+/gi)){
    try{if(normalizeUrl(match[0].replace(/[.,;]+$/,""))===expected)return true;}
    catch{}
  }
  return false;
}
export function appendApprovedReference(markdown:string,source:LibrarySource):string{
  if(source.status!=="approved")throw new Error("Only approved references can be added");
  if(libraryContains(markdown,source.url))throw new Error("Already in References.md");
  const name=(source.title||source.url).replace(/[\r\n\[\]<>]/g," ").trim().slice(0,180);
  const category=source.category.replace(/[^\w-]/g," ").slice(0,60);
  const line="- ["+name+"](<"+normalizeUrl(source.url)+">) — "+category+" (reviewed by user)\n";
  const marker="## Approved via X Feed Scraper";
  const pos=markdown.indexOf(marker);
  if(pos<0)return markdown.trimEnd()+"\n\n"+marker+"\n"+line;
  const after=pos+marker.length;
  const tail=markdown.slice(after);
  const next=tail.search(/\n#{1,2} /);
  if(next<0)return markdown.trimEnd()+"\n"+line;
  const insertAt=after+next;
  return markdown.slice(0,insertAt).trimEnd()+"\n"+line+"\n"+markdown.slice(insertAt).trimStart();
}
