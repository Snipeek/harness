'use strict';
const {preflight}=require('./preflight');
const def=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',additionalProperties:false,properties,required}}});
const s={type:'string'},n={type:'integer'};
const sourceReference={type:'object',additionalProperties:false,required:['path','line'],properties:{
 path:s,line:{type:'integer',minimum:1},excerpt:s}};
const revisionVerification = {type:'object',additionalProperties:false,required:['checks'],properties:{
 checks:{type:'array',minItems:1,maxItems:6,items:{type:'object',additionalProperties:false,required:['command'],properties:{
  name:{type:'string',minLength:1,maxLength:120},command:{type:'string',minLength:1,maxLength:1000},
  timeout_seconds:{type:'integer',minimum:1,maximum:120},criteria:{type:'array',items:s,maxItems:20},inputs:{type:'array',items:s,maxItems:20}
 }}},refresh:{type:'boolean'},done_steps:{type:'array',items:s,maxItems:20}
 }};
const serviceTools=[
 def('ask_user','Pause and show the user a question with mutually exclusive options and an optional written answer. Use after checking available evidence when the unresolved choice belongs to the user and materially changes the result. Describe options in terms of user-visible outcomes and trade-offs. Ask the decision that unlocks later choices first. Include why and the exact dependent plan step when known. Returns a decision ID. Omit decision_id for an automatic ID or provide a new task-local ID. Reuse an existing ID only with the same question and options. A skipped question supplies no answer.',{
  question:{type:'string',minLength:1,maxLength:500},
  why:{type:'string',minLength:1,maxLength:350},
  step:{type:'string',minLength:1,maxLength:180},
  decision_id:{type:'string',minLength:1,maxLength:120},
  option_details:{type:'array',minItems:2,maxItems:4,items:{type:'string',minLength:1,maxLength:240}},
  recommendation:{type:'object',additionalProperties:false,required:['choice','reason'],properties:{
   choice:{type:'integer',minimum:0,maximum:3},reason:{type:'string',minLength:1,maxLength:240}
  }},
  options:{type:'array',minItems:2,maxItems:4,uniqueItems:true,items:{type:'string',minLength:1,maxLength:180}}
 },['question','options']),
 def('expand_tools','Expand from the quick selection-analysis tools to the full workspace tool set.'),
 def('trace_symbol','Find a named symbol within a file scope, then retrieve bounded language-provider definitions and references with source excerpts in one read-only call. Without a language provider, reports textual matches only.',{
  symbol:{type:'string',pattern:'^[A-Za-z_$][A-Za-z0-9_$]{0,119}$'},glob:{type:'string',maxLength:500}
 },['symbol']),
 def('module_references','Find incoming relative JS/TS imports for up to eight known module paths in one bounded scan. Reports source lines and coverage. Zero matches alone does not prove a module can be deleted.',{paths:{type:'array',minItems:1,maxItems:8,items:s}},['paths']),
 def('repository_docs','Find workspace README paths, relevant heading line numbers and local documentation links. Use read_files for the section you need. Titles are navigation hints.',{
  query:{type:'string',maxLength:1200},directory:s,limit:{type:'integer',minimum:1,maximum:12}
 }),
 def('trace_calls','Fetch source evidence for caller → callee claims. Give path and line for each callsite, definition and relevant condition. The tool reads the source text itself; omit excerpt. Inspect returned lines and statuses; location alone does not prove the edge.',{
 edges:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,
 required:['caller','callee','call','definition'],properties:{caller:s,callee:s,call:sourceReference,definition:sourceReference,condition:sourceReference}}}
 },['edges']),
 def('review_source_change','Check one proposed replacement against current source without editing. Copy complete current lines including their enclosing guard, then show the minimal changed lines. If the result reports a mismatch or existing change, discard or correct the proposal.',{
  path:s,line:{type:'integer',minimum:1},before:{type:'string',minLength:1,maxLength:2400},after:{type:'string',maxLength:2400}
 },['path','line','before','after']),
 def('inspect_changes','Compare file changes from tools and commands and inspect current disk hashes for this task.'),
 def('project_rules','Read nested project instructions that apply to a file path.',{path:s},['path']),
 def('task_state','Read the current original user goal, genuine clarifications, plan focus, pending tasks and command receipts. Pass update_id and offset to retrieve a full user update after compaction; history_offset lists 20 genuine updates across prior tasks.',{update_id:s,offset:n,history_offset:n}),
 def('architecture_map','Read/save a source-backed working map of a module. Read validates recorded source hashes and flags stale maps. Save after reading sources; describe owners, boundaries, contracts, flow and unknowns. Hashes do not prove semantic correctness.',{action:{type:'string',enum:['read','save']},scope:s,summary:s,sources:{type:'array',minItems:1,maxItems:24,items:s}},['scope']),
 def('web_search','Search the public internet using Z.ai Web Search. Returns real source URLs and excerpts. Use for current facts/research; do not scrape a search engine with shell commands.',{query:s,domain:s,recency:{type:'string',enum:['oneDay','oneWeek','oneMonth','oneYear','noLimit']}},['query']),
 def('web_fetch','Read a public HTTPS source. Follow nextOffset to cover its extracted text. Coverage measures delivered ranges, not the entire website.',{url:s,offset:n,limit:n},['url']),
 def('start_process','Start an approved command in background (same permissions as run_command). Do independent work, then call wait_process once with its ID. The host waits for completion without model calls.',{command:s,description:s,timeout_seconds:n,preflight},['command']),
 def('read_process','Read process result, waiting for exit by default. Set preview:true only to inspect a specific live diagnostic; do not poll.',{id:s,limit:n,preview:{type:'boolean'}},['id']),
 def('wait_process','Wait for the process to finish or hit its own timeout. Omit timeout_ms for one wait; use it only when another action must happen by a specific deadline.',{id:s,timeout_ms:n,limit:n},['id']),
 def('stop_process','Stop a process started in this conversation.',{id:s},['id']),
 def('read_artifact','Read archived tool output by artifact ID. Byte offsets; bounded output.',{id:s,offset:n,limit:n},['id']),
 def('diagnostics','Get current VS Code errors and warnings for workspace files.',{path:s}),
 def('navigate_symbols','Resolve definitions and references for several source positions in one request, with bounded line excerpts. Requires a VS Code language provider.',{
 positions:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,
 required:['path','line','column'],properties:{path:s,line:n,column:n}}}},['positions']),
 def('code_navigation','Get document symbols, definition or references at a 1-based line/column.',{path:s,action:{type:'string',enum:['symbols','definition','references']},line:n,column:n},['path','action']),
 def('update_plan','Persist task goal, focus, next action, contracts and verification requirements. Pending work survives interruptions; done status is a claim, not proof. Include goal on the first update of a task. Later updates may retain it by omitting goal. Name each step with title. A completed step may use its evidence as the title. Returns criterionRefs with stable IDs for verification calls. Link confirmed choices to acceptance criteria with decision_criteria.',{goal:s,focus:s,next_action:s,blockers:{type:'array',items:s},hypotheses:{type:'array',items:s},deferred:{type:'array',items:s},invariant:s,owner:s,data_flow:s,decision:s,rationale:s,preserved_contract:s,unknowns:{type:'array',items:s},next_change:s,acceptance:{type:'array',items:s},decision_criteria:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['decision_id','criterion'],properties:{decision_id:s,criterion:s}}},constraints:{type:'array',items:s},steps:{type:'array',items:{type:'object',properties:{title:s,status:{type:'string',enum:['pending','running','done']},evidence:s},required:['status'],additionalProperties:false}},verification:{type:'array',items:s}},['steps']),
 def('read_skill_resource','Read a skill relative resource (instructions, scripts, references) without escaping that skill directory.',{skill:s,path:s,offset:n,limit:n},['skill','path']),
 def('integration_status','Check the running Harness version. Show available MCP servers, connection/approval status and skills. Does not execute tools.'),
 def('find_extensions','Find installed VS Code extensions by display name or extension ID. Returns version, location and active state from VS Code. Use first when asked to find an installed extension.',{query:{type:'string',minLength:1,maxLength:120}},['query']),
 def('set_reasoning_effort','Adjust GLM reasoning for this task. Start research at low. Raise to high for competing source-backed explanations, unclear state ownership, or a failed counterexample. Use max only if high leaves a material issue unresolved.',{effort:{type:'string',enum:['low','high','max']},reason:s},['effort','reason']),
 def('verify_task','For bug fixes, before editing run the expected behavior with reproduction: specify a nonzero exit_code and a distinctive output_contains marker emitted only for the target failure. Pin test files and fixtures in inputs, or set reproduction.inline for self-contained assertions in the command. After editing, call with only baseline_id to replay the recorded command and inputs. For other checks, provide command and description. Set refresh for a deliberate rerun. Criteria use active plan IDs.',{command:s,description:s,timeout_seconds:n,refresh:{type:'boolean'},criteria:{type:'array',items:s,maxItems:20}, inputs:{type:'array',items:s,maxItems:20},
 baseline_id:s,reproduction:{type:'object',additionalProperties:false,required:['exit_code','output_contains'],properties:{inline:{type:'boolean'},exit_code:{type:'integer',minimum:1,maximum:255},output_contains:{type:'string',minLength:1,maxLength:500}}},
 scenarios:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['criterion','input','expected'],properties:{criterion:s,input:s,expected:s}}}}),
 def('verify_revision','Run up to six checks in one call and return compact receipts and first failure details. Use name only when a label clearer than the command is needed. Include the smallest behavior test and any syntax checks needed. Commands retain their normal approval. Passing results can be reused while workspace files are identical. Reference active criterion IDs only. Unknown references stay unlinked while the check still runs. With evidence, mark exact plan steps complete in the same call.',revisionVerification.properties,revisionVerification.required),
 def('link_check','Attach an existing passing behavioral receipt to exact plan criteria without rerunning the command. Omit arguments to list current receipts. Explain the observed coverage before linking.',{id:s,criteria:{type:'array',items:s,minItems:1,maxItems:20},coverage:s}),
 def('search_tools','Discover optional built-in tools (background processes, subagents, code navigation, diagnostics, skills, resources) or MCP tools by name/description. Selected schemas load on the next model request.',{query:s},['query']),
 def('list_resources','List resources from a configured MCP server; returns opaque nextCursor for pagination.',{server:s,cursor:s},['server']),
 def('read_resource','Read a resource URI from a configured MCP server.',{server:s,uri:s},['server','uri']),
 def('list_skills','List available project, Claude user and enabled-plugin skills with names, descriptions and load IDs. Contents load on demand.'),
 def('load_skill','Load an available skill by ID/path returned by list_skills. Returns its base directory, tool mappings and limitations; obey pagination.',{path:s},['path'])
];
module.exports={def,serviceTools,revisionVerification};
