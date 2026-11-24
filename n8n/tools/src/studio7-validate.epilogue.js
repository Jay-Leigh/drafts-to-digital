// Study Studio (mind map, flashcards, quiz and from v7 infographic, slides, digest), step 5: turn the final Gemini result into the response (or a clean error code).
// Never throws: any unexpected problem becomes STH-STU-422 without text from the request or the model.
const res = $input.first().json || {};
let out;
try {
  const req = $('Studio - Validate Request').first().json;
  out = studioReply(res, {
    sources: req.sourceMeta, promptVersion: req.promptVersion, tool: req.tool, count: req.count,
    strategy: req.strategy, part: req.part, layout: req.layout, format: req.format, verify: req.verify,
    citeSet: Array.isArray(req.citeSet) ? new Set(req.citeSet) : null, worstUnits: req.worstUnits,
  });
} catch (e) {
  out = { response: studioFail('STH-STU-422', 'internal'), meterUnits: 0 };
}
return [{ json: { response: out.response, meterUnits: out.meterUnits } }];
