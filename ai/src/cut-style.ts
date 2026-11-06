export const CUT_STYLES = {
  // These values are lead decisions and have not been tested on Reel Studio output yet.
  // openingMax: the most visible changes the first 5 seconds may hold (engine lint_edit opening-busy); a proposal.
  clean: { secondsPerVisualChange: [6, 10], framingPair: [1, 1.1], jlBridges: 3, smashes: 0, sfxOnCuts: 0, beatAccents: false, extraVisualsFirst5s: false, openingMax: 1 },
  standard: { secondsPerVisualChange: [3, 5], framingPair: [1, 1.15], jlBridges: 3, smashes: 1, sfxOnCuts: 2, beatAccents: false, extraVisualsFirst5s: false, openingMax: 2 },
  hyper: { secondsPerVisualChange: [1.5, 3], framingPair: [1, 1.3], jlBridges: 0, smashes: 2, sfxOnCuts: 8, beatAccents: true, extraVisualsFirst5s: true, openingMax: 4 },
  punchline: { secondsPerVisualChange: null, framingPair: [1, 1.25], jlBridges: 0, smashes: 4, sfxOnCuts: 4, beatAccents: false, extraVisualsFirst5s: false, openingMax: 2 },
} as const;
export type CutPreset = keyof typeof CUT_STYLES;
