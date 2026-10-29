# Installing Reel Studio on a Mac

This takes about two minutes. Nothing else needs to be installed first.

**What you need:** a Mac with an Apple chip (M1, M2, M3, M4 or newer) running macOS 14 (Sonoma) or newer, about 2 GB of free space, and an internet connection the first time you open the app.

**Not sure which chip you have?** Click the Apple logo at the top left, then **About This Mac**. If it says **Chip: Apple M...** you're fine. If it says "Intel", Reel Studio doesn't work on that Mac yet.

## 1. Download

Download **Reel-Studio-0.1.1-arm64.dmg** (the numbers may be a little different). It lands in your **Downloads** folder.

## 2. Put the app in Applications

1. Double-click the downloaded file. A window opens showing the Reel Studio icon and an **Applications** folder.
2. Drag the **Reel Studio** icon onto the **Applications** folder.
3. When it finishes copying, close that window. Then drag the little disk called **Reel Studio** on your desktop to the Trash (this "ejects" it).

## 3. Open it the first time

Open **Applications** and double-click **Reel Studio**.

From version 0.1.1 on, the Mac app is **notarized**: checked and stamped by Apple. It just opens, and you can skip
the rest of this step. (macOS may ask "Are you sure you want to open it?" the first time; click **Open**.)

### Only version 0.1.0: if a message says "Reel Studio can't be opened" or "Apple could not verify..."

Version 0.1.0 was not notarized yet. This message does not mean something is wrong. You can still open it:

1. Click **Done** (don't click "Move to Trash").
2. Click the Apple logo, then **System Settings**.
3. In the list on the left click **Privacy & Security**.
4. Scroll down until you see the line **"Reel Studio" was blocked to protect your Mac**. Click **Open Anyway** next to it.
5. Type your Mac password (or use Touch ID) and click **Open**.

You only do this once. After that Reel Studio opens like any other app. (Holding Control and clicking the icon no longer
works on current macOS; use the steps above.)

## 4. First time you open it

Reel Studio downloads its speech helper once (this is how it "listens" to your video). Keep the window open until the bar finishes. After that, everything works without internet except finding images and music online.

## Where things go

* The app: **Applications > Reel Studio**
* Your videos, music and exports: **Documents > Reel Studio** (open it any time in Finder, the folders have plain names)

## Updating to a newer version

When a new version is out, click **Download update** at the bottom left. When it finishes, click
**Restart to update** and confirm. Reel Studio closes and opens on the new version. Your videos and settings stay.
You can also check from **Settings**, or use the **Reel Studio > Check for Updates** menu.

Older versions, and copies outside Applications, open the release page instead. Download the new
**Reel-Studio-...-arm64.dmg**, drag **Reel Studio** onto **Applications** and choose **Replace**.

## Removing it

Drag **Reel Studio** from **Applications** to the Trash. Your **Documents > Reel Studio** folder is left alone, so you never lose your videos by accident.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Open Anyway" isn't in Privacy & Security | You need to try opening the app once first (step 3). The button shows up for about an hour after that. |
| "Reel Studio is damaged and can't be opened" | This is the same Mac safety check, worded more harshly, and **downloading the file again does not help** (your Mac marks every download the same way). It happens when the app was copied out of the disk image in a way that broke its seal, or with a 0.1.0 build whose seal was damaged. First make sure you dragged the app out of the **.dmg** you downloaded (do not unzip it or copy it from another Mac). Then, only on version 0.1.0, open **Terminal** (Spotlight: type Terminal) and paste exactly this line, press Return, and open the app again: `xattr -dr com.apple.quarantine "/Applications/Reel Studio.app"`. A notarized release never shows this message; if one does, the download is damaged, so download it again from the release page. |
| "Not enough disk space" | Free up 2 GB, then try again. |
| The first-time download stops | Check your internet, quit Reel Studio (Command-Q), and open it again. It carries on where it stopped. |
