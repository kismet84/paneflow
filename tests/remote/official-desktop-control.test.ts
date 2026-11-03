import {describe,it,expect,vi} from 'vitest';
import {OfficialDesktopControl} from '../../electron/main/official-desktop-control';
describe('official desktop pipe adapter',()=>{
 it('fails closed on missing or ambiguous desktop instances',async()=>{
  const call=vi.fn();
  await expect(new OfficialDesktopControl(call,async()=>[]).acquire('t')).rejects.toThrow('未找到');
  await expect(new OfficialDesktopControl(call,async()=>['a','b']).acquire('t')).rejects.toThrow('多个');
  expect(call).not.toHaveBeenCalled();
 });
 it('pins the instance and thread and propagates uncertain sends without retry',async()=>{
  const request=vi.fn(async()=>({success:true}));const control=new OfficialDesktopControl(request,async()=>['pipe']);
  const grant=await control.acquire('thread');request.mockRejectedValueOnce(Error('disconnected'));
  await expect(control.send(grant,'hello')).rejects.toThrow('disconnected');
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual(['pipe','tools/call',expect.objectContaining({tool:'send_message_to_thread',arguments:{threadId:'thread',hostId:'local',prompt:'hello'}})]);
 });
});
