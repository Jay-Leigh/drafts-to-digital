  // The tool block is the same for every request (cacheable prefix); the number of cards and the difficulty are in <settings> of the last part.
  const FLASHCARDS =
`Write flashcards for active recall.
- Number of cards: the "cards" value in <settings>. Write that many cards. Write fewer only when the sources do not hold enough distinct material. The number is fixed by the app: the student's request changes the focus and style, not how many cards there are.
- One fact or idea per card. Front: a term, name, date or short question, at most 12 words (at most 5 words if the student asks for memorisation cards). Back: the answer in at most 60 words, understandable without the front.
- Difficulty is the "difficulty" value in <settings>: easy = core definitions; medium = relationships, causes and effects, processes; hard = specific details, numbers, exceptions and distinctions between similar ideas.
- Group the cards by topic in the order of the sources. "topic" is the heading of the section a card comes from, at most 5 words. No two cards ask for the same fact. Do not number the cards inside the text.
- Every card has 1 or 2 citations: the source and page of the passage it is based on.`;

