import {afterEach,expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {NativeClient} from './workspace-ui-client.mjs';
import {cleanupFixtures,fixture,model} from './fossil-workspace-helpers';
const clients:NativeClient[]=[];
afterEach(async()=>{for(const client of clients.splice(0))await client.close();cleanupFixtures()});
function host(f:ReturnType<typeof fixture>){const native=new NativeClient({binary:resolve(import.meta.dir,'../../zig-out/bin/fx'),project:f.cwd,env:{...process.env,...f.env}});clients.push(native);return native}
async function terminal(native:NativeClient,turn:string){return await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{native.off('event',listener);reject(Error('UI invocation did not stop'))},90000);const listener=(event:any)=>{if(event.turn===turn&&event.data.type==='turn_end'){clearTimeout(timer);native.off('event',listener);resolve(event)}};native.on('event',listener)})}
test('native UI host saves governed turns and replays public events without repeating actions',async()=>{
 const f=fixture();const fixtureModel=model(f,()=>({content:'Hello from the governed native agent.'}));expect((await f.run(['fossil','init','--json'])).code).toBe(0);
 const native=host({...f,env:{...f.env,FX_CONTRACT_REVIEW:"0"}});expect((await native.request('initialize')).version).toBe('omos.ui-host/v1');
 const seen:any[]=[];native.on('event',(event:any)=>seen.push(event));const ending=terminal(native,'ui-runtime-one');await native.request('prompt',{text:'Say hello from this workspace.'},{id:'ui-runtime-one'});const ended=await ending;if(ended.data.exit_code)console.error(JSON.stringify(seen),native.stderr);expect(ended.data.exit_code).toBe(0);
 const session=seen.find(e=>e.data.type==='session')?.data.session_id;expect(session).toBeString();
 const saved=await native.request('snapshot',{action:'session',id:session});expect(saved.history.some((h:any)=>h.assistant?.includes('governed native agent'))).toBe(true);
 const state=await native.request('snapshot',{action:'fossil.status'});expect(state.tasks[0].state).toBe('accepted');
 const count=fixtureModel.counts().actors;const duplicate=await native.request('prompt',{text:'Say hello from this workspace.'},{id:'ui-runtime-one'});expect(duplicate.already_accepted).toBe(true);expect(fixtureModel.counts().actors).toBe(count);
 await expect(native.request('prompt',{text:'Different action'},{id:'ui-runtime-one'})).rejects.toThrow('TurnIdConflict');
 const replay=await native.request('session.events',{session});expect(replay.events.some((e:any)=>e.data.type==='session')).toBe(true);expect(replay.active).toBe(false);
 await expect(native.request('snapshot',{action:'shell'})).rejects.toThrow('UnsupportedSnapshot');
 await expect(native.request('ui.read',{revision:'trunk',path:'ui/manifest.json'})).rejects.toThrow('ImmutableRevisionRequired');
 expect(native.stderr).toBe('');
},90000);

test('native UI writes require a task fence and compilation evidence before publication',async()=>{
 const f=fixture();let wrote=false;model(f,()=>wrote?{content:'Updated the workspace interface.'}:(wrote=true,{tool_calls:[{index:0,id:'write-ui',type:'function',function:{name:'fossil_workspace',arguments:JSON.stringify({action:'write',path:'ui/manifest.json',content:JSON.stringify({version:'omos.ui-source/v1',bridge:'omos.ui-bridge/v1',renderer:'omos.react/v1',toolchain:'a'.repeat(64),entry:'src/main.tsx',stylesheet:'src/style.css'})})}}]}));expect((await f.run(['fossil','init','--json'])).code).toBe(0);
 const native=new NativeClient({binary:resolve(import.meta.dir,'../../zig-out/bin/fx'),project:f.cwd,env:{...process.env,...f.env,FX_MAX_AGENT_STEPS:'12'}});clients.push(native);const observed:any[]=[];let validation:any;native.on('event',(event:any)=>{observed.push(event);if(event.data.type==='validate_ui'){validation=event;void native.request('validation',{turn:event.turn,request_id:event.data.request_id,receipt:{version:'omos.ui-validation/v1',status:'failed',error:'Missing entry source'}})}});
 const end=terminal(native,'invalid-ui-source');await native.request('prompt',{text:'Update the interface, preserving its governed source.'},{id:'invalid-ui-source'});await end;if(!validation)console.error(JSON.stringify(observed),native.stderr);expect(validation).toBeDefined();
 const state=await native.request('snapshot',{action:'fossil.status'});expect(state.tasks[0].state).not.toBe('accepted');expect(state.files.includes('ui/manifest.json')).toBe(false);
 await expect(native.request('validation',{turn:'invalid-ui-source',request_id:validation.data.request_id,receipt:{status:'passed'}})).rejects.toThrow();
},90000);

test('legacy interface history is retained once on an unpublished branch',async()=>{
 const f=fixture();expect((await f.run(['fossil','init','--json'])).code).toBe(0);const native=host(f);const before=await native.request('snapshot',{action:'fossil.status'});
 const content=JSON.stringify({version:'omos.ui-legacy-input/v1',status:'unpublished_input',files:[{path:'.revisions/old.json',content:'Retained local appearance input'}]});const retained=await native.request('ui.import_legacy',{content});expect(retained.retained).toBe(true);expect(retained.publication).toBe('unpublished');expect(retained.artifact).toStartWith('artifacts/');
 const again=await native.request('ui.import_legacy',{content});expect(again.task).toBe(retained.task);const after=await native.request('snapshot',{action:'fossil.status'});expect(after.trunk_revision).toBe(before.trunk_revision);expect(after.tasks.length).toBe(1);expect(after.tasks[0].state).toBe('paused');
},90000);
