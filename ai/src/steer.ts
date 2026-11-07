// Words the person adds to a note while it runs (T3 Code calls this steering). The app holds them; a note's tools
// hand them to the model with the next tool result (executeTool), so our own loop and Claude Code or Codex over MCP
// all get them the same way, between two steps, never in the middle of one. finish is refused while any are unread,
// so a note is never saved without having read what was added. Once finish is accepted the box is sealed and the
// app runs later words as the next note.

export interface NoteSteer {
  /** The words added since the last take, oldest first. Each is returned once. */
  take(): string[];
  /** Closes the box to new words when none are waiting and returns true; with words waiting it stays open and
   * returns false. */
  seal(): boolean;
  /** Opens a sealed box again: the step that sealed it did not finish the note after all. */
  unseal(): void;
}

/** A tool result with the added words after it, in words the model reads as part of the note. */
export function withAdded(content: string, added: string[]): string {
  return `${content}\n\nThe person added to their note while you worked. Treat this as part of their note and do it too:\n${added.map((w) => `- ${JSON.stringify(w)}`).join('\n')}`;
}

/** finish while words are waiting: not saved yet, and the words come with the refusal. */
export function finishRefused(added: string[]): string {
  return JSON.stringify({
    error: 'Not finished yet: the person added to their note while you worked. Do this too, then call finish again with a summary that covers it.',
    person_added: added,
  });
}
