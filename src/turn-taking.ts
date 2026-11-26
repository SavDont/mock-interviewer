// End-of-turn detection: how long to wait after the candidate stops talking before the interviewer
// may respond. Silence alone is a poor signal when someone is thinking aloud, so the wording matters.

const UNFINISHED_PAUSE = 2600; // after "…and the cache", give them time to finish the thought
const QUESTION_PAUSE = 400; // they asked something: answer promptly

// Words people trail off on mid-thought ("so the write path goes to, um…").
const DANGLING =
  /(?:\b(?:and|but|or|so|because|cause|then|if|when|which|that|where|like|with|to|of|for|from|in|on|into|the|a|an|my|our|we|i|is|are|was|would|will|could|should|can|um|uh|uhm|erm|hmm|basically|maybe|probably|let's|let me)|,|…|\.\.\.|-)$/i;

// Short check-ins that want a reply even when speech-to-text drops the question mark ("Cool.").
const CHECK_IN =
  /^(?:(?:so|okay|ok|and|um|uh),?\s+)?(?:cool|okay|ok|right|yeah|sound(?:s)? good|make(?:s)? sense|does that (?:make sense|work|sound good)|is that (?:ok|okay|fine|good)|can i move on|good|alright|all right)[.!]?$/i;

/**
 * How long to wait after a transcribed segment before the interviewer may respond. Silence
 * alone is a poor end-of-turn signal when someone is thinking aloud, so the wording matters too.
 */
export function turnPauseMs(text: string, base: number): number {
  const t = text.trim().replace(/["')\]]+$/, "");
  if (/\?$/.test(t) || CHECK_IN.test(t)) return Math.min(base, QUESTION_PAUSE);
  // (Not "no final punctuation": the browser recognizer never punctuates.)
  if (DANGLING.test(t.replace(/[.!]$/, ""))) return Math.max(base, UNFINISHED_PAUSE);
  return base;
}
