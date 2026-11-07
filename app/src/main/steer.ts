// The words a person adds to the note running now (the AI package's NoteSteer: ai/src/steer.ts). The queue makes one
// box per run of a note. The note's tools take the words between steps; once the note has finished, the box is
// sealed and `add` says no, so the queue runs those words as the next note instead. Words added but never read
// come back as notes of their own: the saved note shows what was read (note-queue.ts dropSaved).

export class SteerBox {
  private waiting: string[] = []
  private sealed = false
  private closed = false

  /** False once the note can no longer read new words: it finished, or its run ended. */
  add(text: string): boolean {
    if (this.sealed || this.closed) return false
    this.waiting.push(text)
    return true
  }

  take(): string[] {
    return this.waiting.splice(0)
  }

  seal(): boolean {
    if (this.waiting.length) return false
    this.sealed = true
    return true
  }

  unseal(): void {
    if (!this.closed) this.sealed = false
  }

  /** The run ended: no more words. */
  close(): void {
    this.closed = true
  }
}
