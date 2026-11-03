import {describe,it,expect,vi} from 'vitest';
import {ThreadSubscriptionRegistry} from '../../electron/main/thread-subscription-registry';
describe('subscription release races',()=>{
 it('restores server subscription for an owner acquired during unsubscribe',async()=>{
  let finish!:()=>void;const wait=new Promise<void>(r=>finish=r);
  const call=vi.fn(async(method:string)=>{if(method==='thread/unsubscribe')await wait;return {};});
  const registry=new ThreadSubscriptionRegistry({call} as any);
  registry.acquire('t','remote:a');const release=registry.release('t','remote:a');
  registry.acquire('t','desktop');finish();expect(await release).toBe(false);
  expect(registry.owns('t','desktop')).toBe(true);
  expect(call).toHaveBeenLastCalledWith('thread/resume',{threadId:'t',excludeTurns:true});
 });
});
