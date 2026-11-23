import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function openStore(directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'household.json');
  let state;
  let fresh = false;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (state.schema !== 1 || !Array.isArray(state.sources) || !state.secret) throw new Error('数据文件格式不正确');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取家庭数据，请检查 ${file}：${error.message}`);
    fresh = true;
    state = { schema: 1, secret: randomBytes(32).toString('hex'), sources: [], devices: [], sessions: [], history: [], favorites: [], activity: [] };
  }
  let pending = Promise.resolve();
  const save = () => {
    const json = JSON.stringify(state, null, 2);
    const operation = pending.catch(() => {}).then(async () => {
      const temporary = `${file}.${randomBytes(5).toString('hex')}.tmp`;
      await writeFile(temporary, json, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    });
    pending = operation;
    return operation;
  };
  const activity = (type, message) => {
    state.activity.unshift({ id: randomBytes(8).toString('hex'), type, message, at: new Date().toISOString() });
    state.activity = state.activity.slice(0, 60);
  };
  await save();
  return { state, fresh, save, activity, flush: () => pending };
}
