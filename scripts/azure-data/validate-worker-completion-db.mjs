// Disposable-loopback PostgreSQL regression suite for migration 009.
import assert from 'node:assert/strict';
import pg from 'pg';
for (const k of ['CBC_DATABASE_URL','CBC_TEST_OWNER_URL','CBC_TEST_WORKER_URL']) {
  if (new URL(process.env[k]??'postgres://x@invalid/x').hostname !== '127.0.0.1')
    throw new Error('Refusing non-loopback database: '+k);
}
if (!process.env.CBC_TEST_ISSUER) throw new Error('Missing test issuer');
const app=new pg.Pool({connectionString:process.env.CBC_DATABASE_URL,max:4});
const worker=new pg.Pool({connectionString:process.env.CBC_TEST_WORKER_URL,max:8});
const owner=new pg.Client({connectionString:process.env.CBC_TEST_OWNER_URL});
const stmt='SELECT public.app_complete_scan_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS ok';
const vendor=[{vendor_name:'domain_age',verdict:'suspicious',raw_response:{days:3},response_time_ms:12}];
const evidence=[{signal_type:'domain_age',severity:'medium',title:'Recent domain',detail:'3 days',score_impact:20}];
const args=(id,token,o={})=>[id,token,o.status??'complete',o.verdict??'suspicious',
  o.risk??55,o.confidence??75,o.explanation??null,o.action??null,o.duration??1200,
  JSON.stringify(o.vendor??vendor),JSON.stringify(o.evidence??evidence)];
const complete=async(id,token,o={})=>(await worker.query(stmt,args(id,token,o))).rows[0].ok;
const code=async(fn)=>{try{await fn();return null;}catch(e){return e.code??'unexpected';}};
let passed=0,failed=0;
async function check(label,fn){try{await fn();passed++;console.log('PASS '+label);}
  catch(e){failed++;console.error('FAIL '+label+': '+String(e));}}
