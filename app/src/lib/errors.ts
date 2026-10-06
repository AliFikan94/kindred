/** Turns wallet and contract failures into one calm sentence. Unknown errors are shown shortened, never silently. */
const CONTRACT: Record<string, string> = {
  BadTranche: 'One of the dates or amounts is not allowed. Dates must be in the future, and amounts above zero.',
  BadTrancheCount: 'A schedule needs between 1 and 64 payments.',
  TipUnderfunded: 'The delivery reserve was too small.',
  Underfunded: 'The amount sent does not cover this schedule.',
  FundingExpired: 'The time allowed for funding has passed.',
  FundingNotExpired: 'The funding window is still open.',
  NotCreator: 'Only the person who created this schedule can do that.',
  NotRecipient: 'Only the recipient can do that.',
  NotRevocable: 'This schedule was made permanent, so it cannot be cancelled.',
  NotExecutable: 'Nothing to do yet. It may already be done, or not due.',
  NotUnlocked: 'It has not unlocked yet.',
  AlreadyUnlocked: 'It has already unlocked, so it can no longer be changed.',
  CancelPending: 'A cancellation is already waiting out its 7 days.',
  CancelNotRequested: 'There is no cancellation waiting.',
  TimelockActive: 'The 7-day wait is not over yet.',
  NothingToCancel: 'Everything left has already unlocked, so there is nothing to cancel.',
  GraceNotOver: 'Not yet.',
  InsufficientGas: 'The transaction did not include enough gas. Try again.',
  PayoutFailed: 'The transfer was refused by the receiving address.',
  BadAddress: 'That address is not valid here.',
  ValidatorNotAllowed: 'Growing is not available with that validator.',
  StakedMustBeIrrevocable: 'A growing schedule is permanent: it cannot be cancelled.',
  WrongNativeAmount: 'The amount sent did not match. Please try again.',
  BadFundingWindow: 'The funding window is outside the allowed range.',
  TipTooHigh: 'The delivery reserve is higher than allowed.',
  StakingCallFailed: 'Monad staking declined the request. It may still be activating; try again in a little while.',
  NotStakeable: 'This payment cannot be staked.',
};

export class UserError extends Error {}

function dig(e: unknown): { name?: string; code?: number; msg: string } {
  let cur = e as { cause?: unknown; data?: { errorName?: string }; code?: number; shortMessage?: string; message?: string } | undefined;
  let name: string | undefined;
  let code: number | undefined;
  for (let i = 0; i < 8 && cur; i++) {
    name ??= cur.data?.errorName;
    code ??= typeof cur.code === 'number' ? cur.code : undefined;
    cur = cur.cause as typeof cur;
  }
  const top = e as { shortMessage?: string; message?: string };
  return { name, code, msg: (top?.shortMessage ?? top?.message ?? String(e)).split('\n')[0] ?? 'unknown error' };
}

export function friendlyError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const { name, code, msg } = dig(e);
  if (code === 4001 || /user rejected|user denied/i.test(msg)) return 'You cancelled the request in your wallet.';
  if (name && CONTRACT[name]) return CONTRACT[name]!;
  if (/out of gas|gas required exceeds|exceeds allowance|funds for gas|sender doesn't have enough|insufficient funds/i.test(msg)) {
    return 'There is not enough balance to pay the network fee. If this is a gift link, wait for the delivery or ask the sender to top it up.';
  }
  if (/chain|network/i.test(msg) && /switch|mismatch|wrong/i.test(msg)) return 'Your wallet is on a different network. Please switch and try again.';
  if (/failed to fetch|network request failed|timeout|timed out/i.test(msg)) return 'Could not reach the network. Check your connection and try again.';
  return msg.length > 140 ? msg.slice(0, 137) + '…' : msg;
}
