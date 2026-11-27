import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppExecutionBackend, AppExecutionProjection } from '../spi/runtime/execution-backend.js';

const {createRuntime}:typeof import('../index.js')=await import(new URL('../../dist/index.js',import.meta.url).href);
const sdk=new URL('../../../sdk/dist/index.js',import.meta.url).href;
const raw=fileURLToPath(new URL('./fixtures/neutral-raw.py',import.meta.url));
type Table={name:string;multiplicity:'single'|'multiple'}[];
function backend(types:Table):AppExecutionBackend{
    return {start(launch,emit){
        return {send(r){
            if(r.kind==='initialize')emit({kind:'reply',id:r.id,status:'ready'});
            if(r.kind==='open'){
                const result=launch.acceptProjection({sourceEpoch:1,producerSeq:1,healthySince:1,views:[],refs:[],tools:[],viewTypes:types},'authoritative',r.id);
                if(result.status==='accepted')emit({kind:'reply',id:r.id,status:'done',publication:result.publication});
                else emit({kind:'reply',id:r.id,status:'failed',issue:result.issue});
            }
            if(r.kind==='observe'&&r.known)emit({kind:'projectionCurrent',id:r.id,publication:r.known});
            if(r.kind==='stop'||r.kind==='close')emit({kind:'reply',id:r.id,status:'done',cleanup:{state:r.kind==='stop'?'stopped':'completed',issues:[]}});
        },terminate(){emit({kind:'exited'});}};
    }};
}

const count=(n:number):Table=>Array.from({length:n},(_,i)=>({name:'T'+i,multiplicity:'single'}));
const bytesTable:Table=[{name:'AsciiName',multiplicity:'single'}];
const bytes=Buffer.byteLength(JSON.stringify(bytesTable),'utf8');

it.each(['node','custom','raw'] as const)('same effective ViewType count and metadata canonical budget on actual %s execution',async kind=>{
    const dir=await mkdtemp(join(tmpdir(),'aotui-neutral-seal-'));
    try{
        for(const vector of [
            {label:'count-exact',types:count(1000),accepted:true},
            {label:'count-over',types:count(1001),accepted:false},
            {label:'bytes-exact',types:bytesTable,limit:bytes,accepted:true},
            {label:'bytes-over',types:bytesTable,limit:bytes-1,accepted:false},
        ]){
            const runtime=createRuntime({executionBackends:{custom:backend(vector.types)},worker:{timeoutMs:3000}});
            try{
                const desktop=await runtime.createDesktop();
                const options=vector.limit?{projectionLimits:{metadata:{maxCanonicalBytes:vector.limit}}}:{};
                let opening:Promise<import('../index.js').RunningApp>;
                if(kind==='node'){
                    const path=join(dir,'seal.mjs');
                    await writeFile(path,`import {createApp,defineViewType} from ${JSON.stringify(sdk)};
export default createApp({app_name:'seal',viewTypes:${JSON.stringify(vector.types)}.map(t=>defineViewType({...t,region:'dynamic'})),initialize(a){a.publish(()=>[]);}});`);
                    opening=desktop.installDynamicWorkerApp(path,{name:'seal',...options});
                }else{
                    await desktop.registerPendingApp({installationId:'seal',name:'seal',...(kind==='custom'?{backend:'custom'}:{command:['python3','-u',raw,'seal'],config:{types:vector.types}}),...options});
                    opening=desktop.openApp('seal');
                }
                if(vector.accepted){
                    const app=await opening;
                    expect(await app.preview(),vector.label).toMatchObject({status:'previewed',views:[]});
                }else{
                    const error=await opening.catch(e=>e);
                    expect(error,vector.label).toMatchObject({code:'INSTALL_FAILED',cause:{code:'SNAPSHOT_CAPACITY',cause:{path:'$.viewTypes'}}});
                    expect(error.closeReport.resourcesReleased).toBe(true);
                }
            }finally{await runtime.beginClose().completion;}
        }
    }finally{await rm(dir,{recursive:true,force:true});}
},30000);
