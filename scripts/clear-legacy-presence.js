import { mutateState } from '../src/store.js';

await mutateState((state) => {
  state.presence = {};
});
console.log('旧版自报活跃数据已清空。');
