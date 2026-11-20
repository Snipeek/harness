'use strict';
const {Server}=require('@modelcontextprotocol/sdk/server/index.js'),{StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js'),{ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
let failed=false;
const server=new Server({name:'evaluator',version:'1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['inventory','fragile_inventory'].map(name=>({name,description:name==='inventory'?'Read widget inventory quantity':'Read fragile widget inventory; transient errors are retryable once',inputSchema:{type:'object',properties:{color:{type:'string',enum:['blue','red']}},required:['color'],additionalProperties:false}}))}));
server.setRequestHandler(CallToolRequestSchema,async r=>{if(r.params.name==='fragile_inventory'&&!failed){failed=true;return {isError:true,content:[{type:'text',text:'Transient inventory error; retry once.'}]};}return {content:[{type:'text',text:JSON.stringify({color:r.params.arguments.color,quantity:r.params.arguments.color==='blue'?17:23,source:'evaluator inventory'})}]};});
server.connect(new StdioServerTransport());
