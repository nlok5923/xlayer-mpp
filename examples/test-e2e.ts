/**
 * End-to-end test for @xlayer/mpp against a local Anvil node.
 *
 * Prerequisites:
 *   1. Install Foundry:  curl -L https://foundry.paradigm.xyz | bash && foundryup
 *   2. Compile the mock:  forge build --contracts contracts/ --out artifacts/
 *   3. Start Anvil:       anvil
 *   4. Run this script:   npx ts-node --esm examples/test-e2e.ts
 *
 * Anvil starts with 10 pre-funded accounts (10 000 ETH each).
 * We use account[0] as the server signer and account[1] as the client.
 */

import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
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

// ─── Anvil config ─────────────────────────────────────────────────────────────

const ANVIL_RPC   = "http://localhost:8545";
const ANVIL_CHAIN_ID = 31337;

// Anvil's well-known pre-funded accounts
const SERVER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const CLIENT_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const serverAccount = privateKeyToAccount(SERVER_PRIVATE_KEY);
const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);

const anvilChain = {
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
const testClient   = createTestClient({ chain: anvilChain, transport: http(ANVIL_RPC), mode: "anvil" });

const serverWallet = createWalletClient({ account: serverAccount, chain: anvilChain, transport: http(ANVIL_RPC) });
const clientWallet = createWalletClient({ account: clientAccount, chain: anvilChain, transport: http(ANVIL_RPC) });

// ─── Load compiled MockERC20 artifact ─────────────────────────────────────────

function loadArtifact(name: string) {
  const path = resolve(`artifacts/${name}.sol/${name}.json`);
  const raw  = readFileSync(path, "utf-8");
  return JSON.parse(raw) as { abi: unknown[]; bytecode: { object: string } };
}

// ─── Deploy MockERC20 ─────────────────────────────────────────────────────────

async function deployMockERC20(mintTo: Address, supply: bigint): Promise<Address> {
  const artifact = loadArtifact("MockERC20");
  const abi      = artifact.abi as Parameters<typeof serverWallet.deployContract>[0]["abi"];
  const bytecode = artifact.bytecode.object as Hex;

  const hash = await serverWallet.deployContract({
    abi,
    bytecode,
    args: [mintTo, supply],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress!;
  console.log(`  MockERC20 deployed at ${address}`);
  return address;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function getTokenBalance(token: Address, account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view",
             inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}

// ─── Test: Charge flow ────────────────────────────────────────────────────────

async function testChargeFlow(tokenAddress: Address) {
  console.log("\n── Charge flow ──────────────────────────────────────────────────");

  const store = createMemoryStore();

  // Server: override network to "mainnet" shape but point RPC at Anvil
  const server = new XLayerChargeServer({
    signerPrivateKey: SERVER_PRIVATE_KEY,
    store,
    network: "mainnet", // only used for chain shape — RPC is overridden below
    rpcUrl: ANVIL_RPC,
  });

  const client = new XLayerChargeClient({
    walletClient: clientWallet,
    network: "mainnet",
    rpcUrl: ANVIL_RPC,
  });

  const payAmount = parseUnits("1", 6); // 1 mUSDC

  // 1. Server issues challenge
  const challenge = await server.createChallenge({
    amount: "1",          // 1 token (6 decimals)
    currency: "USDC",
    recipient: serverAccount.address,
  });
  // Override tokenAddress to our locally deployed mock
  challenge.methodDetails.tokenAddress = tokenAddress;

  console.log(`  Challenge ref: ${challenge.methodDetails.reference}`);

  const serverBalanceBefore = await getTokenBalance(tokenAddress, serverAccount.address);
  const clientBalanceBefore = await getTokenBalance(tokenAddress, clientAccount.address);

  // 2. Client signs (does NOT broadcast)
  const credential = await client.handleChallenge(challenge);
  console.log(`  Signed tx (first 20 chars): ${credential.transaction.slice(0, 20)}...`);

  // 3. Server broadcasts + verifies
  const receipt = await server.handleCredential(challenge, credential);
  console.log(`  Receipt txHash: ${receipt.txHash}`);

  const serverBalanceAfter = await getTokenBalance(tokenAddress, serverAccount.address);
  const clientBalanceAfter = await getTokenBalance(tokenAddress, clientAccount.address);

  assert(serverBalanceAfter === serverBalanceBefore + payAmount, "server received payment");
  assert(clientBalanceAfter === clientBalanceBefore - payAmount, "client balance decreased");

  // 4. Replay protection: sending the same credential again must fail
  try {
    await server.handleCredential(challenge, credential);
    assert(false, "replay should have been rejected");
  } catch {
    assert(true, "replay correctly rejected");
  }
}

// ─── Test: Session flow ───────────────────────────────────────────────────────

async function testSessionFlow(tokenAddress: Address) {
  console.log("\n── Session flow ─────────────────────────────────────────────────");

  const store = createMemoryStore();

  const server = new XLayerSessionServer({
    recipient: serverAccount.address,
    acceptedAssets: [tokenAddress],
    network: "mainnet",
    store,
  });

  const client = new XLayerSessionClient({
    walletClient: clientWallet,
    network: "mainnet",
    rpcUrl: ANVIL_RPC,
    autoOpen: true,
    autoTopup: false,
  });

  const depositAmount = parseUnits("10", 6); // 10 mUSDC deposit
  const perRequest    = parseUnits("1", 6);  // 1 mUSDC per request

  const serverBalanceBefore = await getTokenBalance(tokenAddress, serverAccount.address);

  // ── Open ────────────────────────────────────────────────────────────────────

  const openChallenge = await server.createChallenge({ amount: "1" /* per-request */, asset: tokenAddress });

  const openCredential = await client.handleChallenge(openChallenge, depositAmount);
  assert(openCredential.action === "open", "first credential is open");

  const openReceipt = await server.handleCredential(openChallenge, openCredential);
  console.log(`  Channel opened: ${openReceipt.channelId}`);
  assert(!!openReceipt.channelId, "channel ID returned");

  // ── Update (3 requests) ──────────────────────────────────────────────────

  for (let i = 1; i <= 3; i++) {
    const updateChallenge = await server.createChallenge({
      channelId: openReceipt.channelId,
      amount: "1",
      asset: tokenAddress,
    });

    const updateCredential = await client.handleChallenge(updateChallenge, perRequest);
    assert(updateCredential.action === "update", `request ${i} is update`);

    const updateReceipt = await server.handleCredential(updateChallenge, updateCredential);
    assert(updateReceipt.sequence === i, `sequence is ${i}`);
    console.log(`  Request ${i}: authorizedAmount = ${formatUnits(BigInt(updateReceipt.authorizedAmount), 6)} mUSDC`);
  }

  // ── Close ────────────────────────────────────────────────────────────────

  const closeChallenge = await server.createChallenge({
    channelId: openReceipt.channelId,
    amount: "0",
    asset: tokenAddress,
  });

  const closeCredential = await client.closeChannel(closeChallenge);
  assert(closeCredential.action === "close", "close credential action");

  const closeReceipt = await server.handleCredential(closeChallenge, closeCredential);
  console.log(`  Channel closed. Final authorizedAmount: ${formatUnits(BigInt(closeReceipt.authorizedAmount), 6)} mUSDC`);

  assert(closeReceipt.authorizedAmount === (perRequest * 3n).toString(), "total authorized = 3 mUSDC");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== @xlayer/mpp end-to-end test (Anvil) ===\n");
  console.log(`Server: ${serverAccount.address}`);
  console.log(`Client: ${clientAccount.address}`);

  // Check Anvil is running
  try {
    await publicClient.getBlockNumber();
  } catch {
    console.error("\nAnvil is not running. Start it with: anvil");
    process.exit(1);
  }

  // Deploy mock token — mint 1000 mUSDC to client
  console.log("\n── Deploy MockERC20 ──────────────────────────────────────────────");
  const supply = parseUnits("1000", 6);
  const tokenAddress = await deployMockERC20(clientAccount.address, supply);
  const clientBalance = await getTokenBalance(tokenAddress, clientAccount.address);
  assert(clientBalance === supply, `client holds ${formatUnits(supply, 6)} mUSDC`);

  await testChargeFlow(tokenAddress);
  await testSessionFlow(tokenAddress);

  console.log("\n✓ All tests passed\n");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err);
  process.exit(1);
});
