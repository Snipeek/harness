'use strict';

const common = `Use the existing CommonJS entry point and preserve all previous behavior. You may edit main.js, queue.js, leases.js, or journal.js. Do not add dependencies, timers, or files. Run node test.js.`;
const scenario = (body, expected) => ['(()=>{'+body+'})()', expected];

const tasks = [{
  id: 'durable-job-scheduler',
  kind: 'module',
  automaticAcceptance: true,
  allowedFiles: ['main.js', 'queue.js', 'leases.js', 'journal.js'],
  files: {
    'main.js': `const {makeQueue}=require('./queue');\nfunction createScheduler(){\n  const queue=makeQueue();\n  return {enqueue:queue.enqueue, claim:queue.claim, list:queue.list};\n}\nmodule.exports={createScheduler};\n`,
    'queue.js': `function makeQueue(){\n  const jobs=new Map();\n  function enqueue({id}){if(jobs.has(id))return false;jobs.set(id,{id,state:'queued'});return true;}\n  function claim(){const job=[...jobs.values()].find(j=>j.state==='queued');if(!job)return null;job.state='running';return {id:job.id};}\n  function list(){return [...jobs.values()].map(job=>({...job}));}\n  return {enqueue,claim,list};\n}\nmodule.exports={makeQueue};\n`,
    'leases.js': `// Claim tokens and time-bound transitions belong here if needed.\n`,
    'journal.js': `// Serialization and restore helpers belong here if needed.\n`,
    'test.js': '// Protected visible check entry point supplied by the benchmark.\n'
  },
  stages: [
    {
      prompt: `Stage 1. Add priority and dependency-aware dispatch to this scheduler. enqueue({id,priority=0,deps=[]}) rejects duplicate IDs, self-dependencies and cycles (including cycles closed by a previously unknown ID) by returning false with zero state change. Unknown dependencies are accepted and keep the dependent blocked. Dependencies must all be successfully completed before a job can be claimed. claim() returns {id} or null, selects highest numeric priority then earliest insertion, and marks the result running. complete(id) returns true only on a running job, marks it done, and returns false otherwise. list() still returns {id,state} rows in insertion order without exposing mutable state. `+common,
      checks: [
        scenario(`const s=api.createScheduler();s.enqueue({id:'child',priority:99,deps:['base']});s.enqueue({id:'base'});return [s.claim()?.id,s.claim(),s.complete('base'),s.claim()?.id];`, ['base', null, true, 'child']),
        scenario(`const s=api.createScheduler();const result=[s.enqueue({id:'A',deps:['B']}),s.enqueue({id:'B',deps:['C']}),s.enqueue({id:'C',deps:['A']}),s.enqueue({id:'C',deps:['C']}),s.enqueue({id:'C'})];return [result,s.claim()?.id,s.list().map(x=>x.id)];`, [[true,true,false,false,true],'C',['A','B','C']]),
        scenario(`const s=api.createScheduler();s.enqueue({id:'low',priority:-1});s.enqueue({id:'first',priority:5});s.enqueue({id:'second',priority:5});return [s.claim()?.id,s.claim()?.id,s.complete('low'),s.claim()?.id,s.complete('low'),s.complete('low')];`, ['first','second',false,'low',true,false]),
        scenario(`const s=api.createScheduler();const deps=['base'];s.enqueue({id:'waiting',deps});deps.length=0;const rows=s.list();rows[0].state='done';return [s.claim(),s.list()];`, [null,[{id:'waiting',state:'queued'}]])
      ]
    },
    {
      prompt: `Stage 2. Add optional leases while preserving lease-free claim()/complete(id). createScheduler({leaseMs=0,maxAttempts=3,backoffMs=0}={}). With leaseMs>0, claim(now=0) first expires due leases and returns {id,token,deadline} or null, where deadline=now+leaseMs and tokens are unique per attempt. Each successful claim consumes one attempt. complete(id,token,now=0) accepts only the active token strictly before deadline; wrong/stale tokens cannot affect a newer attempt. A rejected completion or failure leaves state unchanged, including at the deadline. Add fail(id,token,now=0) with the same validation, and tick(now=0) to expire leases at now>=deadline and return expired IDs in insertion order. Failure or expiry schedules retry at the supplied observation time plus backoffMs * 2**(attempt-1); at maxAttempts it marks the job failed. Pending retries are listed as queued and keep their FIFO position. A dependency on a terminal failure stays blocked. leaseMs=0 keeps the existing {id} claim shape; fail(id) works on a running job without a token. `+common,
      checks: [
        scenario(`const s=api.createScheduler({leaseMs:5,backoffMs:2,maxAttempts:2});s.enqueue({id:'A'});const a=s.claim(10);const expired=s.tick(15);const blocked=s.claim(16);const b=s.claim(17);return [a.id,a.deadline,expired,blocked,b.deadline,a.token!==b.token,s.complete('A',a.token,18),s.fail('A',b.token,18),s.claim(99),s.list()];`, ['A',15,['A'],null,22,true,false,true,null,[{id:'A',state:'failed'}]]),
        scenario(`const s=api.createScheduler({leaseMs:3,backoffMs:2,maxAttempts:4});s.enqueue({id:'A'});let j=s.claim(0);s.fail('A',j.token,1);const at2=s.claim(2);j=s.claim(3);s.fail('A',j.token,4);return [at2,s.claim(7),s.claim(8)?.id];`, [null,null,'A']),
        scenario(`const s=api.createScheduler({leaseMs:3});s.enqueue({id:'B'});s.enqueue({id:'A',priority:2});const a=s.claim(0);const b=s.claim(0);return [a.id,b.id,s.complete('A',a.token,3),s.tick(3),s.claim(3)?.id];`, ['A','B',false,['B','A'],'A']),
        scenario(`const s=api.createScheduler({leaseMs:1,maxAttempts:1});s.enqueue({id:'A'});s.enqueue({id:'B',deps:['A']});s.claim(0);return [s.claim(1),s.list()];`, [null,[{id:'A',state:'failed'},{id:'B',state:'queued'}]])
      ]
    },
    {
      prompt: `Stage 3. Add durable checkpointing. instance.snapshot() returns a fresh, JSON-round-trippable object with version:1, preserving settings, insertion order, dependencies, states, attempt counts, retry times, running deadlines and any sequence needed for stale-token rejection. Export restoreScheduler(snapshot,now=0). It must be detached from the caller's snapshot, reject unsupported versions by throwing, and produce an independent scheduler. At restore, invalidate each in-flight claim. Treat it as a failed attempt at the earlier of its recorded deadline (if any) and now, using the same attempt limit/backoff. Existing queued retries keep their eligibility times. After restoring, a newly issued token must never equal a pre-checkpoint token in that history. Preserve lease-free operation and other completed jobs. `+common,
      checks: [
        scenario(`const s=api.createScheduler({leaseMs:5,backoffMs:2,maxAttempts:3});s.enqueue({id:'running'});const previous=s.claim(0);s.enqueue({id:'blocked',deps:['running']});const snap=JSON.parse(JSON.stringify(s.snapshot()));const r=api.restoreScheduler(snap,10);const newClaim=r.claim(10);return [snap.version,newClaim.id,newClaim.deadline,newClaim.token!==previous.token,r.complete('running',previous.token,11),r.complete('running',newClaim.token,11),r.claim(11)?.id,s.list()[0].state];`, [1,'running',15,true,false,true,'blocked','running']),
        scenario(`const s=api.createScheduler({leaseMs:10,backoffMs:3,maxAttempts:2});s.enqueue({id:'late'});const pre=s.claim(0);s.fail('late',pre.token,1);const r=api.restoreScheduler(JSON.parse(JSON.stringify(s.snapshot())),2);const first=r.claim(3);const second=r.claim(4);r.fail('late',second.token,5);return [first,r.claim(99),r.list()];`, [null,null,[{id:'late',state:'failed'}]]),
        scenario(`const s=api.createScheduler({leaseMs:5,backoffMs:4});s.enqueue({id:'A'});s.claim(10);const r=api.restoreScheduler(s.snapshot(),12);return [r.claim(15),r.claim(16)?.id,s.list()[0].state];`, [null,'A','running']),
        scenario(`try{api.restoreScheduler({version:999},0);return false;}catch{return true;}`, true),
        scenario(`const s=api.createScheduler();s.enqueue({id:'done'});s.claim();s.complete('done');s.enqueue({id:'B',deps:['done']});const r=api.restoreScheduler(JSON.parse(JSON.stringify(s.snapshot())));return [r.claim(),r.complete('B'),r.list()];`, [{id:'B'},true,[{id:'done',state:'done'},{id:'B',state:'done'}]])
      ]
    },
    {
      prompt: `Stage 4. Add cancel(id) for a queued or running job. It returns true only for the first cancellation, invalidates any active claim, and sets state cancelled. Any queued or running direct or indirect dependent of a cancelled or terminally failed dependency must become blocked with state blocked, including future jobs whose deps reach that terminal dependency. This supersedes the previous convention of showing such jobs as queued; for backwards compatibility, a dependency failure leaves existing dependents queued until reconcile() runs. When enqueuing after the failure, classify the new job using the same transitive rule without changing existing jobs. cancel(id) calls reconcile() automatically. Add reconcile() returning all newly blocked IDs in insertion order. Blocked jobs never run. Preserve cancelled and blocked states across snapshots. Add setPriority(id,priority), returning true only for queued jobs and preserving insertion order for ties. Keep all other earlier behavior and deadline rules. `+common,
      checks: [
        scenario(`const s=api.createScheduler({leaseMs:4});s.enqueue({id:'C',deps:['B']});s.enqueue({id:'B',deps:['A']});s.enqueue({id:'A'});const a=s.claim(0);const cancelled=s.cancel('A');const duplicate=s.cancel('A');s.enqueue({id:'D',deps:['C']});const r=api.restoreScheduler(JSON.parse(JSON.stringify(s.snapshot())),99);return [cancelled,duplicate,s.complete('A',a.token,1),r.claim(100),r.list()];`, [true,false,false,null,[{id:'C',state:'blocked'},{id:'B',state:'blocked'},{id:'A',state:'cancelled'},{id:'D',state:'blocked'}]]),
        scenario(`const s=api.createScheduler({leaseMs:1,maxAttempts:1});s.enqueue({id:'child',deps:['parent']});s.enqueue({id:'grandchild',deps:['child']});s.enqueue({id:'parent'});s.claim(0);s.tick(1);const changed=s.reconcile();return [changed,s.reconcile(),s.list()];`, [['child','grandchild'],[],[{id:'child',state:'blocked'},{id:'grandchild',state:'blocked'},{id:'parent',state:'failed'}]]),
        scenario(`const s=api.createScheduler();for(const id of ['A','B','C'])s.enqueue({id});s.setPriority('B',4);s.setPriority('C',4);const first=s.claim()?.id;return [first,s.setPriority('B',1),s.setPriority('A',4),s.claim()?.id,s.claim()?.id];`, ['B',false,true,'A','C'])
      ]
    }
  ]
}];

module.exports = { tasks };
