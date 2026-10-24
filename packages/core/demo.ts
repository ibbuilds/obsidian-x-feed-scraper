/** Offline synthetic observations shipped at first use, never fetched from X. */
export function demoObservations():Array<{
  id:string;type:string;title:string;text:string;url?:string;urls?:string[];
  attributes:Record<string,string>
}>{
  return [
    {id:"demo-motion-1",type:"community-post",
      title:"Reusable motion components for interfaces",
      text:"Public sample about interface components and animation",
      url:"https://example.org/posts/motion-1",
      urls:["https://github.com/example/motion-kit"],
      attributes:{author:"synthetic-demo"}},
    {id:"demo-motion-2",type:"community-post",
      title:"A second useful mention of the same motion library",
      text:"Independent observation about UI and motion",
      url:"https://example.org/posts/motion-2",
      urls:["https://github.com/example/motion-kit"],
      attributes:{author:"synthetic-demo"}},
    {id:"demo-research-3",type:"research-note",
      title:"Scientific observation without a web link",
      text:"A sample note demonstrating source-independent research",
      attributes:{domain:"research-demo"}}
  ];
}
