  // ── schema sth.quiz/1 (flat list; `source` limited to this request's ids; no min/max on the nested options and citations, the validator enforces them) ──
  const qzSchema = {
    type: 'object',
    properties: {
      schema: { type: 'string', enum: ['sth.quiz/1'] },
      title: { type: 'string', description: 'Title of the quiz, max 80 chars' },
      notices: { type: 'array', description: '0 to 3 short notes, each max 160 chars', items: { type: 'string' } },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'q1, q2, q3 ... unique' },
            topic: { type: 'string', description: 'Topic heading from the sources, max 40 chars' },
            type: { type: 'string', enum: ['mcq', 'true_false'] },
            stem: { type: 'string', description: 'The question or statement, max 300 chars' },
            options: {
              type: 'array',
              description: 'mcq: exactly 4 options A-D. true_false: exactly 2 options, A is True and B is False',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                  text: { type: 'string', description: 'Max 160 chars' },
                  rationale: { type: 'string', description: 'One short sentence: why this option is right or wrong, max 200 chars' },
                },
                required: ['id', 'text', 'rationale'],
              },
            },
            answer: { type: 'string', enum: ['A', 'B', 'C', 'D'], description: 'Id of the one correct option' },
            hint: { type: 'string', description: 'A nudge that does not reveal the answer, max 200 chars' },
            explanation: { type: 'string', description: 'Why the correct answer is right, max 500 chars' },
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
          required: ['id', 'topic', 'type', 'stem', 'options', 'answer', 'hint', 'explanation', 'cites'],
        },
      },
    },
    required: ['schema', 'title', 'questions'],
  };
