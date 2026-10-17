# Design critique (UI/UX review, 2026-10-17)

Source screenshots: `app/e2e/screenshots/` (from the `ux` stream run). Labels: [defect] objectively broken,
[judgment] clear quality win, [taste] preference.

## 1. Where a non-technical person gets stuck, scared or confused
1. [defect] Toasts never leave and follow you between screens (06 import toast on New video; 07 red "Drop a video file" error under a healthy job; ux-05..09 "Saved. Your caption will be in your export." across 5 screens, covering the drawer footer). Fix: success toasts auto-dismiss after 4 s, no OK button; clear all toasts on route change; errors inline next to their cause, never a floating toast on another screen.
2. [defect] "Caption" means two things. Call the on-video words "Subtitles" everywhere (checklist, drawer tab, Working step "Adding subtitles", chat). Keep "Post caption" only for the Instagram text. New toast: "Saved. Copy it when you post."
3. [judgment] "What I did" checklist reads like unfinished homework (empty circles; "74 words cut"). Split into "Done" (filled checks) and "Optional extras" (no circles; links "Add pictures", "Add a song", "Write a post caption"). Cut line: "Kept your best take · 0:16 long" with "See what I cut". Drop word counts.
4. [judgment, biggest gap] No live preview in the drawer. Overlay a CSS mock of the subtitle style (size, position, colour, box) on the phone frame using a sample line from the transcript. Stop dimming the phone while the drawer is open.
5. [defect] Native video player shows through (loading spinner over the face; the kebab menu offers Download/speed/PiP). Fix: poster = cover frame; controlsList="nodownload noplaybackrate"; disablePictureInPicture; no spinner until play; ideally custom controls (one big play button + thin scrub bar).
6. [judgment] Export ends at the hardest moment (file on computer, Instagram on phone). Put the post caption box inside the export dialog; add "Open Instagram" (instagram.com/create); one line: "Upload it at instagram.com, or send it to your phone with AirDrop." (Windows: "Phone Link"). Never send the user away to re-export for text that isn't in the file. **Superseded 2026-10-17:** "Phone Link" meant nothing to iPhone users (grandma2 row 18); the dialog now has **Send to my phone** (QR code, same on both platforms; `status/phone.md`).
7. [judgment] Chat invites typing it can't act on without AI. Placeholder "Connect an AI editor to change things by typing" with Connect inside the box. Taller chat (now ~130 px, clipped). Always show the user's own message as a bubble.
8. [judgment] "Here is version 3 with your changes." says nothing. Describe the change: "Version 3: bigger yellow subtitles, moved up." Same text as the chip tooltip. Export button says "Export Version 4".
9. [defect] Settings shows a temp path with `USER~1`. Show "Documents › Reel Studio", full path in a tooltip; resolve with fs.realpathSync.native.
10. [wording] "I have a Claude key" -> text link everywhere: "Use an Anthropic API key (advanced)". "B-roll" -> "Extra clips". "One quick download" -> "One download, about 500 MB". "Do this later": remove, or say "You'll need this before your first video."
11. [defect] "Stopped" vs "paused" for the same state: use "Paused" for both.
12. [defect] Library import toast garbled ("notes.txt: "notes.txt" isn't…"). Replace with "Added 1 song and 1 picture. Skipped notes.txt (not a video, song or picture)."
13. [judgment] Delete next to the main action: move into a ⋯ menu with a confirm.

## 2. Hierarchy, layout, spacing, type, colour, consistency
- [defect] Native controls in OS blue (checkbox, radio, slider, select): `:root { accent-color: <ink> }`; style the select like the text inputs.
- [defect] Layout shifts as version chips are added: fixed phone column (~340 px), chips wrap.
- Segmented controls stretch with empty space: size to content (inline-flex) or equal-width segments.
- Transcripts justified (uneven gaps) + stray horizontal scrollbar: left-align, overflow-x hidden; one paragraph per take with "Take 1 · cut" / "Take 2 · kept" labels; clicking a word seeks the preview.
- Icons from three sources (unicode glyphs, 🎬 emoji, mixed ✓/🎥/♪): use one set, Lucide 18 px, 1.5 stroke, ink colour.
- Green does too many jobs: green = done only. Links ink + underline or small buttons (12 px green links are too small to aim at).
- Secondary text too light/small: secondary >= 13 px and >= 4.5:1 contrast; body 15 px.
- "Connect AI" nag appears three times on one screen: keep sidebar status; banner dismissible per video.
- Settings stays in sign-in mode after connecting: fold other options behind "Use a different AI…"; "Use no AI" -> "Disconnect".
- Home cards look identical: status chip (Ready / Exported / Paused) + duration; middle-truncate titles.
- Script screen's pink error for "not connected": check before typing; disable "Write my script" with a neutral note "Script help needs an AI editor. Connect one".
- Windows classic scrollbars with arrows: thin custom scrollbars.
- Drawer Close button looks primary because of auto-focus: focus the active tab instead.

