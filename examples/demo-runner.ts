/**
 * Shared demo runner for @xlayer/mpp.
 * Called by demo-mainnet.ts and demo-testnet.ts with network-specific config.
 *
 * Scenario
 * --------
 * An autonomous DeFi agent needs market intelligence from the XLayer DeFi
 * Oracle API. Instead of API keys or subscriptions, it pays per query using
 * USDC on XLayer — powered by MPP (Machine Payments Protocol).
 *
 *   Scenario 1 — Spot Signal  : one-off request, pay-per-call via HTTP 402
 *   Scenario 2 — Price Stream : open a metered channel, stream price ticks
 *                                with off-chain EIP-712 signatures, settle once
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { resolve } from "path";

import { XLayerChargeServer } from "../src/server/index.js";
import { XLayerChargeClient } from "../src/client/index.js";
import { XLayerSessionServer } from "../src/server/index.js";
import { XLayerSessionClient } from "../src/client/index.js";
import { createMemoryStore } from "./in-memory-store.js";
import type { XLayerNetwork } from "../src/constants.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DemoConfig {
  network:          XLayerNetwork;
  chain:            Chain;
  rpcUrl:           string;
  explorerUrl:      string;
  serverKey:        Hex;
  channelContract?: Address;
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  cyan:    "\x1b[36m",
  gray:    "\x1b[90m",
  red:     "\x1b[31m",
  white:   "\x1b[97m",
  magenta: "\x1b[35m",
};

// ─── Logging helpers ──────────────────────────────────────────────────────────

const sep   = () => console.log(`\n${C.gray}${"─".repeat(68)}${C.reset}`);
const blank = () => console.log();

function header(title: string) {
  sep();
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  sep();
}

function step(label: string, msg: string) {
  console.log(`\n${C.bold}${C.blue}  [${label}]${C.reset}  ${C.white}${msg}${C.reset}`);
}

function ok(msg: string)     { console.log(`${C.green}         ✓  ${msg}${C.reset}`); }
function info(msg: string)   { console.log(`${C.gray}         →  ${msg}${C.reset}`); }
function warn(msg: string)   { console.log(`${C.yellow}         ⚠  ${msg}${C.reset}`); }
function agent(msg: string)  { console.log(`${C.magenta}  agent   ›  ${msg}${C.reset}`); }
function oracle(msg: string) { console.log(`${C.cyan}  oracle  ›  ${msg}${C.reset}`); }

function kv(key: string, val: string) {
  console.log(`${C.gray}         ${key.padEnd(20)}${C.reset}${C.cyan}${val}${C.reset}`);
}

function txLine(label: string, hash: string, explorerUrl: string) {
  console.log(`${C.yellow}         ⛓  ${label}${C.reset}`);
  console.log(`${C.gray}            hash:     ${C.reset}${hash}`);
  console.log(`${C.gray}            explorer: ${C.reset}${explorerUrl}/tx/${hash}`);
}

function apiResponse(lines: [string, string][]) {
  blank();
  console.log(`${C.green}         ┌─ API Response ────────────────────────────────${C.reset}`);
  for (const [k, v] of lines) {
    console.log(`${C.green}         │${C.reset}  ${C.gray}${k.padEnd(18)}${C.reset}${C.white}${v}${C.reset}`);
  }
  console.log(`${C.green}         └───────────────────────────────────────────────${C.reset}`);
  blank();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Fake market data ─────────────────────────────────────────────────────────

const TICKS = [
  { price: "52.34", change: "+2.14%", vol: "18.2M" },
  { price: "52.41", change: "+2.28%", vol: "18.5M" },
  { price: "52.38", change: "+2.21%", vol: "18.3M" },
  { price: "52.47", change: "+2.39%", vol: "18.7M" },
];

// ─── Artifact loader ──────────────────────────────────────────────────────────

function loadArtifact(name: string) {
  const path = resolve(`artifacts/${name}.sol/${name}.json`);
  const raw  = readFileSync(path, "utf-8");
  return JSON.parse(raw) as { abi: unknown[]; bytecode: { object: string } };
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runDemo(cfg: DemoConfig) {
  const { network, chain, rpcUrl, explorerUrl, serverKey } = cfg;

  const publicClient  = createPublicClient({ chain, transport: http(rpcUrl) });
  const serverAccount = privateKeyToAccount(serverKey);
  const serverWallet  = createWalletClient({ account: serverAccount, chain, transport: http(rpcUrl) });

  // ── Banner ─────────────────────────────────────────────────────────────────

  console.clear();
  blank();
  console.log(`${C.bold}${C.cyan}${"═".repeat(68)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  XLayer MPP — Machine Payments Protocol${C.reset}`);
  console.log(`${C.bold}${C.cyan}  Autonomous agents paying APIs with USDC on XLayer${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"═".repeat(68)}${C.reset}`);
  blank();
  console.log(`${C.gray}  Actors${C.reset}`);
  await sleep(600);
  console.log(`${C.magenta}  agent  ${C.reset}${C.gray}—${C.reset}  Autonomous DeFi Agent  (needs market intelligence)`);
  await sleep(600);
  console.log(`${C.cyan}  oracle ${C.reset}${C.gray}—${C.reset}  XLayer DeFi Oracle API (sells on-chain data)`);
  blank();
  console.log(`${C.gray}  Network: XLayer ${network} · Chain ID ${chain.id}${C.reset}`);
  await sleep(2500);

  // ── Setup ──────────────────────────────────────────────────────────────────

  header("SETUP — Spinning up oracle and agent wallets");

  step("rpc", `Connecting to XLayer ${network}`);
  await sleep(1000);

  const block = await publicClient.getBlockNumber();
  kv("RPC endpoint:", rpcUrl);
  await sleep(400);
  kv("Latest block:",  String(block));
  await sleep(400);
  ok("Connected");
  await sleep(1200);

  step("wallets", "Generating oracle (server) and agent (client) wallets");
  await sleep(1000);

  const clientKey     = generatePrivateKey();
  const clientAccount = privateKeyToAccount(clientKey);
  const clientWallet  = createWalletClient({ account: clientAccount, chain, transport: http(rpcUrl) });

  oracle(`address: ${serverAccount.address}`);
  await sleep(600);
  agent(`address:  ${clientAccount.address}`);
  await sleep(600);

  const serverOKB = await publicClient.getBalance({ address: serverAccount.address });
  kv("Oracle OKB:", `${formatUnits(serverOKB, 18)} OKB (covers gas)`);

  if (serverOKB === 0n) {
    warn(`Oracle wallet has no OKB. Fund ${serverAccount.address} on ${network} and retry.`);
    process.exit(1);
  }
  await sleep(400);
  ok("Wallets ready");
  await sleep(1200);

  step("fund", "Oracle funds agent with OKB for gas (approve + open txs)");
  await sleep(1000);

  const fundHash = await serverWallet.sendTransaction({
    account: serverAccount,
    to:      clientAccount.address,
    value:   parseUnits("0.0015", 18),
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  txLine("OKB → agent", fundHash, explorerUrl);
  await sleep(800);
  ok("Agent funded with 0.0015 OKB");
  await sleep(1500);

  step("token", "Minting demo USDC to agent (100 mUSDC)");
  await sleep(1000);

  const tokenSupply  = parseUnits("100", 6);
  const mockArtifact = loadArtifact("MockERC20");
  const mockAbi      = mockArtifact.abi as Parameters<typeof serverWallet.deployContract>[0]["abi"];
  const mockBytecode = mockArtifact.bytecode.object as Hex;

  const mockDeployHash = await serverWallet.deployContract({
    abi: mockAbi, bytecode: mockBytecode, args: [clientAccount.address, tokenSupply],
  });
  const mockReceipt = await publicClient.waitForTransactionReceipt({ hash: mockDeployHash });
  const tokenAddress = mockReceipt.contractAddress!;

  txLine("MockUSDC deployed", mockDeployHash, explorerUrl);
  await sleep(600);
  kv("Token:", tokenAddress);
  await sleep(400);
  agent(`balance: ${formatUnits(tokenSupply, 6)} USDC`);
  await sleep(400);
  ok("Agent has demo USDC");
  await sleep(1500);

  // Deploy or use existing XLayerMPPChannel
  let channelContract = cfg.channelContract;
  if (!channelContract) {
    step("contract", "Deploying XLayerMPPChannel escrow contract");
    await sleep(1000);

    const chanArtifact  = loadArtifact("XLayerMPPChannel");
    const chanAbi       = chanArtifact.abi as Parameters<typeof serverWallet.deployContract>[0]["abi"];
    const chanBytecode  = chanArtifact.bytecode.object as Hex;

    const chanDeployHash = await serverWallet.deployContract({
      abi: chanAbi, bytecode: chanBytecode, args: [],
    });
    const chanReceipt   = await publicClient.waitForTransactionReceipt({ hash: chanDeployHash });
    channelContract     = chanReceipt.contractAddress!;

    txLine("XLayerMPPChannel deployed", chanDeployHash, explorerUrl);
    await sleep(600);
    kv("Escrow contract:", channelContract);
    await sleep(400);
    ok("Payment channel contract live on XLayer");
    await sleep(1500);
  } else {
    step("contract", "XLayerMPPChannel already deployed");
    await sleep(800);
    kv("Escrow contract:", channelContract);
    await sleep(400);
    ok("Ready");
    await sleep(1200);
  }

  const tokenBalance = async (account: Address): Promise<bigint> =>
    publicClient.readContract({
      address: tokenAddress,
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view",
               inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;

  // ── SCENARIO 1: CHARGE ─────────────────────────────────────────────────────

  header("SCENARIO 1 — Spot Signal Request  (pay-per-call via HTTP 402)");

  blank();
  console.log(`${C.gray}  Agent wants a one-off market signal for OKB/USDC.${C.reset}`);
  await sleep(700);
  console.log(`${C.gray}  No API key. No account. Payment unlocks the response.${C.reset}`);
  blank();
  await sleep(1500);

  const chargeStore  = createMemoryStore();
  const PAY_AMOUNT   = parseUnits("1", 6);

  const chargeServer = new XLayerChargeServer({
    signerPrivateKey: serverKey,
    store:            chargeStore,
    network,
    rpcUrl,
  });

  const chargeClient = new XLayerChargeClient({
    walletClient: clientWallet,
    network,
    rpcUrl,
  });

  step("402", "Agent → POST /api/signal/OKB-USDC");
  await sleep(1200);

  agent("POST /api/signal/OKB-USDC  HTTP/1.1");
  await sleep(1000);

  const chargeChallenge = await chargeServer.createChallenge({
    amount:      "1",
    currency:    "USDC",
    recipient:   serverAccount.address,
    description: "OKB/USDC spot signal — XLayer DeFi Oracle",
  });
  chargeChallenge.methodDetails.tokenAddress = tokenAddress;

  oracle("HTTP 402 Payment Required");
  await sleep(500);
  kv("cost:",       "1 mUSDC");
  await sleep(400);
  kv("endpoint:",   "POST /api/signal/OKB-USDC");
  await sleep(400);
  kv("reference:",  chargeChallenge.methodDetails.reference);
  await sleep(1500);

  step("sign", "Agent signs payment credential (oracle will broadcast — agent pays no gas)");
  await sleep(1200);

  const oracleBefore = await tokenBalance(serverAccount.address);
  const agentBefore  = await tokenBalance(clientAccount.address);

  const chargeCredential = await chargeClient.handleChallenge(chargeChallenge);
  agent(`signed tx:  ${chargeCredential.transaction.slice(0, 42)}...`);
  await sleep(600);
  ok("Credential signed — no broadcast yet");
  await sleep(1500);

  step("pay", "Oracle broadcasts transfer & verifies on-chain");
  await sleep(1200);

  const chargeReceipt = await chargeServer.handleCredential(chargeChallenge, chargeCredential);
  txLine("USDC transfer confirmed", chargeReceipt.txHash, explorerUrl);
  await sleep(800);
  ok(`Included in block ${chargeReceipt.blockNumber}`);
  await sleep(1500);

  step("response", "Payment confirmed — API response unlocked");
  await sleep(1200);

  apiResponse([
    ["pair:",        "OKB / USDC"],
    ["price:",       `${TICKS[0]!.price} USDC`],
    ["24h change:",  TICKS[0]!.change],
    ["volume:",      `${TICKS[0]!.vol} USDC`],
    ["signal:",      "ACCUMULATE ▲"],
    ["confidence:",  "87%"],
    ["cost:",        "1 mUSDC  ✓ paid"],
  ]);
  await sleep(1500);

  const oracleAfter = await tokenBalance(serverAccount.address);
  const agentAfter  = await tokenBalance(clientAccount.address);

  oracle(`received: +${formatUnits(oracleAfter - oracleBefore, 6)} USDC`);
  await sleep(600);
  agent(`spent:    -${formatUnits(agentBefore - agentAfter, 6)} USDC`);
  await sleep(1500);

  step("replay", "Agent replays the same credential → rejected");
  await sleep(1200);

  try {
    await chargeServer.handleCredential(chargeChallenge, chargeCredential);
    warn("BUG: replay accepted!");
  } catch {
    ok("Duplicate credential rejected — reference already spent");
  }

  blank();
  await sleep(800);
  console.log(`${C.green}${C.bold}  ✅  Scenario 1 complete — 1 mUSDC paid, 0 gas spent by agent${C.reset}`);
  await sleep(3000);

  // ── SCENARIO 2: SESSION ────────────────────────────────────────────────────

  header("SCENARIO 2 — Live Price Stream  (metered session via payment channel)");

  blank();
  console.log(`${C.gray}  Agent subscribes to a live XLayer price feed.${C.reset}`);
  await sleep(800);
  console.log(`${C.gray}  One on-chain deposit. Every price tick = EIP-712 signature — zero gas.${C.reset}`);
  await sleep(800);
  console.log(`${C.gray}  Oracle settles the final cumulative amount on-chain when session ends.${C.reset}`);
  blank();
  await sleep(1500);

  const sessionStore  = createMemoryStore();
  const PER_TICK      = parseUnits("1", 6);

  const sessionServer = new XLayerSessionServer({
    recipient:              serverAccount.address,
    acceptedAssets:         [tokenAddress],
    network,
    rpcUrl,
    store:                  sessionStore,
    channelContractAddress: channelContract,
    signerPrivateKey:       serverKey,
  });

  const sessionClient = new XLayerSessionClient({
    walletClient:           clientWallet,
    network,
    rpcUrl,
    autoOpen:               true,
    autoTopup:              false,
    channelContractAddress: channelContract,
    depositMultiplier:      10,
  });

  const oracleBeforeSession = await tokenBalance(serverAccount.address);
  const agentBeforeSession  = await tokenBalance(clientAccount.address);

  // Open channel
  step("open", "Agent opens payment channel — deposits 10 USDC into escrow");
  blank();
  await sleep(1000);
  agent("POST /api/stream/subscribe  HTTP/1.1");
  await sleep(1000);

  const openChallenge  = await sessionServer.createChallenge({ amount: "1", asset: tokenAddress });
  oracle("HTTP 402 Payment Required  (open channel first)");
  await sleep(500);
  kv("contract:", channelContract);
  await sleep(400);
  kv("deposit:",  "10 mUSDC (covers 10 ticks upfront)");
  await sleep(1200);

  info("Agent calls approve() + XLayerMPPChannel.open() on-chain...");
  const openCredential = await sessionClient.handleChallenge(openChallenge, PER_TICK);
  await sleep(600);

  const openReceipt    = await sessionServer.handleCredential(openChallenge, openCredential);
  txLine("Channel opened", openCredential.depositTxHash!, explorerUrl);
  await sleep(800);
  kv("channel ID:",    openReceipt.channelId);
  await sleep(400);

  const escrow = await tokenBalance(channelContract);
  kv("escrow:",        `${formatUnits(escrow, 6)} USDC locked in XLayerMPPChannel`);
  await sleep(600);
  oracle("Channel open — streaming begins");
  await sleep(400);
  ok("10 USDC in escrow · agent can now stream ticks off-chain");
  await sleep(1500);

  // Price ticks
  step("stream", "Live OKB/USDC price ticks — EIP-712 signatures, zero gas");
  blank();
  await sleep(1000);

  const labels = ["open", "tick 1", "tick 2", "tick 3"];
  for (let i = 1; i <= 3; i++) {
    await sleep(2000);

    const tick = TICKS[i]!;
    const updChallenge  = await sessionServer.createChallenge({
      channelId: openReceipt.channelId,
      amount:    "1",
      asset:     tokenAddress,
    });
    const updCredential = await sessionClient.handleChallenge(updChallenge, PER_TICK);
    const updReceipt    = await sessionServer.handleCredential(updChallenge, updCredential);

    console.log(
      `${C.cyan}  [${labels[i]!}]${C.reset}  ` +
      `OKB/USDC ${C.white}${tick.price}${C.reset}  ` +
      `${C.green}${tick.change}${C.reset}  ` +
      `vol ${C.gray}${tick.vol}${C.reset}  ` +
      `${C.gray}│${C.reset}  ` +
      `seq=${C.cyan}${updReceipt.sequence}${C.reset}  ` +
      `cumulative=${C.yellow}${formatUnits(BigInt(updReceipt.authorizedAmount), 6)} USDC${C.reset}  ` +
      `${C.green}⚡ no tx${C.reset}`
    );
  }

  blank();
  await sleep(600);
  ok("3 ticks streamed — zero on-chain transactions");
  await sleep(1800);

  // Close + settle
  step("settle", "Agent closes session — oracle calls contract.settle() on-chain");
  blank();
  await sleep(1000);
  agent("POST /api/stream/close");
  await sleep(1000);

  const closeChallenge  = await sessionServer.createChallenge({
    channelId: openReceipt.channelId,
    amount:    "0",
    asset:     tokenAddress,
  });
  const closeCredential = await sessionClient.closeChannel(closeChallenge);

  oracle("Final voucher received — broadcasting settle() to XLayerMPPChannel...");
  await sleep(1000);

  const closeReceipt = await sessionServer.handleCredential(closeChallenge, closeCredential);
  txLine("Settlement confirmed", closeReceipt.settleTxHash!, explorerUrl);
  await sleep(1000);

  const settled   = BigInt(closeReceipt.authorizedAmount);
  const deposited = PER_TICK * 10n;
  kv("settled:",   `${formatUnits(settled, 6)} USDC  → oracle`);
  await sleep(500);
  kv("refunded:",  `${formatUnits(deposited - settled, 6)} USDC  → agent`);
  await sleep(1500);

  step("result", "Final balances");
  await sleep(1200);

  const oracleAfterSession = await tokenBalance(serverAccount.address);
  const agentAfterSession  = await tokenBalance(clientAccount.address);
  const escrowAfter        = await tokenBalance(channelContract);

  oracle(`earned:   +${formatUnits(oracleAfterSession - oracleBeforeSession, 6)} USDC  (open + 3 ticks)`);
  await sleep(700);
  agent(`net cost: -${formatUnits(agentBeforeSession - agentAfterSession, 6)} USDC  (6 USDC refunded)`);
  await sleep(700);
  kv("escrow:",    `${formatUnits(escrowAfter, 6)} USDC  (empty — settlement complete)`);

  blank();
  await sleep(1000);
  console.log(`${C.green}${C.bold}  ✅  Scenario 2 complete — 4 ticks · 1 on-chain open · 1 on-chain settle${C.reset}`);
  await sleep(2000);

  // ── Summary ────────────────────────────────────────────────────────────────

  sep();
  blank();
  console.log(`${C.bold}${C.green}  🎉  Demo complete — XLayer ${network.toUpperCase()}${C.reset}`);
  blank();
  await sleep(800);
  console.log(`${C.bold}  What was shown:${C.reset}`);
  blank();
  await sleep(800);
  console.log(`${C.cyan}  Scenario 1 — Pay-per-call (Charge)${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Agent POST /api/signal/OKB-USDC → HTTP 402 → signs USDC transfer${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Oracle broadcasts on-chain, verifies Transfer, unlocks response${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Replay attack blocked by challenge reference${C.reset}`);
  blank();
  await sleep(800);
  console.log(`${C.cyan}  Scenario 2 — Metered stream (Session)${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Agent deposits USDC into XLayerMPPChannel escrow (1 tx)${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    3 price ticks served via EIP-712 vouchers — no gas per tick${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Oracle settles final cumulative amount on-chain (1 tx)${C.reset}`);
  await sleep(500);
  console.log(`${C.gray}    Remainder refunded from escrow to agent automatically${C.reset}`);
  blank();
  await sleep(800);
  kv("Escrow contract:", channelContract);
  await sleep(400);
  kv("Explorer:",        explorerUrl);
  blank();
  sep();
}
