// External extension example: loaded only through --extension /trusted/path/tickets.cjs.
// No imports from the engine's internals are required.
module.exports={
  apiVersion:1,
  adapters:[{
    id:"sample-tickets",
    async collect({source,cursor,limit}){
      const records=source.config.records;
      if(!Array.isArray(records))throw new Error("records must be configured");
      const offset=cursor?Number(cursor):0;
      const entries=records.slice(offset,offset+limit);
      const next=offset+entries.length;
      return {observations:entries.map(t=>({
        id:String(t.id),type:"ticket",title:String(t.title),
        text:String(t.description||""),attributes:{priority:Number(t.priority)}
      })),nextCursor:String(next),hasMore:next<records.length};
    }
  }],
  processors:[{
    id:"ticket-entity",
    run(_context,observation,previous){
      return [...previous,{key:"ticket:"+observation.id,type:"ticket",
        title:observation.title,attributes:observation.attributes,
        evidence:[{signal:"ticket-adapter",detail:"Imported from the configured ticket list"}]}];
    }
  }],
  evaluators:[{
    id:"ticket-priority",
    assess(_context,_observation,entity){
      const priority=Number(entity.attributes.priority);
      return {category:"ticket",score:Math.min(100,priority*20),
        confidence:0.9,reasons:["Explicit ticket priority: "+priority]};
    }
  }]
};
