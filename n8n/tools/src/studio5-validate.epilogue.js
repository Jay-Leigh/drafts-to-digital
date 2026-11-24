// Study Studio (mind map and flashcards), step 5: turn the final Gemini result into the response (or a clean error code).
// Never throws: any unexpected problem becomes STH-STU-422 without text from the request or the model.
const res = $input.first().json || {};
let out;
try {
  const req = $('Studio - Validate Request').first().json;
  out = studioReply(res, { sources: req.sourceMeta, promptVersion: req.promptVersion, tool: req.tool, count: req.count });
} catch (e) {
  out = { response: studioFail('STH-STU-422', 'internal'), meterUnits: 0 };
}
return [{ json: { response: out.response, meterUnits: out.meterUnits } }];
