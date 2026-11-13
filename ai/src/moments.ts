// Changed moments first. When a reply of the AI changes what the video shows, the engine's `moments`
// command (engine/reelengine/moments.py) draws stills of what changed, then the 2 s around them, then
// the draft, while the AI is busy with its next turn. Each still and window reaches the app as a
// `moment` event as soon as its file exists, and the draft as a `render` event, so the screen follows
// the edit instead of waiting for a whole draft.
//
// One run at a time, never beside another render of this project (they share work/render/ and
// versions/preview/). A save stops a run still going before it writes: the run reads project.json at
// each stage and would otherwise draw part of one edit and part of the next. A render the AI asks for
// waits for a run of the current edit (render_draft then uses its draft) and stops any other. The engine moves its base (what the screen shows) only when a run finishes, so
// the next run also draws what a stopped one did not.
import type { AgentEvent, EngineHost, MomentReady } from './types';

/** What a run needs from the task (a ToolContext satisfies it; renderGate is read when a run starts). */
export interface MomentsTask {
  host: EngineHost;
  projectDir: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  renderGate?: Promise<unknown>;
}

interface Run { edit: number; abort: AbortController; done: Promise<unknown>; settled: boolean }

export class Moments {
  private run: Run | null = null;
  private marked: Promise<unknown> = Promise.resolve();
  /** the run that last finished: the edit it drew and the engine's result */
  private finished: { edit: number; result: any } | null = null;
  private shownPicture = -1;

  constructor(private task: MomentsTask) {}

  /** Records the project as it is now as what the screen shows. Call once, before the task's first save. */
  mark(): void {
    this.marked = this.task.host.runEngine('moments', ['--project', this.task.projectDir, '--mark'], undefined, this.task.signal)
      .catch(() => undefined);  // no base: the first run draws stills of the whole video instead
  }

  /** Before a save: waits for mark() to have written the base, and stops a run still going. */
  async beforeSave(): Promise<void> {
    await this.marked;
    if (this.run && !this.run.settled) await this.before(null);
  }

  /** The project is now at `edit`, and `picture` is the last edit that changed what it shows. Stops a
   * run of an older edit and draws this one; does nothing when this picture is already being drawn. */
  show(edit: number, picture: number): void {
    if (picture === this.shownPicture) return;
    this.shownPicture = picture;
    const prev = this.run;
    prev?.abort.abort();
    const abort = new AbortController();
    const run: Run = { edit, abort, done: Promise.resolve(), settled: false };
    run.done = this.draw(edit, abort.signal, prev).finally(() => { run.settled = true; });
    this.run = run;
  }

  private async draw(edit: number, stop: AbortSignal, prev: Run | null): Promise<void> {
    await prev?.done;
    await this.task.renderGate?.catch(() => undefined);
    await this.marked;
    if (stop.aborted || this.task.signal?.aborted) return;
    const signal = this.task.signal ? AbortSignal.any([stop, this.task.signal]) : stop;
    try {
      const r = await this.task.host.runEngine('moments', ['--project', this.task.projectDir], (p) => {
        if (p.ready && !stop.aborted) this.task.emit(momentEvent(p.ready));
      }, signal);
      if (stop.aborted) return;
      if (r?.draft?.file) this.task.emit({ type: 'render', version: Number(r.draft.version ?? 0), draft: true, file: String(r.draft.file) });
      this.finished = { edit, result: r };
    } catch (e: any) {
      // A stopped engine is killed: wait until it is gone, or the next render would share its files.
      if (e?.exited instanceof Promise) await e.exited;
      // Any other failure costs only these early pictures: the AI's own render shows the edit.
    }
  }

  /** Before a render the AI asked for. With `edit`: waits for a run of that edit and returns the engine's
   * result when one finished (null otherwise), and stops a run of any other edit. With null: stops any run. */
  async before(edit: number | null): Promise<any | null> {
    const run = this.run;
    if (run) {
      if (edit === null || run.edit !== edit) {
        run.abort.abort();
        this.shownPicture = -1;   // not drawn after all: the next show() draws it
      }
      await run.done;
    }
    return edit !== null && this.finished?.edit === edit ? this.finished.result : null;
  }

  /** Stops any run and waits until its engine is gone. */
  async stop(): Promise<void> { await this.before(null); }
}

export function momentEvent(m: MomentReady): AgentEvent {
  return m.kind === 'still'
    ? { type: 'moment', kind: 'still', t: m.t, file: m.file }
    : { type: 'moment', kind: 'window', from: m.from, to: m.to, file: m.file };
}
