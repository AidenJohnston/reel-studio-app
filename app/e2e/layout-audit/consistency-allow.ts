// The design scale the consistency audit holds the screens to (styles.css :root has the same numbers as tokens), and
// the accepted exceptions. Every exception names the element and why it is deliberate; none covers a whole screen.
import type { ConsistencyAllow, ConsistencyScale } from './consistency'

export const SCALE: ConsistencyScale = {
  // a 4 px grid, with 1, 2 and 6 for hairline insets and the tightest pairs (an icon and its label)
  space: [1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64],
  font: [11, 12, 13, 14, 15, 18, 20, 22, 28, 40, 48],
  leading: { '11': 14, '12': 16, '13': 18, '14': 20, '15': 20, '18': 24, '20': 26, '22': 28, '28': 34, '40': 44, '48': 52 },
  radius: [4, 6, 8, 10, 12, 14, 16, 20],
  control: [24, 28, 32, 36, 44],
  // 8 and 10 are glyphs inside a status dot (a step's check, a version mark on the timeline)
  icon: [8, 10, 12, 14, 16, 18, 20, 24]
}

export const CONSISTENCY_ALLOW: (ConsistencyAllow & { scenes?: string[]; reason: string })[] = [
  {
    rule: 'off-scale',
    selector: '[data-testid="ig-overlay"]',
    reason: "Instagram's own screen, drawn at the phone's scale (Phone.css sizes it in cqw from a 393 pt iPhone), so its type, icons and gaps are Instagram's measurements times the phone's size, not the app's scale."
  },
  {
    rule: 'edge-near-miss',
    selector: '[data-testid="ig-overlay"]',
    reason: "Instagram's own layout inside the phone (the handle, caption and tab bar sit where Instagram puts them)."
  },
  {
    rule: 'off-scale',
    selector: '.phone, [data-testid="sample-phone"]',
    props: ['border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    reason: "The phone's body: its corners and bezel are a real iPhone's, measured in mm and scaled to the phone's width (Phone.tsx faceIdWidthMm)."
  },
  {
    rule: 'off-scale',
    selector: '.planned:not(.with-plan) [data-testid="drop-zone"]',
    props: ['border-radius'],
    reason: "A new reel's drop zone is the phone's slot: it takes the phone body's corners (Phone.css .phone), so the phone that replaces it lands in the same shape."
  },
  {
    rule: 'off-scale',
    selector: '.tb-main',
    props: ['padding-right'],
    reason: "The page's gutter plus its scroll bar's (--gutter + --sbw, shell.css): the title bar's actions end where the page's content does, beside the scroll bar the page always keeps room for."
  },
  {
    rule: 'off-scale',
    selector: '.tb-side',
    props: ['padding-left'],
    reason: "Room for the macOS traffic lights (shared/chrome.ts): the system draws them there, at its own position."
  },
  {
    rule: 'off-scale',
    selector: '#sidebar, main.main, .fr-stage, .fr-welcome',
    props: ['padding-top', 'margin-top'],
    reason: "The title-bar row's height (52 px, shared/chrome.ts, measured from T3 Code's row so the traffic lights centre on it): what sits under the row starts there."
  },
  {
    rule: 'off-scale',
    selector: '.fr-log-in',
    props: ['margin-bottom'],
    reason: 'margin-bottom: auto (first-run.css): the sample\'s log sits at the top of its column and the steps at its foot; the used length is whatever room is left.'
  },
  {
    rule: 'off-scale',
    selector: '.pl-who, .steps li .sr',
    props: ['margin-left'],
    reason: 'margin-left: auto pushes these to the end of their row (plan.css .pl-who, reel.css .steps li .sr); the used length is the room left.'
  },
  {
    rule: 'off-scale',
    selector: '[data-testid="sample-card"] .cover-t',
    reason: "The sample reel's cover words, drawn at the card's scale (home.css .cover-t sizes them from the card's width), as the engine draws them on the cover."
  },
  {
    rule: 'stack-axis',
    selector: 'section.stage',
    reason: "The timeline's box starts after its 24 px lane gutter, which it draws to its left (reel.css .tl-gutter): gutter included, it spans the phone's width exactly, as the transport row does."
  },
  {
    rule: 'off-scale',
    selector: '.sub-sample, .fr-subs',
    reason: "A subtitle drawn in the engine's own size and face over the phone, so the preview matches the export (styles.css .sub-sample)."
  }
]
