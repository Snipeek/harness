'use strict';
const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {InMemoryTaskStore} = require('@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js');

const server = new McpServer({name:'fixture',version:'1.0.0'},{
  capabilities:{tasks:{requests:{tools:{call:{}}}}}, taskStore:new InMemoryTaskStore()
});
server.experimental.tasks.registerToolTask('example_task',{
  description:'Run the sample MCP task', execution:{taskSupport:'required'}
},{
  async createTask({taskStore,taskRequestedTtl}){
    const task=await taskStore.createTask({ttl:taskRequestedTtl,pollInterval:10});
    await taskStore.storeTaskResult(task.taskId,'completed',{content:[{type:'text',text:'Observed result'}]});
    return {task};
  },
  async getTask(_args,{taskId,taskStore}){return taskStore.getTask(taskId);},
  async getTaskResult(_args,{taskId,taskStore}){return taskStore.getTaskResult(taskId);}
});
server.connect(new StdioServerTransport());
