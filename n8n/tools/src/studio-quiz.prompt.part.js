  // The tool block is the same for every request (cacheable prefix); the number of questions and the difficulty are in <settings> of the last part.
  const QUIZ =
`Write a quiz that checks understanding of the sources.
- Number of questions: the "questions" value in <settings>. Write that many questions. Write fewer only when the sources do not hold enough distinct material. The number is fixed by the app: the student's request changes the focus and style, not how many questions there are.
- Types: about 80% "mcq" with exactly 4 options (ids A, B, C, D) and exactly one correct; about 20% "true_false" with exactly 2 options: A is "True" and B is "False" (written in the language of the quiz). A true_false stem is a statement, not a question.
- "answer" is the id of the one correct option. Vary which position is correct.
- Difficulty is the "difficulty" value in <settings>: easy = recall of definitions and facts stated directly; medium = understanding and application (why, which example fits, compare two ideas); hard = analysis that combines points from different parts of the material, with close distractors.
- Distractors: plausible, taken from the same material (other terms, dates, people), of the same length and grammar as the correct option. Never use "all of the above", "none of the above" or "both A and B". Avoid negative stems; if unavoidable, write NOT in capitals. The stem must not give the answer away.
- Spread the questions across the topics in proportion to how much the sources say about them, in the order of the sources. "topic" is the heading of the section a question comes from, at most 5 words. No two questions test the same fact.
- Every option has a rationale of one short sentence: why it is right or wrong. The explanation says why the answer is right and points to the material. The hint helps without revealing the answer and without repeating the correct option.
- Every question has 1 or 2 citations: the source and page of the passage that makes the correct answer correct.`;
