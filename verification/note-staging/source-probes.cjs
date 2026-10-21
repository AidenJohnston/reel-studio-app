const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const entry = { text: 'verification', applied: ['title'], at: '2026-10-21T00:00:00Z' };

// Compile copies of the actual source. The mutation never touches a tracked file.
async function compileSource(dir, mutations = {}) {
  for (const name of ['note-staging', 'project', 'types', 'style']) {
    let source = await fs.readFile(path.join(root, 'ai/src', name + '.ts'), 'utf8');
    if (name === 'note-staging' && mutations.removeHashCheck) {
      const guard = 'if (hash(live) !== this.base) {';
      assert.equal(source.split(guard).length, 2, 'The hash-check mutation needs a new source mapping');
      source = source.replace(guard, 'if (false) {');
    }
    if (name === 'note-staging' && mutations.removeCreditsGuard) {
      const guard = 'if (current && hash(current) === manifest.creditsHash) {';
      assert.equal(source.split(guard).length, 2, 'The credits-guard mutation needs a new source mapping');
      source = source.replace(guard, 'if (current) {');
    }
    if (name === 'note-staging' && mutations.removeManifest) {
      const manifestWrite = "      files.push([path.join(this.dir, 'publication.json'), JSON.stringify(manifest) + '\\n']);";
      assert.equal(source.split(manifestWrite).length, 2, 'The publication-manifest mutation needs a new source mapping');
      source = source.replace(manifestWrite, '      // broken mutant: omit publication recovery evidence');
    }
    if (name === 'note-staging' && mutations.appendNoteAfterCommit) {
      const noteWrite = '      p.notes = [...p.notes, note];';
      assert.equal(source.split(noteWrite).length, 2, 'The append-after-commit mutation needs a new source mapping');
      source = source.replace(noteWrite, '');
      const prepared = "      const files: [string, string][] = [[path.join(this.versionDir, 'project.json'), projectBytes], [tmp, projectBytes]];";
      assert.equal(source.split(prepared).length, 2, 'The append-after-commit snapshot mutation needs a new source mapping');
      source = source.replace(prepared, "      const files: [string, string][] = [[path.join(this.versionDir, 'project.json'), JSON.stringify({ ...p, notes: [...p.notes, note] }, null, 2) + '\\n'], [tmp, projectBytes]];");
      const append = '      this.appended = true;';
      assert.equal(source.split(append).length, 2, 'The append-after-commit write mutation needs a new source mapping');
      source = source.replace(append, noteWrite + "\n      await writeFileAtomic(file, JSON.stringify(p, null, 2) + '\\n');\n" + append);
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
  await fs.mkdir(path.join(dir, 'work/assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'work/assets/existing.png'), 'original live asset');
  await fs.writeFile(path.join(dir, 'work/assets/credits.json'), '{"existing.png":"original credit"}\r\n');
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
async function recoveryNoticeProbe(parent, api, mutations = {}) {
  const app = path.join(parent, 'app');
  for (const name of ['main/store', 'main/paths', 'main/media-url', 'shared/cut']) {
    let source = await fs.readFile(path.join(root, 'app/src', name + '.ts'), 'utf8');
    if (name === 'main/store' && mutations.oldDedupe) {
      const current = `          const announced = new Set(st.chat.flatMap((message) => message.id.startsWith('interrupted-note:')
            ? message.id.slice('interrupted-note:'.length).split(',') : []))
          const pending = unfinished.filter((id) => !announced.has(id))
          if (pending.length) {
            st.chat.push({ id: \`interrupted-note:\${pending.join(',')}\`, from: 'editor', text: INTERRUPTED_CHANGE, at: new Date().toISOString() })`;
      const old = `          const id = \`interrupted-note:\${unfinished.join(',')}\`
          if (!st.chat.some((message) => message.id === id)) {
            st.chat.push({ id, from: 'editor', text: INTERRUPTED_CHANGE, at: new Date().toISOString() })`;
      assert.equal(source.split(current).length, 2, 'The notice-dedupe mutation needs a new source mapping');
      source = source.replace(current, old);
    }
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
  assert.deepEqual(ids, ['interrupted-note:A,B'], 'Recovery duplicated an interruption notice');
  const once = await fs.readFile(path.join(dir, 'app.json'));
  await store.recoverInterrupted();
  assert.deepEqual(await fs.readFile(path.join(dir, 'app.json')), once);
  console.log('PASS actual store: interrupted cleanup of A,B leaves one notice after retry');
  console.log('PASS actual store: two completed recovery passes leave identical app.json bytes');
}

async function recoveryBoundaryProbe(parent, api, boundary) {
  const { dir, txn, before, asset } = await fixture(parent, api);
  const creditsFile = path.join(dir, 'work/assets/credits.json');
  const assetFile = path.join(dir, 'work/assets/existing.png');
  const originalCredits = await fs.readFile(creditsFile);
  const originalAsset = await fs.readFile(assetFile);
  await assert.rejects(txn.publish(entry, [], undefined, step => {
    if (step === boundary) throw new Error('boundary crash');
  }), /boundary crash/);
  await api.recoverNoteStaging(dir);
  assert.deepEqual(await fs.readFile(path.join(dir, 'project.json')), before);
  assert.deepEqual(await fs.readFile(assetFile), originalAsset);
  assert.deepEqual(await fs.readFile(creditsFile), originalCredits, 'Recovery did not restore exact credits bytes');
  await assert.rejects(fs.access(path.join(dir, 'work/assets', asset)), { code: 'ENOENT' }, 'Recovery left a transaction asset live');
  await assert.rejects(fs.access(path.join(dir, 'versions/v2')), /ENOENT/);
  const once = await fs.readFile(creditsFile);
  await api.recoverNoteStaging(dir);
  assert.deepEqual(await fs.readFile(creditsFile), once);
}

async function committedNoteProbe(parent, api) {
  const { dir, txn } = await fixture(parent, api);
  await assert.rejects(txn.publish(entry, [], undefined, step => {
    if (step === 'project') throw new Error('boundary crash');
  }), /boundary crash/);
  const live = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(live.version, 2);
  assert.equal(live.notes.some(note => note.txnId === txn.txnId), true, 'The committed live project lacks its note');
  assert.deepEqual(await fs.readFile(path.join(dir, 'project.json')), await fs.readFile(path.join(dir, 'versions/v2/project.json')));
  const committed = await fs.readFile(path.join(dir, 'project.json'));
  await api.recoverNoteStaging(dir);
  assert.deepEqual(await fs.readFile(path.join(dir, 'project.json')), committed);
  await api.recoverNoteStaging(dir);
  assert.deepEqual(await fs.readFile(path.join(dir, 'project.json')), committed);
  console.log('PASS actual source: project commit already contains the note and recovery is idempotent');
}

async function externalCreditsProbe(parent, api) {
  const { dir, txn } = await fixture(parent, api);
  await assert.rejects(txn.publish(entry, [], undefined, step => {
    if (step === 'credits') throw new Error('boundary crash');
  }), /boundary crash/);
  const credits = path.join(dir, 'work/assets/credits.json');
  const newer = '{ "external.png": "newer credit" }\r\n';
  await fs.writeFile(credits, newer);
  await api.recoverNoteStaging(dir);
  assert.equal(await fs.readFile(credits, 'utf8'), newer, 'Recovery overwrote external credits');
  await api.recoverNoteStaging(dir);
  assert.equal(await fs.readFile(credits, 'utf8'), newer, 'Repeated recovery overwrote external credits');
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'note-staging-source-'));
  try {
    const api = await compileSource(temp);
    await staleProbe(temp, api);
    console.log('PASS actual source: stale base is refused');

    for (const boundary of ['base', 'assets', 'credits', 'version']) {
      await recoveryBoundaryProbe(temp, api, boundary);
    }
    console.log('PASS actual source: base, assets, credits, and version crash recovery restores exact live bytes');
    await committedNoteProbe(temp, api);
    await externalCreditsProbe(temp, api);
    console.log('PASS actual source: recovery preserves a completed external credits write');

    await recoveryNoticeProbe(temp, api);

    const noManifestDir = path.join(temp, 'no-manifest');
    await fs.mkdir(noManifestDir);
    const noManifest = await compileSource(noManifestDir, { removeManifest: true });
    await assert.rejects(recoveryBoundaryProbe(noManifestDir, noManifest, 'assets'),
      { code: 'ERR_ASSERTION', message: /Recovery left a transaction asset live/ });
    console.log('PASS rehearsal: recovery-boundary assertion catches publication-manifest deletion');

    const appendMutantDir = path.join(temp, 'append-after-commit');
    await fs.mkdir(appendMutantDir);
    const appendMutant = await compileSource(appendMutantDir, { appendNoteAfterCommit: true });
    await assert.rejects(committedNoteProbe(appendMutantDir, appendMutant),
      { code: 'ERR_ASSERTION', message: /The committed live project lacks its note/ });
    console.log('PASS rehearsal: committed-note assertion catches append-after-commit mutant');

    const oldDedupeDir = path.join(temp, 'old-dedupe');
    await fs.mkdir(oldDedupeDir);
    const oldDedupeApi = await compileSource(oldDedupeDir);
    await assert.rejects(recoveryNoticeProbe(oldDedupeDir, oldDedupeApi, { oldDedupe: true }),
      { code: 'ERR_ASSERTION', message: /Recovery duplicated an interruption notice/ });
    console.log('PASS rehearsal: notice assertion catches old single-ID dedupe');

    const creditsMutantDir = path.join(temp, 'no-credits-guard');
    await fs.mkdir(creditsMutantDir);
    const creditsMutant = await compileSource(creditsMutantDir, { removeCreditsGuard: true });
    await assert.rejects(externalCreditsProbe(creditsMutantDir, creditsMutant),
      { code: 'ERR_ASSERTION', message: /Recovery overwrote external credits/ });
    console.log('PASS rehearsal: external credits assertion catches removed recovery hash guard');

    const scratch = path.join(temp, 'mutant');
    await fs.mkdir(scratch);
    const mutant = await compileSource(scratch, { removeHashCheck: true });
    await assert.rejects(staleProbe(scratch, mutant), /A stale note published instead of refusing/);
    console.log('PASS rehearsal: stale-note assertion catches real-source hash-check deletion');
    await staleProbe(temp, api);
    console.log('PASS restored source: stale base is refused again');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
