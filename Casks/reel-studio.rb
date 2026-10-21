cask "reel-studio" do
  version "0.1.2"
  sha256 "a815af918e5777a63eb059e3c37778c95d4c80de25312219a162507a60f11102"

  url "https://github.com/AidenJohnston/reel-studio-app/releases/download/v#{version}/Reel-Studio-#{version}-arm64.dmg"
  name "Reel Studio"
  desc "Turn a raw talking-head video into a finished Reel"
  homepage "https://github.com/AidenJohnston/reel-studio-app"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Reel Studio.app"

  # Leaves ~/Documents/Reel Studio alone: that folder holds the user's videos, music and exports.
  zap trash: [
    "~/Library/Application Support/Reel Studio",
    "~/Library/Preferences/dev.reelstudio.app.plist",
    "~/Library/Saved Application State/dev.reelstudio.app.savedState",
  ]
end
