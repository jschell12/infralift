// ---------------------------------------------------------------------------
// A daily cap on the scanner's LLM spend.
//
// The community scanner (scanner/index.ts) sends every new post it scrapes to
// a small Claude model (scanner/classify.ts). A source that suddenly returns
// thousands of posts, or a loop that never sees a post as "already indexed",
// would otherwise spend without limit. LlmBudget counts tokens per UTC day
// and refuses a call that would pass the cap, with LlmBudgetExceeded, which
// the scanner treats as "stop classifying for today".
//
// The cap is global, not per org: the scanner runs for infralift itself
// (admin-only /communities pages), and no customer action can start it.
// Nothing else in the API calls an LLM.
//
// Knob: SCANNER_LLM_DAILY_TOKENS (default DEFAULT_DAILY_TOKEN_CAP). At Claude
// Haiku 4.5's list price ($1 per million input tokens, $5 per million output)
// the default is well under a dollar a day.
//
// Strategy pattern: where the day's count is kept is an LlmUsageStore. The
// only one is in memory, which is enough because the scanner is one process
// run once a day (24-hour lookback). Two runs on one day would each get the
// full cap; a store in Postgres implementing the same two methods fixes that
// without changing a caller.
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_TOKEN_CAP = 200_000;

export interface LlmUsageStore {
  usedOn(day: string): Promise<number>;
  add(day: string, tokens: number): Promise<void>;
}

export function createMemoryUsageStore(): LlmUsageStore {
  const used = new Map<string, number>();
  return {
    async usedOn(day) {
      return used.get(day) ?? 0;
    },
    async add(day, tokens) {
      used.set(day, (used.get(day) ?? 0) + tokens);
    },
  };
}

export class LlmBudgetExceeded extends Error {
  constructor(
    readonly day: string,
    readonly used: number,
    readonly cap: number
  ) {
    super(
      `The scanner's LLM budget for ${day} is spent (${used} of ${cap} tokens). ` +
        `Classification stops until tomorrow (UTC); raise SCANNER_LLM_DAILY_TOKENS to allow more.`
    );
    this.name = "LlmBudgetExceeded";
  }
}

/** The cap from SCANNER_LLM_DAILY_TOKENS, or the default when unset. A value
 *  that is not a positive whole number stops the scanner rather than running
 *  without a cap. */
export function dailyTokenCapFromEnv(value = process.env.SCANNER_LLM_DAILY_TOKENS): number {
  if (value === undefined || value === "") return DEFAULT_DAILY_TOKEN_CAP;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`SCANNER_LLM_DAILY_TOKENS must be a positive whole number, not ${JSON.stringify(value)}`);
  }
  return n;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Rough token count for text: about four characters a token for English.
 *  Used only to refuse a call before it is made; the real count comes back on
 *  the response and is what is recorded. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class LlmBudget {
  constructor(
    readonly dailyTokenCap: number,
    private readonly store: LlmUsageStore = createMemoryUsageStore(),
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** Throws LlmBudgetExceeded when a call of about `estimatedTokens` would
   *  pass today's cap. */
  async assertRoomFor(estimatedTokens: number): Promise<void> {
    const day = utcDay(this.clock());
    const used = await this.store.usedOn(day);
    if (used + estimatedTokens > this.dailyTokenCap) throw new LlmBudgetExceeded(day, used, this.dailyTokenCap);
  }

  /** Records what a call actually used, from the response's usage. */
  async record(tokens: number): Promise<void> {
    if (tokens > 0) await this.store.add(utcDay(this.clock()), tokens);
  }

  async usedToday(): Promise<number> {
    return this.store.usedOn(utcDay(this.clock()));
  }
}
