# Installing Reel Studio on Windows

This takes about two minutes. You do not need to be an administrator, and nothing else needs to be installed first.

**What you need:** Windows 10 or 11 (64-bit), about 2 GB of free space, and an internet connection the first time you open the app.

## 1. Download

Download the file called **Reel-Studio-Setup-1.0.0-x64.exe** (the numbers may be a little different). It usually lands in your **Downloads** folder.

## 2. Open it

Double-click the file.

### If Windows shows a blue box saying "Windows protected your PC"

Don't worry, this is normal, and it does not mean something is wrong with the file.

Windows shows this box for any program from a small, new publisher that hasn't paid Microsoft for a "known publisher" stamp yet. Reel Studio is exactly that. You can still install it:

1. Click the small words **More info** (in the middle of the box, under the message).
2. A new button appears at the bottom. Click **Run anyway**.

That's it. You only have to do this once.

### If your browser says "this file isn't commonly downloaded"

In Edge or Chrome, click the three dots next to the download, then **Keep**, then **Keep anyway**. Then open the file as above.

## 3. Wait a minute

A small window shows the install progress. When it finishes, Reel Studio opens by itself and puts an icon on your desktop and in the Start menu.

## 4. First time you open it

Reel Studio downloads its speech helper once (this is how it "listens" to your video). Keep the window open until the bar finishes. It only happens this once, and after that Reel Studio works without internet for everything except finding images and music online.

## Where things go

* The app itself: `C:\Users\<you>\AppData\Local\Programs\reel-studio` (the folder name is lower case with a hyphen; the Start menu and desktop shortcuts are called **Reel Studio**)
* Your videos, music and exports: **Documents > Reel Studio** (open it any time, the folders have plain names)

## Updating to a newer version

Reel Studio does not update itself yet, but it tells you when a new version is out: a small note at the bottom left says
**Reel Studio 0.1.1 is out.** (with the new number) and **Download** opens the download page in your browser. You can also open
**Settings** and click **Check for a newer version** any time. When a new version is out, download the new **Reel-Studio-Setup-...exe** from the
same page you got the first one from (the version number is in the file name, so you can see whether it is newer than the
one you have), and run it the same way. It installs over the old copy and your videos, music and settings are untouched.
Only download it from that page: the app is not signed with a paid certificate yet, so Windows cannot vouch for a file
that came from anywhere else.

## Removing it

Open **Settings > Apps > Installed apps**, find **Reel Studio**, click the three dots, then **Uninstall**. Your **Documents > Reel Studio** folder is left alone, so you never lose your videos by accident.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Run anyway" never appears | Click **More info** first. The button only shows up after that. |
| The installer vanished after downloading | Your antivirus moved it. Open your antivirus, look for "quarantine" or "protection history", and choose **Restore**. Then try again. |
| "Not enough disk space" | Free up 2 GB (empty the Recycle Bin, delete old downloads) and run the installer again. |
| The first-time download stops | Check your internet, close Reel Studio, and open it again. It carries on where it stopped. |
| Anything else | Restart the computer, install again. Your videos are never touched by installing. |
