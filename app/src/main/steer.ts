// The words a person adds to the note running now (the AI package's NoteSteer: ai/src/steer.ts). The queue makes one
// box per run of a note. The note's tools take the words between steps; once the note has finished, the box is
// sealed and `add` says no, so the queue runs those words as the next note instead. Words added but never taken
// (the note ended another way) come back from `close`, so none is lost.

export class SteerBox {
  private waiting: { id: string; text: string }[] = []
  private sealed = false
  private closed = false

  /** False once the note can no longer read new words: it finished, or its run ended. */
  add(id: string, text: string): boolean {
    if (this.sealed || this.closed) return false
    this.waiting.push({ id, text })
    return true
  }

  take(): string[] {
    return this.waiting.splice(0).map((w) => w.text)
  }

  seal(): boolean {
    if (this.waiting.length) return false
    this.sealed = true
    return true
  }

  unseal(): void {
    if (!this.closed) this.sealed = false
  }

  /** The run ended: no more words, and the ids of the ones it never read. */
  close(): string[] {
    this.closed = true
    return this.waiting.splice(0).map((w) => w.id)
  }
}
