const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const entry = { text: 'verification', applied: ['title'], at: '2026-10-21T00:00:00Z' };

// Compile copies of the actual source. The mutation never touches a tracked file.
async function compileSource(dir, removeHashCheck) {
  for (const name of ['note-staging', 'project', 'types', 'style']) {
    let source = await fs.readFile(path.join(root, 'ai/src', name + '.ts'), 'utf8');
    if (name === 'note-staging' && removeHashCheck) {
      const guard = 'if (hash(live) !== this.base) {';
      assert.equal(source.split(guard).length, 2, 'The hash-check mutation needs a new source mapping');
      source = source.replace(guard, 'if (false) {');
    }
    await fs.writeFile(path.join(dir, name + '.ts'), source);
    const result = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    });
    await fs.writeFile(path.join(dir, name + '.js'), result.outputText);
  }
  return require(path.join(dir, 'note-staging.js'));
}

async function fixture(parent, api) {
  const dir = await fs.mkdtemp(path.join(parent, 'project-'));
  const { withDefaults } = require(path.join(parent, 'project.js'));
  const project = withDefaults({
    version: 1, title: 'Old', slug: 'verification',
    sources: [{ id: 's1', path: 'media/take.mp4', duration: 1 }]
  });
  await fs.mkdir(path.join(dir, 'versions/v1'), { recursive: true });
  await fs.writeFile(path.join(dir, 'versions/v1/export.mp4'), 'old video');
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(project));
  const before = await fs.readFile(path.join(dir, 'project.json'));
  const txn = await api.beginNote(dir);
  await fs.writeFile(path.join(txn.dir, 'project.json'), JSON.stringify({ ...project, title: 'New' }));
  await fs.mkdir(txn.versionDir, { recursive: true });
  await fs.writeFile(path.join(txn.versionDir, 'export.mp4'), 'new video');
  const asset = txn.txnId + '-image.png';
  await fs.writeFile(path.join(txn.dir, 'work/assets', asset), 'new asset');
  await fs.writeFile(path.join(txn.dir, 'work/assets/credits.json'), JSON.stringify({ [asset]: 'credit' }));
  return { dir, txn, before, asset };
}

async function staleProbe(parent, api) {
  const { dir, txn } = await fixture(parent, api);
  const file = path.join(dir, 'project.json');
  const manual = JSON.parse(await fs.readFile(file, 'utf8'));
  manual.title = 'Manual';
  await fs.writeFile(file, JSON.stringify(manual));
  const bytes = await fs.readFile(file);
  let error;
  try { await txn.publish(entry); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'stale_note', 'A stale note published instead of refusing');
  assert.deepEqual(await fs.readFile(file), bytes);
}

// Compile the store unchanged and connect it to the copied transaction API.
// The wrapper stops recursive cleanup after its first orphan directory.
async function recoveryNoticeProbe(parent, api) {
  const app = path.join(parent, 'app');
  for (const name of ['main/store', 'main/paths', 'main/media-url', 'shared/cut']) {
    const source = await fs.readFile(path.join(root, 'app/src', name + '.ts'), 'utf8');
    const file = path.join(app, name + '.js');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText);
  }
  const bridge = path.join(app, 'main/ai.js');
  await fs.writeFile(bridge, 'module.exports = require(' + JSON.stringify(path.join(parent, 'note-staging.js')) + ');');
  const paths = require(path.join(app, 'main/paths.js'));
  paths.initPaths({ isPackaged: false, resourcesPath: parent, documentsDir: parent,
    userDataDir: parent, appDir: app, rootOverride: path.join(parent, 'store-fixture'), env: {} });
  const store = require(path.join(app, 'main/store.js'));
  await store.ensureRoot();
  const dir = store.projectDir('interrupted');
  await fs.mkdir(path.join(dir, '.staging/A'), { recursive: true });
  await fs.mkdir(path.join(dir, '.staging/B'), { recursive: true });
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ version: 0, notes: [] }));
  const recover = api.recoverNoteStaging;
  api.recoverNoteStaging = async projectDir => {
    assert.equal(projectDir, dir);
    await fs.rm(path.join(dir, '.staging/A'), { recursive: true });
    throw new Error('crash during recursive cleanup');
  };
  try {
    await assert.rejects(store.recoverInterrupted(), /crash during recursive cleanup/);
  } finally { api.recoverNoteStaging = recover; }
  await store.recoverInterrupted();
  const ids = (await store.readAppState('interrupted')).chat.map(message => message.id);
  assert.deepEqual(ids, ['interrupted-note:A,B', 'interrupted-note:B']);
  const once = await fs.readFile(path.join(dir, 'app.json'));
  await store.recoverInterrupted();
  assert.deepEqual(await fs.readFile(path.join(dir, 'app.json')), once);
  console.log('FINDING actual store: interrupted cleanup of A,B duplicates the notice for B on retry');
  console.log('PASS actual store: two completed recovery passes leave identical app.json bytes');
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'note-staging-source-'));
  try {
    const api = await compileSource(temp, false);
    await staleProbe(temp, api);
    console.log('PASS actual source: stale base is refused');

    const orphan = await fixture(temp, api);
    await assert.rejects(orphan.txn.publish(entry, [], undefined, step => {
      if (step === 'assets') throw new Error('boundary crash');
    }), /boundary crash/);
    await api.recoverNoteStaging(orphan.dir);
    assert.deepEqual(await fs.readFile(path.join(orphan.dir, 'project.json')), orphan.before);
    assert.equal(await fs.readFile(path.join(orphan.dir, 'work/assets', orphan.asset), 'utf8'), 'new asset');
    console.log('FINDING actual source: precommit crash leaves an extra live asset after recovery');

    const append = await fixture(temp, api);
    await assert.rejects(append.txn.publish(entry, [], undefined, step => {
      if (step === 'project') throw new Error('boundary crash');
    }), /boundary crash/);
    await api.recoverNoteStaging(append.dir);
    const live = JSON.parse(await fs.readFile(path.join(append.dir, 'project.json'), 'utf8'));
    const snapshot = JSON.parse(await fs.readFile(path.join(append.dir, 'versions/v2/project.json'), 'utf8'));
    assert.equal(live.version, 2);
    assert.equal(live.notes.some(n => n.txnId === append.txn.txnId), false);
    assert.equal(snapshot.notes.some(n => n.txnId === append.txn.txnId), true);
    console.log('FINDING actual source: committed live project lacks the note present in the version snapshot');

    await recoveryNoticeProbe(temp, api);

    const scratch = path.join(temp, 'mutant');
    await fs.mkdir(scratch);
    const mutant = await compileSource(scratch, true);
    await assert.rejects(staleProbe(scratch, mutant), /A stale note published instead of refusing/);
    console.log('PASS rehearsal: stale-note assertion catches real-source hash-check deletion');
    await staleProbe(temp, api);
    console.log('PASS restored source: stale base is refused again');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
