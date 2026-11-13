/**
 * Deleting a video from the Reel or Working screen (renderer screens/remove.ts): `leave` (go home) runs only once
 * `remove` has gone through. A refusal (a background job still stopping, or part of the engine that would not stop;
 * main/proxy-builds.ts) goes to `refused` and keeps the screen: going home would clear its toast (App.tsx), and here
 * the user can delete again.
 */
export async function deleteThenLeave(remove: () => Promise<unknown>, leave: () => void, refused: (e: unknown) => void): Promise<boolean> {
  try {
    await remove()
  } catch (e) {
    refused(e)
    return false
  }
  leave()
  return true
}