async function signIn(subject){
  const r=await app.query('SELECT * FROM public.app_sign_in($1,$2,$3,$4)',
    [process.env.CBC_TEST_ISSUER,subject,subject+'@example.test','Worker completion test']);
  return {user:r.rows[0].o_user_id,org:r.rows[0].o_organization_id};
}
async function create(who,raw){
  const c=await app.connect();
  try{
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.current_organization_id',$2,true)",[who.user,who.org]);
    const id=(await c.query('SELECT public.app_create_scan($1,$2) AS id',['url',raw])).rows[0].id;
    await c.query('COMMIT');return id;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const claim=async()=>(await worker.query('SELECT * FROM public.app_claim_scan_jobs(1,120)')).rows[0];
const state=async id=>(await owner.query(
  'SELECT s.status,s.verdict,j.state AS job,j.lease_token,'+
  '(SELECT count(*)::int FROM public.vendor_results v WHERE v.scan_id=s.id) AS vendors,'+
  '(SELECT count(*)::int FROM public.evidence_items e WHERE e.scan_id=s.id) AS evidence '+
  'FROM public.scans s JOIN public.scan_job_outbox j ON j.scan_id=s.id WHERE s.id=$1',[id])).rows[0];
try{
  await owner.connect();
  // Only the ephemeral cluster: previous suites intentionally leave pending jobs.
  await owner.query('DELETE FROM public.scan_job_outbox');
  const a=await signIn('completion-tenant-a'),b=await signIn('completion-tenant-b');
  await check('C01 worker-only function grants and retired web result writers',async()=>{
    const r=await owner.query(
      "SELECT has_function_privilege('cbc_worker',oid,'EXECUTE') AS worker,"+
      "has_function_privilege('cbc_app',oid,'EXECUTE') AS app,"+
      "has_function_privilege('public',oid,'EXECUTE') AS everyone FROM pg_proc "+
      "WHERE oid='public.app_complete_scan_job(uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb)'::regprocedure");
    assert.deepEqual(r.rows,[{worker:true,app:false,everyone:false}]);
    for(const f of ['app_record_fast_scan_result(uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb,text)',
      'app_mark_scan_processing(uuid)','app_ack_scan_job(uuid,uuid)']){
      const q=await owner.query("SELECT has_function_privilege('cbc_app',$1,'EXECUTE') AS app,"+
        "has_function_privilege('cbc_worker',$1,'EXECUTE') AS worker",['public.'+f]);
      assert.deepEqual(q.rows,[{app:false,worker:false}]);
    }
  });
  const first=await create(a,'https://first.example'),lease=await claim();
  await check('C02 first claim binds tenant A',async()=>{
    assert.equal(lease.o_scan_id,first);assert.equal(lease.o_organization_id,a.org);
  });
  await check('C03 wrong scan or token fails closed',async()=>{
    assert.equal(await complete(first,'11111111-1111-4111-8111-111111111111'),false);
    assert.equal(await complete('11111111-1111-4111-8111-111111111111',lease.o_lease_token),false);
    assert.equal((await state(first)).status,'pending');
  });
  await check('C04 invalid evidence and unknown provider fields cannot partially write',async()=>{
    assert.equal(await code(()=>complete(first,lease.o_lease_token,{evidence:[{signal_type:'x',severity:'invalid',title:'x'}]})),'22023');
    assert.equal(await code(()=>complete(first,lease.o_lease_token,{vendor:[{vendor_name:'x',unexpected:'x'}]})),'22023');
    const s=await state(first);assert.deepEqual([s.status,s.job,s.vendors,s.evidence],['pending','leased',0,0]);
  });
  await check('C05 completion atomically persists tenant-bound results and closes lease',async()=>{
    assert.equal(await complete(first,lease.o_lease_token),true);
    const s=await state(first);
    assert.deepEqual([s.status,s.verdict,s.job,s.lease_token,s.vendors,s.evidence],['complete','suspicious','done',null,1,1]);
    const e=await owner.query('SELECT organization_id FROM public.evidence_items WHERE scan_id=$1',[first]);
    assert.equal(e.rows[0].organization_id,a.org);
  });
  await check('C06 replay and separate acknowledgment cannot change terminal result',async()=>{
    assert.equal(await complete(first,lease.o_lease_token,{verdict:'safe'}),false);
    assert.equal(await code(()=>worker.query('SELECT public.app_ack_scan_job($1,$2)',[first,lease.o_lease_token])),'42501');
    assert.equal((await state(first)).verdict,'suspicious');
  });
  const second=await create(b,'https://tenant-b.example'),leaseB=await claim();
  await check('C07 cross-tenant token cannot complete another scan',async()=>{
    assert.equal(leaseB.o_scan_id,second);
    assert.equal(await complete(first,leaseB.o_lease_token),false);
    assert.equal((await state(second)).status,'pending');
  });
  await check('C08 tenant derives from job, not worker-set GUC',async()=>{
    const c=await worker.connect();
    try{
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_organization_id',$1,true)",[a.org]);
      assert.equal((await c.query(stmt,args(second,leaseB.o_lease_token))).rows[0].ok,true);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    const e=await owner.query('SELECT organization_id FROM public.evidence_items WHERE scan_id=$1',[second]);
    assert.equal(e.rows[0].organization_id,b.org);
  });
  const third=await create(a,'https://expired.example'),old=await claim();
  await owner.query("UPDATE public.scan_job_outbox SET leased_until=clock_timestamp()-interval '1 second' WHERE scan_id=$1",[third]);
  await check('C09 expired lease fails without writes',async()=>{
    assert.equal(old.o_scan_id,third);assert.equal(await complete(third,old.o_lease_token),false);
    assert.equal((await state(third)).status,'pending');
  });
  const renewed=await claim();
  await check('C10 rotation invalidates old token',async()=>{
    assert.equal(renewed.o_scan_id,third);assert.notEqual(renewed.o_lease_token,old.o_lease_token);
    assert.equal(await complete(third,old.o_lease_token),false);
  });
  await check('C11 concurrent completion is one-shot',async()=>{
    const r=await Promise.all(Array.from({length:6},()=>complete(third,renewed.o_lease_token)));
    assert.equal(r.filter(Boolean).length,1);
    assert.deepEqual([(await state(third)).vendors,(await state(third)).evidence],[1,1]);
  });
  const fourth=await create(a,"https://sql.example/?q=';DROP TABLE scans;--"),lease4=await claim();
  await check('C12 injection-shaped evidence stored as data',async()=>{
    const title="x'); DROP TABLE evidence_items;--";
    assert.equal(lease4.o_scan_id,fourth);
    assert.equal(await complete(fourth,lease4.o_lease_token,{evidence:[{signal_type:'x',severity:'info',title}]}),true);
    const r=await owner.query('SELECT title FROM public.evidence_items WHERE scan_id=$1',[fourth]);
    assert.equal(r.rows[0].title,title);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename='evidence_items'")).rows[0].n,1);
  });
  const fifth=await create(b,'https://rollback.example'),lease5=await claim();
  await check('C13 rollback restores scan, evidence and outbox; failed result supported',async()=>{
    assert.equal(lease5.o_scan_id,fifth);
    const c=await worker.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query(stmt,args(fifth,lease5.o_lease_token))).rows[0].ok,true);
      await c.query('ROLLBACK');
    }finally{c.release();}
    const s=await state(fifth);assert.deepEqual([s.status,s.job,s.vendors,s.evidence],['pending','leased',0,0]);
    assert.equal(await complete(fifth,lease5.o_lease_token,{status:'failed',verdict:'unknown',vendor:[],evidence:[]}),true);
    assert.equal((await state(fifth)).status,'failed');
  });
  await check('C14 worker has no direct table mutation privilege',async()=>{
    assert.equal(await code(()=>worker.query("UPDATE public.scans SET verdict='safe' WHERE id=$1",[first])),'42501');
    assert.equal(await code(()=>worker.query('SELECT * FROM public.scan_job_outbox')),'42501');
  });
  await check('C15 web cannot call worker completion or legacy status mutation',async()=>{
    assert.equal(await code(()=>app.query(stmt,args(first,lease.o_lease_token))),'42501');
    assert.equal(await code(()=>app.query('SELECT public.app_mark_scan_processing($1)',[first])),'42501');
  });
}catch(e){failed++;console.error('FAIL completion setup: '+String(e));}
finally{await Promise.all([app.end(),worker.end(),owner.end().catch(()=>{})]);}
console.log('\n=== Azure worker completion: '+passed+' passed, '+failed+' failed ===');
process.exitCode=failed?1:0;
