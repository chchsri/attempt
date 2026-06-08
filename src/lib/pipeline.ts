import { extractJson } from "./extract-json";
import {
  mockStream,
  type MockBehavior,
  type MockState,
  type TransientError,
} from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
}

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
}

export const MAX_REVISIONS = 3;

// Maximum times we will call the streaming API before giving up.
const MAX_STREAM_ATTEMPTS = 5;

/**
 * Returns true for errors that are safe to retry:
 *   - 429 rate-limit (transient server pressure)
 *   - missing JSON fence (stream was cut off mid-response)
 */
function isRetryableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as TransientError).status === 429) return true;
  if (err.message === "No fenced JSON block found") return true;
  return false;
}

/**
 * Calls the streaming client and validates the JSON fence.
 * Retries transparently on transient 429s and truncated streams.
 * Returns the raw response text on success, or null if all attempts fail.
 */
async function fetchDraft(
  behavior: MockBehavior,
  state: MockState,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    try {
      const raw = await mockStream(behavior, state);
      extractJson(raw); // throws "No fenced JSON block found" on truncation
      return raw;
    } catch (err) {
      const isLastAttempt = attempt === MAX_STREAM_ATTEMPTS - 1;
      if (!isRetryableStreamError(err) || isLastAttempt) return null;
    }
  }
  return null;
}

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  const draft = await fetchDraft(input.behavior, state);
  if (draft === null) {
    return { status: "error", attempts: 0 };
  }

  // Revise until the draft passes review, capped at MAX_REVISIONS iterations.
  let attempt = 0;
  while (!input.reviewPasses(attempt) && attempt < MAX_REVISIONS) {
    attempt += 1;
  }

  // If the revision cap was hit without passing, the run has failed.
  if (!input.reviewPasses(attempt)) {
    return { status: "error", attempts: attempt };
  }

  // Hand off to the next stage; a failure here is a pipeline failure.
  try {
    await input.advanceToNextStage();
  } catch {
    return { status: "error", attempts: attempt };
  }

  return { status: "ok", attempts: attempt };
}