## 3. macOS vs Windows conventions
- Title bar: macOS `titleBarStyle: 'hiddenInset'`, sidebar ~52 px top padding, draggable sidebar top + headers. Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay: { color: <paper>, symbolColor: <ink>, height: 40 }`.
- 🔴 macOS needs an application menu with Edit roles or ⌘C/⌘V don't work in text fields (pasting a key fails). Add File › New Video ⌘N, Reel Studio › Settings ⌘,.
- Min window ~1024×700; remember size/position.
- Platform wording: "Show in Finder"/"Dock" on Mac vs "Explorer"/"taskbar" on Windows, switched by platform.
- Whole-window drop target on every screen with a full-window "Drop to make a reel" overlay.
- Keyboard: Esc closes drawer/dialogs; Space play/pause; Enter sends a note, Shift+Enter newline; ⌘/Ctrl+Z undo in the drawer; ⌘/Ctrl+E export; visible focus rings on chips and segmented controls.
- During Working: `win.setProgressBar(p)`; system notification when done; bounce Dock / flash taskbar.

## 4. Working screen
1. Time left, not elapsed: "About 3 minutes left", rounded, from video length × measured speed, recalculated per step; "Almost done" under 20 s.
2. Proof of work: words appear as transcription finishes; "Found 3 retakes, keeping the best one."
3. The raw clip's first frame in the phone frame (same layout as the Reel screen).
4. Bar advances by step weight; slow shimmer on the current segment so it never looks frozen.
5. "You can do something else. I'll let you know when it's ready." backed by the notification + taskbar progress.
6. Stop as a quieter button with a confirm: "Stop making this reel? You can pick up where you left off."

## 5. Reel screen
Next step mostly obvious. Fix: dismissible banner; Done/Optional split; meaningful version chips; on first arrival after Working, auto-play muted with a "Tap for sound" chip. [taste] "Edit it myself" as a quieter text-style button.

## 6. Delight
1. Instagram overlay toggle on the phone frame (faint like/comment column + caption area).
2. Drag the finished reel out of the app (`webContents.startDrag`).
3. Subtitle style swatches as tiny frames with a sample line.
4. Press-and-hold "Original" to play the raw footage (before/after).
5. A finish moment: last check animates, phone slides in, reel starts playing (respect prefers-reduced-motion).

## What's good (keep)
The first-person plain voice; pause/force-quit recovery (18, 20); the no-AI path and the chat's polite fallback; the export dialog copy written for this user.

## Ranked top 15
| # | Change | Est. |
|---|---|---|
| 1 | Toasts auto-dismiss (4 s), clear on screen change, errors inline | 15m |
| 2 | macOS app menu with Edit roles (+ ⌘N, ⌘,) | 10m |
| 3 | accent-color ink; select styled like inputs | 5m |
| 4 | Video poster/controlsList/PiP off/no spinner | 15m |
| 5 | Wording sweep: Subtitles vs Post caption; Paused; Library toast; Extra clips; download size | 20m |
| 6 | Checklist split Done / Optional extras; "Kept your best take · 0:16 long" | 15m |
| 7 | Export dialog: post caption inside, Open Instagram, one-line steps, Finder/Dock wording | 20m |
| 8 | Fixed-width phone column, chips wrap; "Export Version N" | 10m |
| 9 | Version messages/tooltips describe the change | 15m |
| 10 | Working: time left, setProgressBar, notification, new leave copy | 20m |
| 11 | Settings path display; collapse sign-in when connected; "Disconnect" | 10m |
| 12 | Dismissible banner; no-AI placeholder with Connect; taller chat; own message bubble | 15m |
| 13 | Segmented controls to content; transcripts left-aligned, per-take paragraphs | 15m |
| 14 | Lucide icons; thin scrollbars | 15m |
| 15 | Whole-window drop overlay; Esc/Space/Enter shortcuts; Delete in ⋯ menu with confirm | 20m |
