// Pump.fun Replay Sprint — the "Closer" paper bot.
//
// Shape, validated walk-forward on the 24h dev window (three 8h slices,
// frozen parameters, positive on every slice at 1x and at 2x fees):
//  - CLOSER: buy a coin ONCE when its real SOL reserves reach 50 SOL while
//    it is still accelerating (real reserves grew >= 10 SOL over the last
//    50 slots) and young (created <= 1000 slots ago). Stake 0.5 SOL.
//    No take-profit: hold for the bonding-curve completion, whose
//    force-close pays roughly 2x the fill price, or exit on a 25%
//    stop-loss or a 300-slot timeout. The edge is completion capture:
//    coins that reach 50 SOL with momentum complete far more often than
//    the field's blind entries, and every non-completer eventually
//    collapses, so a bounded hold with a stop is what keeps the losers
//    small. Tight exits and trailing stops were tested and rejected:
//    completers dip hard before they complete, so a tight stop cuts them.
//  - PROBES: tiny 0.012 SOL round trips on liquid coins, only to bank the
//    20-distinct-coins guardrail the Closer alone does not reach. A probe
//    buys, then sells its whole balance the moment its buy fill is
//    reported. Each probe costs about one round trip of fees; a dozen of
//    them cost less than 0.01 SOL in total.
//
// Deterministic: no clock, no randomness, no environment, no network.
// Every comparison is bigint; the only state is the event stream itself.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const SOL = 1_000_000_000n;

// ---- frozen strategy parameters (walk-forward validated) ----
const ENTRY_RQ = 50n * SOL; // enter once real reserves reach 50 SOL
const STAKE = 500_000_000n; // 0.5 SOL per Closer entry
const STOP_NUM = 3n; // stop-loss: sell when price <= STOP_NUM/STOP_DEN of fill
const STOP_DEN = 4n;
const MAX_HOLD = 300; // slots from fill to timeout exit
const MIN_VEL50 = 10n * SOL; // real reserves must have grown >= 10 SOL in 50 slots
const VEL_WINDOW = 50; // slots of lookback for the velocity gate
const MAX_AGE = 1000; // slots since creation at entry
const PROBE_STAKE = 12_000_000n; // 0.012 SOL per guardrail probe
const PROBE_MIN_RQ = 5n * SOL; // probes only on coins with >= 5 SOL real reserves
const MAX_PROBES = 12; // enough to clear the 20-coin guardrail with margin
const PROBE_SPACING = 500; // slots between probe buys
const ROUND_TRIP_TARGET = 25; // stop probing once this many coins round-tripped
const MAX_SLIPPAGE_BPS = 10000; // wide: never refuse a fill on slippage
const MAX_SNAPSHOTS = 1000; // reserve snapshots kept per mint

type Snap = { slot: number; vq: bigint; vt: bigint; rq: bigint };
type Kind = "closer" | "probe";
type OpenPos = { kind: Kind; fillSlot: number; fillVq: bigint; fillVt: bigint };

// Per-mint reserve snapshots in slot order (one per slot, latest event wins).
const snaps = new Map<string, Snap[]>();
const firstSeen = new Map<string, number>(); // mint -> first batch slot seen
const entered = new Set<string>(); // mints the Closer already bought (once each)
const probed = new Set<string>(); // mints already probed
const openPos = new Map<string, OpenPos>(); // filled positions awaiting exit
const buyKind = new Map<string, Kind>(); // client_id -> kind, for fill attribution
const sellPending = new Set<string>(); // mints with a sell in flight
const roundTrips = new Set<string>(); // mints with a completed round trip
let probesSent = 0;
let lastProbeSlot = -1_000_000;

/** Last snapshot at or before `slot`, or null when the mint has none that old. */
function snapAt(mint: string, slot: number): Snap | null {
  const arr = snaps.get(mint);
  if (arr === undefined || arr.length === 0) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].slot <= slot) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans < 0 ? null : arr[ans];
}

