import {
  createPublicClient, createWalletClient, custom, decodeEventLog, http, PublicClient, toHex, WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import factoryAbi from '../abi/ScheduleFactory.json' with { type: 'json' };
import vaultAbi from '../abi/ScheduleVault.json' with { type: 'json' };
import stakedAbi from '../abi/StakedScheduleVault.json' with { type: 'json' };
import { friendlyError, UserError } from '../lib/errors.js';
import { Address } from '../lib/format.js';
import { Limits, Plan, problems, requiredValue } from '../lib/plan.js';
import { AppConfig } from './config.js';
import { Adapter, DeliveryInfo, ScheduleView, TrancheView } from './types.js';

/** Minimal EIP-1193 provider. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...a: never[]) => void): void;
  removeListener?(event: string, cb: (...a: never[]) => void): void;
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const DAY = 86_400;
type Hex = `0x${string}`;
type Raw = { recipient: Address; unlockTime: bigint; kind: number; status: number; amountOrId: bigint };

export class LiveAdapter implements Adapter {
  readonly mode = 'live' as const;
  private readonly pub: PublicClient;
  private wallet: WalletClient | null = null;
  private acct: Address | null = null;
  private listeners = new Set<(a: Address | null) => void>();
  private consts?: { minWindow: number; maxWindow: number; maxTip: bigint; prepareLead: number; validatorAllowed: boolean };
  private created = new Map<string, { staked: boolean; creator: Address; block: bigint }>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly provider: Eip1193 | null,
  ) {
    if (!cfg.factory) throw new Error('LiveAdapter needs a factory address');
    this.pub = createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 2 }) }) as PublicClient;
    if (provider) this.attach(provider);
  }

  private attach(p: Eip1193): void {
    this.wallet = createWalletClient({ chain: this.chainDef(), transport: custom(p as never) }) as WalletClient;
    p.on?.('accountsChanged', ((accs: string[]) => this.setAccount((accs[0] as Address) ?? null)) as never);
    p.on?.('chainChanged', (() => this.setAccount(this.acct)) as never);
    // Silent restore: does not prompt if the wallet was never connected.
    p.request({ method: 'eth_accounts' }).then((a) => this.setAccount(((a as string[])[0] as Address) ?? null)).catch(() => {});
  }

  private setAccount(a: Address | null): void {
    this.acct = a;
    for (const l of this.listeners) l(a);
  }

  // ------------------------------------------------------------------ session
  account(): Address | null {
    return this.acct;
  }

  onAccountChange(cb: (a: Address | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async connect(): Promise<Address> {
    if (!this.provider) throw new UserError('No wallet found. Install a wallet such as MetaMask, then reload.');
    const accs = (await this.provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accs[0]) throw new UserError('No account was shared by the wallet.');
    await this.ensureChain();
    this.setAccount(accs[0] as Address);
    return accs[0] as Address;
  }

  private async ensureChain(): Promise<void> {
    if (!this.provider) return;
    const want = toHex(this.cfg.chainId);
    const have = (await this.provider.request({ method: 'eth_chainId' })) as string;
    if (have.toLowerCase() === want.toLowerCase()) return;
    try {
      await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      if ((e as { code?: number }).code === 4902) {
        await this.provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: want,
            chainName: this.cfg.chainName,
            nativeCurrency: { name: this.cfg.currency, symbol: this.cfg.currency, decimals: 18 },
            rpcUrls: [this.cfg.rpcUrl],
            blockExplorerUrls: this.cfg.explorer ? [this.cfg.explorer] : undefined,
          }],
        });
      } else throw e;
    }
  }

  async balance(addr: Address): Promise<bigint> {
    return this.pub.getBalance({ address: addr });
  }

  // ------------------------------------------------------------------ chain facts
  async chainNow(): Promise<number> {
    return Number((await this.pub.getBlock({ blockTag: 'latest' })).timestamp);
  }

  async limits(): Promise<Limits> {
    const f = this.cfg.factory!;
    const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
      this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    if (!this.consts) {
      const [minWindow, maxWindow, maxTip, stakedImpl] = await Promise.all([
        read<bigint>(f, factoryAbi, 'MIN_FUNDING_WINDOW'),
        read<bigint>(f, factoryAbi, 'MAX_FUNDING_WINDOW'),
        read<bigint>(f, factoryAbi, 'MAX_TIP'),
        read<Address>(f, factoryAbi, 'stakedImplementation'),
      ]);
      const [prepareLead, validatorAllowed] = await Promise.all([
        read<bigint>(stakedImpl, stakedAbi, 'PREPARE_LEAD'),
        this.cfg.validatorId > 0n ? read<boolean>(f, factoryAbi, 'isAllowedValidator', [this.cfg.validatorId]) : Promise.resolve(false),
      ]);
      this.consts = { minWindow: Number(minWindow), maxWindow: Number(maxWindow), maxTip, prepareLead: Number(prepareLead), validatorAllowed };
    }
    const c = this.consts;
    return {
      now: await this.chainNow(),
      minWindow: c.minWindow,
      maxWindow: c.maxWindow,
      maxTip: c.maxTip,
      stakeLead: c.validatorAllowed ? c.prepareLead + DAY : null,
    };
  }

  // ------------------------------------------------------------------ writes
  private async send(address: Address, abi: unknown, functionName: string, args: unknown[], value = 0n, key?: Hex): Promise<Hex> {
    try {
      // Acting as a claim-link key: sign locally, no wallet involved.
      if (key) {
        const account = privateKeyToAccount(key);
        const w = createWalletClient({ account, chain: this.chainDef(), transport: http(this.cfg.rpcUrl) });
        const { request } = await this.pub.simulateContract({ address, abi, functionName, args, value, account } as never);
        const hash = await w.writeContract(request as never);
        return await this.confirm(hash);
      }
      if (!this.wallet || !this.acct) throw new UserError('Connect your wallet first.');
      await this.ensureChain();
      const account = this.acct;
      // Dry-run first: contract errors surface as a sentence, before the wallet prompt.
      const { request } = await this.pub.simulateContract({ address, abi, functionName, args, value, account } as never);
      const hash = await this.wallet.writeContract({ ...(request as object), account } as never);
      return await this.confirm(hash);
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(friendlyError(e));
    }
  }

  private async confirm(hash: Hex): Promise<Hex> {
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new UserError('The transaction failed on-chain.');
    return hash;
  }

  private chainDef() {
    return {
      id: this.cfg.chainId,
      name: this.cfg.chainName,
      nativeCurrency: { name: this.cfg.currency, symbol: this.cfg.currency, decimals: 18 },
      rpcUrls: { default: { http: [this.cfg.rpcUrl] } },
    };
  }

  async create(plan: Plan): Promise<{ vault: Address; tx: Hex }> {
    if (!this.acct) throw new UserError('Connect your wallet first.');
    const lim = await this.limits();
    const issues = problems(plan, lim);
    if (issues.length) throw new UserError(issues[0]!);
    const value = requiredValue(plan);
    const bal = await this.balance(this.acct);
    if (bal < value) throw new UserError('Your wallet does not have enough for this plus network fees.');

    const params = {
      fallbackRecipient: plan.fallback ?? ZERO,
      revocable: plan.revocable,
      fundingWindow: BigInt(plan.fundingWindow),
      tipPerExecution: plan.tip,
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
      validatorId: plan.grow ? this.cfg.validatorId : 0n,
    };
    const tranches = plan.tranches.map((t) => ({
      recipient: t.recipient, kind: 0, token: ZERO, amountOrId: t.amount, unlockTime: BigInt(t.unlockTime),
    }));
    const tx = await this.send(this.cfg.factory!, factoryAbi, 'create', [params, tranches, true], value);
    const receipt = await this.pub.getTransactionReceipt({ hash: tx });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.cfg.factory!.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: factoryAbi as never, data: log.data, topics: log.topics as never }) as unknown as { eventName: string; args: { vault: Address } };
        if (ev.eventName === 'ScheduleCreated') return { vault: ev.args.vault, tx };
      } catch { /* not ours */ }
    }
    throw new UserError('The schedule was created but its address could not be read. Check "My schedules".');
  }

  claim = (vault: Address, id: number, key?: Hex) => this.send(vault, vaultAbi, 'claim', [BigInt(id)], 0n, key);
  setRecipient = (vault: Address, id: number, to: Address, key?: Hex) => this.send(vault, vaultAbi, 'setRecipient', [BigInt(id), to], 0n, key);
  requestCancel = (vault: Address) => this.send(vault, vaultAbi, 'requestCancel', []);
  abortCancel = (vault: Address) => this.send(vault, vaultAbi, 'abortCancel', []);
  finalizeCancel = (vault: Address) => this.send(vault, vaultAbi, 'finalizeCancel', []);

  async fundGas(to: Address, amount: bigint): Promise<Hex> {
    if (!this.wallet || !this.acct) throw new UserError('Connect your wallet first.');
    try {
      await this.ensureChain();
      const hash = await this.wallet.sendTransaction({ to, value: amount, account: this.acct, chain: this.chainDef() } as never);
      return await this.confirm(hash);
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(friendlyError(e));
    }
  }

  async moveAll(key: Hex, to: Address): Promise<Hex> {
    try {
      const account = privateKeyToAccount(key);
      const w = createWalletClient({ account, chain: this.chainDef(), transport: http(this.cfg.rpcUrl) });
      const [balance, gasPrice] = await Promise.all([this.pub.getBalance({ address: account.address }), this.pub.getGasPrice()]);
      // A plain transfer costs 21,000 gas; leave 50 % headroom for a rising price.
      const fee = (21_000n * gasPrice * 3n) / 2n;
      if (balance <= fee) throw new UserError('There is nothing to move yet.');
      const hash = await w.sendTransaction({ to, value: balance - fee, gas: 21_000n, maxFeePerGas: (gasPrice * 3n) / 2n, maxPriorityFeePerGas: 0n } as never);
      return await this.confirm(hash);
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(friendlyError(e));
    }
  }

  // ------------------------------------------------------------------ reads
  /** A schedule is only trusted if our factory created it: a link may point at anything. */
  private async origin(vault: Address): Promise<{ staked: boolean; creator: Address; block: bigint }> {
    const hit = this.created.get(vault.toLowerCase());
    if (hit) return hit;
    const event = (factoryAbi as Array<{ type: string; name?: string }>).find((x) => x.type === 'event' && x.name === 'ScheduleCreated');
    const logs = (await this.pub.getLogs({
      address: this.cfg.factory!, event, args: { vault }, fromBlock: this.cfg.factoryBlock, toBlock: 'latest',
    } as never)) as unknown as Array<{ args: { creator: Address; staked: boolean }; blockNumber: bigint }>;
    const l = logs[0];
    if (!l) throw new UserError('This is not a Kindred schedule from this network.');
    const info = { staked: l.args.staked, creator: l.args.creator, block: l.blockNumber };
    this.created.set(vault.toLowerCase(), info);
    return info;
  }

  async get(vault: Address): Promise<ScheduleView> {
    const o = await this.origin(vault);
    const abi = (o.staked ? stakedAbi : vaultAbi) as never;
    const r = <T>(functionName: string, args: unknown[] = []) => this.pub.readContract({ address: vault, abi, functionName, args } as never) as Promise<T>;

    const [state, revocable, fundingDeadline, cancelRequestedAt, tipPool, fallback, raw, chainNow] = await Promise.all([
      r<number>('state'), r<boolean>('revocable'), r<bigint>('fundingDeadline'), r<bigint>('cancelRequestedAt'),
      r<bigint>('tipPool'), r<Address>('fallbackRecipient'), r<Raw[]>('tranches'), this.chainNow(),
    ]);

    let stages: number[] = raw.map(() => 0);
    let payouts: bigint[] = raw.map(() => 0n);
    let position: ScheduleView['position'];
    if (o.staked) {
      [stages, payouts] = await Promise.all([
        Promise.all(raw.map((t, i) => (t.kind === 0 ? r<number>('stage', [BigInt(i)]) : Promise.resolve(0)))),
        Promise.all(raw.map((t, i) => (t.kind === 0 ? r<bigint>('payout', [BigInt(i)]) : Promise.resolve(0n)))),
      ]);
      const [stake, rewards] = await r<[bigint, bigint]>('stakedPosition');
      position = { stake, rewards };
    }

    const tranches: TrancheView[] = raw.map((t, i) => ({
      id: i, recipient: t.recipient, kind: Number(t.kind), amount: t.amountOrId, unlockTime: Number(t.unlockTime),
      status: Number(t.status), stage: Number(stages[i] ?? 0), payout: payouts[i] ?? 0n,
    }));

    return {
      address: vault, creator: o.creator, staked: o.staked, revocable, state: Number(state), fundingDeadline: Number(fundingDeadline),
      cancelRequestedAt: Number(cancelRequestedAt), tipPool, fallback, tranches, deliveries: await this.deliveries(vault, o.block), position, chainNow,
    };
  }

  private async deliveries(vault: Address, from: bigint): Promise<DeliveryInfo[]> {
    const logs = await this.pub.getLogs({ address: vault, fromBlock: from, toBlock: 'latest' });
    const out: DeliveryInfo[] = [];
    const blocks = new Map<bigint, number>();
    for (const log of logs) {
      let ev: { eventName: string; args: { id?: bigint } };
      try {
        ev = decodeEventLog({ abi: vaultAbi as never, data: log.data, topics: log.topics as never }) as unknown as typeof ev;
      } catch { continue; }
      const how = ev.eventName === 'Executed' ? 'executed' : ev.eventName === 'Claimed' ? 'claimed' : ev.eventName === 'Swept' ? 'swept' : null;
      if (!how || ev.args.id === undefined || log.blockNumber === null || log.transactionHash === null) continue;
      if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, Number((await this.pub.getBlock({ blockNumber: log.blockNumber })).timestamp));
      out.push({ id: Number(ev.args.id), how, blockTime: blocks.get(log.blockNumber)!, tx: log.transactionHash });
    }
    return out;
  }

  async listByCreator(creator: Address): Promise<Address[]> {
    const event = (factoryAbi as Array<{ type: string; name?: string }>).find((x) => x.type === 'event' && x.name === 'ScheduleCreated');
    const logs = (await this.pub.getLogs({
      address: this.cfg.factory!, event, args: { creator }, fromBlock: this.cfg.factoryBlock, toBlock: 'latest',
    } as never)) as unknown as Array<{ args: { vault: Address; creator: Address; staked: boolean }; blockNumber: bigint }>;
    for (const l of logs) this.created.set(l.args.vault.toLowerCase(), { staked: l.args.staked, creator: l.args.creator, block: l.blockNumber });
    return logs.map((l) => l.args.vault).reverse();
  }
}
