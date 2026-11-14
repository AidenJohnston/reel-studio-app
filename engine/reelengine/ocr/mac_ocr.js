// Reads the text in pictures with the text recognition built into macOS (Vision), for mirror_detect.py.
// Usage: osascript -l JavaScript mac_ocr.js <picture>...
// Prints one JSON line per picture: {"i": <index>, "lines": ["...", ...]} (or "error").
// Language correction is OFF on purpose: it would turn backwards letters into real-looking words.
ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  var out = [];
  for (var i = 0; i < argv.length; i++) {
    try {
      var req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = 0;              // accurate
      req.usesLanguageCorrection = false;
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[i]), $({}));
      var ok = handler.performRequestsError($([req]), null);
      var lines = [];
      var res = req.results;
      if (ok && res) {
        for (var k = 0; k < res.count; k++) {
          var cands = res.objectAtIndex(k).topCandidates(1);
          if (cands.count) lines.push(cands.objectAtIndex(0).string.js);
        }
      }
      out.push(JSON.stringify(ok ? { i: i, lines: lines } : { i: i, error: 'vision failed' }));
    } catch (e) {
      out.push(JSON.stringify({ i: i, error: String(e) }));
    }
  }
  return out.join('\n');
}
