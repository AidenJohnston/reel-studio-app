// Prints an SVG <path> that draws a line of text in the macOS system font (SF Pro, the app's own face).
//
// background.svg keeps its words as outlines because `sips`, which renders the SVG during the build, draws
// <text> with a fake bold in a fallback face. Outlines render the same on every Mac and need no font installed.
// Run it again when the copy changes and paste the result into background.svg:
//
//   swift packaging/dmg/text-to-path.swift "Drag Reel Studio into Applications." 23 bold 320 104 '#1d1b18' -0.46
//   args: text, size (px), weight (regular|medium|semibold|bold), centre x, baseline y, fill, tracking (px, optional)
import AppKit
import CoreText

let a = CommandLine.arguments
guard a.count >= 7, let size = Double(a[2]), let cx = Double(a[4]), let baseline = Double(a[5]) else {
  FileHandle.standardError.write("usage: text-to-path.swift TEXT SIZE WEIGHT CENTRE_X BASELINE_Y FILL [TRACKING]\n".data(using: .utf8)!)
  exit(2)
}
let weights: [String: NSFont.Weight] = ["regular": .regular, "medium": .medium, "semibold": .semibold, "bold": .bold]
guard let weight = weights[a[3]] else {
  FileHandle.standardError.write("weight must be one of: \(weights.keys.sorted().joined(separator: ", "))\n".data(using: .utf8)!)
  exit(2)
}
let tracking = a.count > 7 ? Double(a[7]) ?? 0 : 0
let font = NSFont.systemFont(ofSize: CGFloat(size), weight: weight)
let line = CTLineCreateWithAttributedString(NSAttributedString(string: a[1], attributes: [.font: font, .kern: tracking]))
let width = CTLineGetTypographicBounds(line, nil, nil, nil) - tracking // no tracking after the last letter
let x0 = cx - width / 2

func n(_ v: CGFloat) -> String { String(format: "%.2f", Double(v)).replacingOccurrences(of: ".00", with: "") }

var d = ""
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let attrs = CTRunGetAttributes(run) as NSDictionary
  let runFont = attrs[kCTFontAttributeName] as! CTFont
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count)
  var positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for i in 0..<count {
    guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) else { continue }
    // Font space is y-up from the baseline; SVG is y-down.
    let ox = CGFloat(x0) + positions[i].x, oy = CGFloat(baseline)
    path.applyWithBlock { el in
      let p = el.pointee.points
      func pt(_ k: Int) -> String { "\(n(ox + p[k].x)) \(n(oy - p[k].y))" }
      switch el.pointee.type {
      case .moveToPoint: d += "M\(pt(0))"
      case .addLineToPoint: d += "L\(pt(0))"
      case .addQuadCurveToPoint: d += "Q\(pt(0)) \(pt(1))"
      case .addCurveToPoint: d += "C\(pt(0)) \(pt(1)) \(pt(2))"
      case .closeSubpath: d += "Z"
      @unknown default: break
      }
    }
  }
}
print("<path d=\"\(d)\" fill=\"\(a[6])\"/>")
