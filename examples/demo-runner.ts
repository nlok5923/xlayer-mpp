/**
 * Shared demo runner for @xlayer/mpp.
 * Called by demo-mainnet.ts and demo-testnet.ts with network-specific config.
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  generatePrivateKey,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  network:         XLayerNetwork;
  chain:           Chain;
  rpcUrl:          string;
  explorerUrl:     string;
  serverKey:       Hex;
  /** Pre-deployed contract address. If not provided, the script deploys it. */
  channelContract?: Address;
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
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

function step(n: number | string, msg: string) {
  console.log(`\n${C.bold}${C.blue}  [${n}]${C.reset} ${C.white}${msg}${C.reset}`);
}

function ok(msg: string)   { console.log(`${C.green}      ✓  ${msg}${C.reset}`); }
function info(msg: string) { console.log(`${C.gray}      →  ${msg}${C.reset}`); }
function warn(msg: string) { console.log(`${C.yellow}      ⚠  ${msg}${C.reset}`); }

function kv(key: string, val: string) {
  console.log(`${C.gray}      ${key.padEnd(22)}${C.reset}${C.cyan}${val}${C.reset}`);
}

function txLine(label: string, hash: string, explorerUrl: string) {
  console.log(`${C.yellow}      ⛓  ${label}${C.reset}`);
  console.log(`${C.gray}         hash:     ${C.reset}${hash}`);
  console.log(`${C.gray}         explorer: ${C.reset}${explorerUrl}/tx/${hash}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  console.log(`${C.bold}${C.cyan}       @xlayer/mpp — Machine Payments Protocol Demo${C.reset}`);
  console.log(`${C.bold}${C.cyan}       HTTP 402 · EIP-712 · On-chain escrow · ${network.toUpperCase()}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"═".repeat(68)}${C.reset}`);
  blank();

  // ── Setup ──────────────────────────────────────────────────────────────────

  header("SETUP");

  step("network", `Connecting to XLayer ${network}`);
  await sleep(500);

  const block = await publicClient.getBlockNumber();
  kv("Network:",  `${network} (Chain ID ${chain.id})`);
  kv("RPC:",      rpcUrl);
  kv("Block:",    String(block));
  ok("Connected");
  await sleep(600);

  // Generate fresh client wallet for this demo session
  step("wallets", "Generating demo wallets");
  await sleep(400);

  const clientKey     = generatePrivateKey();
  const clientAccount = privateKeyToAccount(clientKey);
  const clientWallet  = createWalletClient({ account: clientAccount, chain, transport: http(rpcUrl) });

  kv("Server:", serverAccount.address);
  kv("Client:", clientAccount.address);

  const serverOKB = await publicClient.getBalance({ address: serverAccount.address });
  kv("Server OKB:", `${formatUnits(serverOKB, 18)} OKB`);

  if (serverOKB === 0n) {
    warn(`Server wallet has no OKB. Fund ${serverAccount.address} with OKB on ${network} and retry.`);
    process.exit(1);
  }
  ok("Wallets ready");
  await sleep(600);

  // Fund client with OKB for gas
  step("fund", "Sending OKB to client wallet for gas fees");
  await sleep(400);

  const fundHash = await serverWallet.sendTransaction({
    account: serverAccount,
    to:      clientAccount.address,
    value:   parseUnits("0.0015", 18),
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  txLine("OKB transfer", fundHash, explorerUrl);
  ok("Client funded with 0.0015 OKB");
  await sleep(600);

  // Deploy MockERC20
  step("token", "Deploying MockERC20 demo token (mints 100 tokens to client)");
  await sleep(400);

  const tokenSupply = parseUnits("100", 6);
  const mockArtifact = loadArtifact("MockERC20");
  const mockAbi      = mockArtifact.abi as Parameters<typeof serverWallet.deployContract>[0]["abi"];
  const mockBytecode = mockArtifact.bytecode.object as Hex;

  const mockDeployHash = await serverWallet.deployContract({
    abi: mockAbi, bytecode: mockBytecode, args: [clientAccount.address, tokenSupply],
  });
  const mockReceipt = await publicClient.waitForTransactionReceipt({ hash: mockDeployHash });
  const tokenAddress = mockReceipt.contractAddress!;

  txLine("MockERC20 deployed", mockDeployHash, explorerUrl);
  kv("Token address:", tokenAddress);
  kv("Client balance:", `${formatUnits(tokenSupply, 6)} mUSDC`);
  ok("Demo token ready");
  await sleep(600);

  // Deploy or use existing XLayerMPPChannel
  let channelContract = cfg.channelContract;
  if (!channelContract) {
    step("contract", "Deploying XLayerMPPChannel escrow contract");
    await sleep(400);
    info("Compiling with via-ir optimizer...");

    const chanArtifact = loadArtifact("XLayerMPPChannel");
    const chanAbi      = chanArtifact.abi as Parameters<typeof serverWallet.deployContract>[0]["abi"];
    const chanBytecode = chanArtifact.bytecode.object as Hex;

    const chanDeployHash = await serverWallet.deployContract({
      abi: chanAbi, bytecode: chanBytecode, args: [],
    });
    const chanReceipt = await publicClient.waitForTransactionReceipt({ hash: chanDeployHash });
    channelContract   = chanReceipt.contractAddress!;

    txLine("XLayerMPPChannel deployed", chanDeployHash, explorerUrl);
    kv("Contract address:", channelContract);
    ok("Payment channel contract live");
    await sleep(600);
  } else {
    step("contract", "Using pre-deployed XLayerMPPChannel");
    kv("Contract address:", channelContract);
    ok("Ready");
    await sleep(400);
  }

  const tokenBalance = async (account: Address) =>
    publicClient.readContract({
      address: tokenAddress,
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view",
               inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;

  // ── CHARGE FLOW ────────────────────────────────────────────────────────────

  header("PAYMENT METHOD 1 — Charge (pay per request)");
  info("Each API call issues HTTP 402. Client signs a transfer, server broadcasts.");
  info("No API keys. No subscriptions. Payment IS the authentication.");
  blank();

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

  step(1, "Server issues HTTP 402 challenge");
  await sleep(700);

  const chargeChallenge = await chargeServer.createChallenge({
    amount:      "1",
    currency:    "USDC",
    recipient:   serverAccount.address,
    description: "Access to /api/generate",
  });
  chargeChallenge.methodDetails.tokenAddress = tokenAddress;

  kv("amount:",     "1 mUSDC");
  kv("recipient:",  serverAccount.address);
  kv("reference:",  chargeChallenge.methodDetails.reference);
  ok("402 challenge issued");
  await sleep(600);

  step(2, "Client signs transfer (does NOT broadcast — server pays gas)");
  await sleep(700);

  const serverBefore   = await tokenBalance(serverAccount.address);
  const clientBefore   = await tokenBalance(clientAccount.address);

  const chargeCredential = await chargeClient.handleChallenge(chargeChallenge);
  ok(`Signed tx: ${chargeCredential.transaction.slice(0, 34)}...`);
  await sleep(500);

  step(3, "Server broadcasts & verifies Transfer event on-chain");
  await sleep(700);

  const chargeReceipt = await chargeServer.handleCredential(chargeChallenge, chargeCredential);
  txLine("Payment confirmed", chargeReceipt.txHash, explorerUrl);
  ok(`Block: ${chargeReceipt.blockNumber}`);
  await sleep(500);

  step(4, "Balance verification");
  await sleep(500);

  const serverAfterCharge = await tokenBalance(serverAccount.address);
  const clientAfterCharge = await tokenBalance(clientAccount.address);

  kv("Server received:", `+${formatUnits(serverAfterCharge - serverBefore, 6)} mUSDC`);
  kv("Client spent:",    `-${formatUnits(clientBefore - clientAfterCharge, 6)} mUSDC`);

  step(5, "Replay protection — same credential rejected");
  await sleep(700);

  try {
    await chargeServer.handleCredential(chargeChallenge, chargeCredential);
    warn("BUG: replay accepted!");
  } catch {
    ok("Duplicate credential correctly rejected");
  }

  blank();
  console.log(`${C.green}${C.bold}  ✅  Charge flow complete${C.reset}`);
  await sleep(1000);

  // ── SESSION FLOW ───────────────────────────────────────────────────────────

  header("PAYMENT METHOD 2 — Session (metered / streaming)");
  info("Open a channel once (on-chain deposit). Every request = EIP-712 signature.");
  info("Zero gas per request. Server settles with final voucher at end.");
  blank();

  const sessionStore  = createMemoryStore();
  const PER_REQ       = parseUnits("1", 6);

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

  const serverBeforeSession = await tokenBalance(serverAccount.address);
  const clientBeforeSession = await tokenBalance(clientAccount.address);

  // Open
  step("open", "Client opens payment channel — deposits 10 mUSDC into escrow");
  info(`XLayerMPPChannel: ${channelContract}`);
  await sleep(700);

  const openChallenge  = await sessionServer.createChallenge({ amount: "1", asset: tokenAddress });
  const openCredential = await sessionClient.handleChallenge(openChallenge, PER_REQ);
  info("Broadcasting approve() + open()...");
  await sleep(400);

  const openReceipt = await sessionServer.handleCredential(openChallenge, openCredential);
  txLine("Channel opened (open tx)", openCredential.depositTxHash!, explorerUrl);
  kv("Channel ID:", openReceipt.channelId);

  const escrowBalance = await tokenBalance(channelContract);
  kv("Escrow balance:", `${formatUnits(escrowBalance, 6)} mUSDC locked in contract`);
  ok("Channel open — funds are in escrow");
  await sleep(700);

  // Update requests
  step("update", "3 API requests served — off-chain EIP-712 only, zero gas");
  blank();

  for (let i = 1; i <= 3; i++) {
    await sleep(600);
    const updChallenge  = await sessionServer.createChallenge({
      channelId: openReceipt.channelId,
      amount:    "1",
      asset:     tokenAddress,
    });
    const updCredential = await sessionClient.handleChallenge(updChallenge, PER_REQ);
    const updReceipt    = await sessionServer.handleCredential(updChallenge, updCredential);

    console.log(
      `${C.gray}      Request ${i}${C.reset}  ` +
      `seq=${C.cyan}${updReceipt.sequence}${C.reset}  ` +
      `cumulative=${C.yellow}${formatUnits(BigInt(updReceipt.authorizedAmount), 6)} mUSDC${C.reset}  ` +
      `${C.green}⚡ no tx${C.reset}`
    );
  }

  blank();
  ok("3 requests served — zero on-chain transactions");
  await sleep(700);

  // Close + settle
  step("close", "Client closes — server calls contract.settle() on-chain");
  await sleep(700);

  const closeChallenge  = await sessionServer.createChallenge({
    channelId: openReceipt.channelId,
    amount:    "0",
    asset:     tokenAddress,
  });
  const closeCredential = await sessionClient.closeChannel(closeChallenge);
  info("Server broadcasting settle()...");
  await sleep(400);

  const closeReceipt = await sessionServer.handleCredential(closeChallenge, closeCredential);
  txLine("Settlement confirmed", closeReceipt.settleTxHash!, explorerUrl);
  kv("Settled amount:", `${formatUnits(BigInt(closeReceipt.authorizedAmount), 6)} mUSDC`);
  await sleep(600);

  // Final balances
  step("result", "Final balance check");
  await sleep(500);

  const serverAfterSession = await tokenBalance(serverAccount.address);
  const clientAfterSession = await tokenBalance(clientAccount.address);
  const escrowAfter        = await tokenBalance(channelContract);

  kv("Server earned:",   `+${formatUnits(serverAfterSession - serverBeforeSession, 6)} mUSDC (4 × 1 mUSDC)`);
  kv("Client net cost:", `-${formatUnits(clientBeforeSession - clientAfterSession, 6)} mUSDC (6 refunded)`);
  kv("Escrow balance:",  `${formatUnits(escrowAfter, 6)} mUSDC (empty after settle)`);

  blank();
  console.log(`${C.green}${C.bold}  ✅  Session flow complete${C.reset}`);
  await sleep(500);

  // ── Summary ────────────────────────────────────────────────────────────────

  sep();
  blank();
  console.log(`${C.bold}${C.green}  🎉  ALL FLOWS COMPLETE — XLayer ${network.toUpperCase()}${C.reset}`);
  blank();
  console.log(`${C.bold}  What was demonstrated:${C.reset}`);
  console.log(`${C.gray}  ① Charge  — HTTP 402 → client signs → server broadcasts & verifies${C.reset}`);
  console.log(`${C.gray}              Replay protection via challenge reference${C.reset}`);
  console.log(`${C.gray}  ② Session — USDC deposited to XLayerMPPChannel escrow (1 on-chain tx)${C.reset}`);
  console.log(`${C.gray}              3 requests served with EIP-712 signatures — no gas per call${C.reset}`);
  console.log(`${C.gray}              Server calls settle() → funds distributed from escrow${C.reset}`);
  blank();
  kv("Channel contract:", channelContract);
  kv("Explorer:",         explorerUrl);
  blank();
  sep();
}
