  // ── schema sth.flashcards/1 (flat list; `source` limited to this request's ids; no min/max on the nested citations, the validator enforces them) ──
  const fcSchema = {
    type: 'object',
    properties: {
      schema: { type: 'string', enum: ['sth.flashcards/1'] },
      title: { type: 'string', description: 'Title of the deck, max 80 chars' },
      notices: { type: 'array', description: '0 to 3 short notes, each max 160 chars', items: { type: 'string' } },
      cards: {
        type: 'array',
        minItems: 1,
        maxItems: 80,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'c1, c2, c3 ... unique' },
            topic: { type: 'string', description: 'Topic heading from the sources, max 40 chars' },
            front: { type: 'string', description: 'Term, name, date or short question, max 160 chars' },
            back: { type: 'string', description: 'Answer, max 500 chars, understandable without the front' },
            cites: {
              type: 'array',
              description: '1 or 2 citations',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string', enum: ids },
                  page: { type: 'integer', minimum: 0, maximum: 20000, description: '0 when the source has no page markers' },
                },
                required: ['source', 'page'],
              },
            },
          },
          required: ['id', 'topic', 'front', 'back', 'cites'],
        },
      },
    },
    required: ['schema', 'title', 'cards'],
  };
  const schema = tool === 'flashcards' ? fcSchema : mindmapSchema;
