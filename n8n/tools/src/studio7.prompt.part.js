  // v7 tool blocks: the same for every request of a tool (cacheable prefix); layout, format, length and the part are in <settings> of the last part.
  const INFOGRAPHIC =
`Plan a one-page study infographic. The app draws it; you choose the content, the layout and an icon for each item.
- Layout: the "layout" value in <settings>. If it is "auto", choose "timeline" for a dated sequence, "comparison" for a two-sided contrast, "steps" for a process, otherwise "facts". Any other value is the student's choice: use exactly that layout.
- Items: 3 to 8 (timeline: up to 10), in reading order. "heading" is a short label and "text" one short phrase or sentence. Short phrases, not paragraphs.
- timeline: every item has "when", the date or period exactly as the sources give it. comparison: "columns" holds the two side names and every item has "left" and "right"; "text" is a one-line summary. Other layouts: "when", "left" and "right" are empty strings and "columns" is an empty array.
- "icon" is one of the ids allowed by the schema; choose the one that fits the item best.
- "figures" (0 to 4): only numbers that appear in the sources. "value" is the number exactly as written there (with its unit or % sign), "label" says what it measures, "quote" is the 4 to 25 consecutive source words that contain the number, copied exactly. Leave "figures" empty rather than invent, round or convert a number.
- Do not write a number in any other field unless the sources state it.
- Every item cites 1 or 2 passages (source and page). "takeaway" is one sentence with the main message.`;
  const SLIDES =
`Write a slide deck from the sources.
- Format: the "format" value in <settings>. "detailed" = complete sentences that read on their own, up to 7 points per slide, short optional notes (at most 300 characters). "presenter" = 3 to 5 short points (at most 70 characters each) with the full talking points in "notes" (at most 900 characters).
- Length: the "length" value in <settings>. "short" = 6 to 8 slides; "default" = 10 to 15 slides. Never more than 20.
- Structure: slide 1 uses layout "title". For default length slide 2 is an "agenda". Before each major theme add a "section" slide (default length only). Content slides use "bullets"; "two_column" for comparisons (2 columns); "definition" for a key term (the title is the term, the bullets define it); "timeline" (each bullet starts with its date); "quote" (the exact words from the source, 4 to 40 words). End with one "summary" slide and one "check" slide with 3 review questions as bullets (the answers in its notes).
- Fields a layout does not use are empty ("" or []). A bullet has "level" 0 (main point) or 1 (sub-point).
- Do not write a number unless a source states it. Every content slide cites the passages (source and page) it draws on.`;
  const DIGEST =
`Write a study digest of one part of the sources. The digests of all parts are combined later into one study aid, so keep what a study aid needs and nothing else.
- This is the part given as "part" in <settings>. Do not write an introduction or a conclusion for the whole.
- "topics": follow the headings and numbering the sources use. "level" 1 = chapter or theme, 2 = unit, 3 = section. Each topic has 1 to 15 "points": one self-contained sentence each (at most 200 characters) with the source and the page where it is stated.
- Copy every number exactly as written. Do not round or convert.
- "figures" (0 to 20): the most important numbers of this part. "value" exactly as written (with its unit or % sign), "label" what it measures, "quote" the 4 to 25 consecutive source words that contain it, copied exactly, with source and page.`;
  // reduce run (one extra sentence in the system instruction): the material is the digests of the parts, not the sources themselves
  const REDUCE = 'The material below is a digest of the sources, made in parts (one <digest part="n"> block per part), not the sources themselves. Treat it as the sources: use only what it states, keep its citations (source and page) exactly as they appear, and use only the figures listed in the digests, each with its exact quote.';
