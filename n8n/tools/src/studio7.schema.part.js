  // ── v7 schemas (flat; `source` limited to this request's ids; the validators enforce the counts and ranges) ──
  const citesSchema = (desc) => ({
    type: 'array',
    description: desc,
    items: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ids },
        page: { type: 'integer', minimum: 0, maximum: 20000, description: '0 when the source has no page markers' },
      },
      required: ['source', 'page'],
    },
  });
  const figureItem = {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'The number exactly as written in the source, with unit or % sign, max 16 chars' },
      label: { type: 'string', description: 'What it measures, max 60 chars' },
      quote: { type: 'string', description: '4 to 25 consecutive source words that contain the number, copied exactly, max 160 chars' },
      source: { type: 'string', enum: ids },
      page: { type: 'integer', minimum: 0, maximum: 20000, description: '0 when the source has no page markers' },
    },
    required: ['value', 'label', 'quote', 'source', 'page'],
  };
  const igSchema = {
    type: 'object',
    properties: {
      schema: { type: 'string', enum: ['sth.infographic/1'] },
      title: { type: 'string', description: 'Max 80 chars' },
      subtitle: { type: 'string', description: 'Max 140 chars, empty if none' },
      layout: { type: 'string', enum: igLayout === 'auto' ? ['steps', 'comparison', 'facts', 'timeline'] : [igLayout] },
      notices: { type: 'array', description: '0 to 3 short notes, each max 160 chars', items: { type: 'string' } },
      columns: { type: 'array', description: 'comparison only: the two column names, each max 30 chars; otherwise an empty array', items: { type: 'string' } },
      items: {
        type: 'array',
        minItems: 3,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'Max 50 chars' },
            text: { type: 'string', description: 'One short phrase or sentence, max 160 chars' },
            when: { type: 'string', description: 'timeline only: the date or period as in the sources, max 24 chars; otherwise empty' },
            left: { type: 'string', description: 'comparison only, max 100 chars; otherwise empty' },
            right: { type: 'string', description: 'comparison only, max 100 chars; otherwise empty' },
            icon: { type: 'string', enum: ['book', 'brain', 'bulb', 'target', 'check', 'warning', 'clock', 'calendar', 'chart-up', 'chart-down', 'people', 'person', 'globe', 'flask', 'atom', 'dna', 'heart', 'leaf', 'money', 'scale', 'gavel', 'building', 'gear', 'link', 'shield', 'question', 'star', 'flag', 'arrow', 'compare', 'document', 'pin'] },
            cites: citesSchema('1 or 2 citations'),
          },
          required: ['heading', 'text', 'when', 'left', 'right', 'icon', 'cites'],
        },
      },
      figures: { type: 'array', maxItems: 4, description: '0 to 4 numbers that appear in the sources', items: figureItem },
      takeaway: { type: 'string', description: 'One sentence, max 160 chars' },
    },
    required: ['schema', 'title', 'subtitle', 'layout', 'notices', 'columns', 'items', 'figures', 'takeaway'],
  };
  const slSchema = {
    type: 'object',
    properties: {
      schema: { type: 'string', enum: ['sth.slides/1'] },
      title: { type: 'string', description: 'Max 80 chars' },
      subtitle: { type: 'string', description: 'Max 120 chars' },
      notices: { type: 'array', description: '0 to 3 short notes, each max 160 chars', items: { type: 'string' } },
      slides: {
        type: 'array',
        minItems: 3,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'p1, p2, p3 ...' },
            layout: { type: 'string', enum: ['title', 'agenda', 'section', 'bullets', 'two_column', 'definition', 'timeline', 'quote', 'summary', 'check'] },
            title: { type: 'string', description: 'Max 80 chars' },
            subtitle: { type: 'string', description: 'Max 120 chars, empty if none' },
            bullets: {
              type: 'array',
              maxItems: 7,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Detailed: max 160 chars; presenter: max 70 chars' },
                  level: { type: 'integer', minimum: 0, maximum: 1 },
                },
                required: ['text', 'level'],
              },
            },
            columns: {
              type: 'array',
              maxItems: 2,
              items: {
                type: 'object',
                properties: { heading: { type: 'string', description: 'Max 50 chars' }, bullets: { type: 'array', maxItems: 6, items: { type: 'string' } } },
                required: ['heading', 'bullets'],
              },
            },
            quote: { type: 'string', description: 'quote layout only: exact words from the source, max 240 chars' },
            notes: { type: 'string', description: 'Speaker notes. Presenter: full talking points, max 900 chars. Detailed: max 300 chars, may be empty' },
            cites: citesSchema('0 to 3 citations'),
          },
          required: ['id', 'layout', 'title', 'subtitle', 'bullets', 'columns', 'quote', 'notes', 'cites'],
        },
      },
    },
    required: ['schema', 'title', 'subtitle', 'notices', 'slides'],
  };
  const dgSchema = {
    type: 'object',
    properties: {
      schema: { type: 'string', enum: ['sth.digest/1'] },
      topics: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'The heading of the source, max 100 chars' },
            level: { type: 'integer', minimum: 1, maximum: 3 },
            points: {
              type: 'array',
              minItems: 1,
              maxItems: 15,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'One self-contained sentence, max 200 chars' },
                  source: { type: 'string', enum: ids },
                  page: { type: 'integer', minimum: 0, maximum: 20000, description: '0 when the source has no page markers' },
                },
                required: ['text', 'source', 'page'],
              },
            },
          },
          required: ['heading', 'level', 'points'],
        },
      },
      figures: { type: 'array', maxItems: 20, items: figureItem },
    },
    required: ['schema', 'topics', 'figures'],
  };