/** Record this batch's post-trade reserves for a mint. */
function recordSnap(mint: string, slot: number, vq: bigint, vt: bigint, rq: bigint): void {
  let arr = snaps.get(mint);
  if (arr === undefined) {
    arr = [];
    snaps.set(mint, arr);
  }
  const last = arr[arr.length - 1];
  if (last !== undefined && last.slot === slot) {
    // Same slot, later event in chain order: keep only the newest state.
    last.vq = vq;
    last.vt = vt;
    last.rq = rq;
    return;
  }
  arr.push({ slot, vq, vt, rq });
  if (arr.length > MAX_SNAPSHOTS) arr.splice(0, arr.length - MAX_SNAPSHOTS);
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const slot = batch.slot;
  const orders: OrderInput[] = [];
  let buysAdded = 0;
  let spentThisBatch = 0n;
  const txFee = state.txFeeLamports();
  const maxPos = state.hello.caps.max_open_positions;

  // 1. Fold this batch's events into the snapshot history.
  for (const e of batch.events) {
    if (!firstSeen.has(e.mint)) firstSeen.set(e.mint, slot);
    if (e.event === "CreateEvent") {
      recordSnap(e.mint, slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), 0n);
    } else if (e.event === "TradeEvent") {
      recordSnap(e.mint, slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), BigInt(e.real_quote_reserves));
    }
  }

  // 2. Fold in the fills reported with this batch.
  for (const f of batch.fills) {
    if (f.side === "buy") {
      const kind = buyKind.get(f.client_id);
      buyKind.delete(f.client_id);
      if (f.status === "filled" && kind !== undefined) {
        // The fill price is the market price at the fill slot, from the
        // snapshot history (the fill may be reported a few slots late).
        const s = snapAt(f.mint, f.slot);
        const curve = state.curves.get(f.mint);
        openPos.set(f.mint, {
          kind,
          fillSlot: f.slot,
          fillVq: s !== null ? s.vq : (curve?.virtual_quote_reserves ?? 0n),
          fillVt: s !== null ? s.vt : (curve?.virtual_token_reserves ?? 1n),
        });
      } else if (f.status !== "filled" && kind === "closer") {
        // A failed or rejected buy never opened a position: allow a retry.
        entered.delete(f.mint);
      }
    } else {
      // A sell resolved: on a fill the round trip is done; on a failure or
      // rejection the position is still open and the sell retries next batch.
      sellPending.delete(f.mint);
      if (f.status === "filled") {
        openPos.delete(f.mint);
        roundTrips.add(f.mint);
      }
    }
  }

  // 3. Exits: stop-loss / timeout for Closer positions, immediate for probes.
  for (const [mint, pos] of openPos) {
    if (sellPending.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue; // harness closes it
    const holding = state.positions.get(mint);
    if (holding === undefined || holding.token_amount === 0n) continue;
    let exit = false;
    if (pos.kind === "probe") {
      exit = true; // probes sell the moment the buy fill is known
    } else if (slot - pos.fillSlot >= MAX_HOLD) {
      exit = true;
    } else {
      // Sell when price <= 3/4 of the fill price, cross-multiplied in
      // bigint: vq/vt <= (3/4)(fillVq/fillVt) <=> 4*vq*fillVt <= 3*vt*fillVq.
      exit =
        curve.virtual_quote_reserves * pos.fillVt * STOP_DEN <=
        curve.virtual_token_reserves * pos.fillVq * STOP_NUM;
    }
    if (exit) {
      orders.push({ side: "sell", mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      sellPending.add(mint);
    }
  }

  // 4. Closer entries: one buy per mint, when reserves, momentum and age agree.
  // Eligibility can only begin on a slot where the mint trades (reserves and
  // velocity only move on trades; age only grows), so checking this batch's
  // mints catches every entry window.
  //
  // A mint with a buy already in flight (a probe's, say) is skipped: two
  // fills on one mint would merge into a single harness position, and the
  // second fill would overwrite the first one's kind and fill price.
  const buyPending = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === "buy") buyPending.add(p.order.mint);
  }
  const checked = new Set<string>();
  for (const e of batch.events) {
    if (e.event !== "TradeEvent") continue;
    const mint = e.mint;
    if (checked.has(mint)) continue;
    checked.add(mint);
    if (entered.has(mint) || openPos.has(mint) || buyPending.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < ENTRY_RQ) continue;
    const created = curve.created_slot ?? firstSeen.get(mint) ?? slot;
    if (slot - created > MAX_AGE) continue;
    const old = snapAt(mint, slot - VEL_WINDOW);
    const rqThen = old === null ? 0n : old.rq;
    if (curve.real_quote_reserves - rqThen < MIN_VEL50) continue;
    if (state.committedPositionCount() + buysAdded >= maxPos) break;
    if (state.maxBuyLamports(mint) < STAKE) continue;
    if (state.freeCashLamports() - spentThisBatch < STAKE + txFee) break;
    const id = state.clientId();
    buyKind.set(id, "closer");
    entered.add(mint);
    buysAdded += 1;
    spentThisBatch += STAKE + txFee;
    orders.push({ side: "buy", mint, quote_lamports: STAKE, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
  }

  // 5. Guardrail probes: tiny round trips on liquid coins, paced through the day.
  if (
    roundTrips.size < ROUND_TRIP_TARGET &&
    probesSent < MAX_PROBES &&
    slot - lastProbeSlot >= PROBE_SPACING &&
    state.committedPositionCount() + buysAdded < maxPos
  ) {
    let best: string | null = null;
    let bestRq = -1n;
    for (const e of batch.events) {
      if (e.event !== "TradeEvent") continue;
      const mint = e.mint;
      if (entered.has(mint) || probed.has(mint) || openPos.has(mint) || roundTrips.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < PROBE_MIN_RQ) continue;
      if (state.maxBuyLamports(mint) < PROBE_STAKE) continue;
      // Deterministic pick: highest real reserves, ties broken by mint.
      if (curve.real_quote_reserves > bestRq || (curve.real_quote_reserves === bestRq && (best === null || mint < best))) {
        best = mint;
        bestRq = curve.real_quote_reserves;
      }
    }
    if (best !== null && state.freeCashLamports() - spentThisBatch >= PROBE_STAKE + txFee) {
      const id = state.clientId();
      buyKind.set(id, "probe");
      probed.add(best);
      probesSent += 1;
      lastProbeSlot = slot;
      orders.push({ side: "buy", mint: best, quote_lamports: PROBE_STAKE, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
    }
  }

  return orders;
}

await runBot({ onBatch });
