'use strict';

// A workflow check for common build/deploy commands, not a shell sandbox.
const expensive = /(?:^|[\s;&|"'(])(?:docker(?:\s+buildx)?\s+build|docker(?:\s+compose|-compose)\s+(?:[^\n;&|]*?\s)?(?:build|pull|up)|(?:docker\s+stack|flyctl|fly)\s+deploy|kubectl\s+apply|helm\s+(?:install|upgrade)|terraform\s+apply|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|go\s+build)(?=$|[\s;"'&|])/i;
const evidenceTools = new Set(['run_command','read_file','read_files','search_files','search_batch','list_files','web_fetch','web_search','integration_status','find_extensions']);
const preflight = {
  type:'object', additionalProperties:false, required:['outcome','alternative','checks'],
  properties:{
    outcome:{type:'string',minLength:1,maxLength:240,description:'Observable result for the user and how it will be verified'},
    alternative:{type:'string',minLength:1,maxLength:240,description:'Ready artifact or cheaper route considered, and why this command is still needed'},
    checks:{type:'array',minItems:1,maxItems:4,items:{type:'string'},description:'Tool-call IDs of completed checks from the current turn'}
  }
};

const isLongCommand = args => expensive.test(args.command) || args.timeout_seconds>=120;

function checkPreflight(name,args,session,root,entry) {
  if (!['start_process','run_command'].includes(name) ||
      !((name==='start_process' && (args.timeout_seconds??600)>=120) || isLongCommand(args))) return;
  const reject = message => { throw Error('Preflight: '+message+' This command did not start.'); };
  const p=args.preflight;
  if (!p?.outcome?.trim()||!p?.alternative?.trim()||!p.checks?.length)
    reject('First verify the highest-risk assumption with a cheap read-only check. Prefer a ready artifact if it meets the outcome. Then pass preflight: {outcome, alternative, checks:[tool result IDs]}. Use the tool-call IDs from the conversation.');
  const valid= id => session.timeline.some(e=>e!==entry && e.preflightScope?.callId===id && e.preflightScope?.taskId===session.taskId &&
    e.preflightScope.root===root && e.preflightScope.turnId===session.turnId && e.status==='done' && !e.approvalDenied);
  if (!p.checks.every(valid)) reject('Use completed, successful evidence from this turn and workspace; failed checks or results from other tasks do not count.');
}

module.exports={preflight,checkPreflight,evidenceTools,isLongCommand};
