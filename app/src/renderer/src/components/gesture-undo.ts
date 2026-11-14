// Undo for the editing timeline (Reel.tsx): each gesture is a hand edit in the reel's queue (main/note-queue.ts
// sendHand), and Cmd/Ctrl+Z takes back the newest one that is still waiting its turn. Gestures are kept in the order
// they were made, each with the queue id its handEdit call answered with, so two gestures sent close together can
// never be confused, and whether one still waits is main's answer (queue.cancel), not the screen's last read.

export type UndoAnswer = 'taken' | 'ran' | 'nothing'

export interface GestureUndo {
  /** A gesture was sent: `sent` is its handEdit call. A refused one leaves no trace. */
  made(sent: Promise<{ id: string }>): void
  /** Takes back the newest gesture: 'taken' (it was waiting), 'ran' (it is being made, or made), 'nothing' (none). */
  undo(): Promise<UndoAnswer>
  clear(): void
}

/** `cancel` is queue.cancel; it rejects with code NOT_QUEUED once the entry has started. */
export function gestureUndo(cancel: (id: string) => Promise<void>): GestureUndo {
  let made: Promise<string | null>[] = []
  return {
    made(sent) {
      const id = sent.then((r) => r.id, () => null)
      made.push(id)
      // a refused gesture is not one to take back
      void id.then((x) => {
        if (x === null) made = made.filter((m) => m !== id)
      })
    },
    async undo() {
      let id: string | null = null
      while (id === null) {
        const last = made.pop()
        if (!last) return 'nothing'
        id = await last // a gesture main refused answers null and is skipped
      }
      try {
        await cancel(id)
        return 'taken'
      } catch (e) {
        if ((e as { code?: unknown })?.code === 'NOT_QUEUED') return 'ran'
        throw e
      }
    },
    clear() {
      made = []
    }
  }
}
