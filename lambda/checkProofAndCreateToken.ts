import crypto from "crypto";
import { ethers } from "ethers";
import { getTableName, getTableNameAssetsData } from "../../repos/common-repo";
import { get, put, update } from "../../wrappers/dynamo-db-wrapper";
import { mapRewardToSaref } from "./mapRewardToSaref";
import {
  createRewardEvent,
  createRewardEventHash
} from "./reward-event";
import { Buffer } from "buffer";
// import { UUIDGenerator } from "../../utils/uuid-generator";
// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// const CONTRACT_ADDRESS = "0x0E00f258f573a17452A52c6C5AFAa22c2D121BB3";
const CONTRACT_ADDRESS = "0x05a8F1de04ED8124A8c97d01a9ca195854734497";
// const POLYGON_RPC = "https://rpc-amoy.polygon.technology/";

// Infura connection to Polygon mainnet (Amoy) — requires Infura project ID.
const POLYGON_RPC = "https://polygon-amoy.infura.io/v3/b411fafe56c04aac99d4c30e34b55ff4";
const CUSTOMER_ID = Number(process.env.CUSTOMER_ID ?? 71);

/** Tokens minted per 1% of verified energy improvement (e.g. 11.9% → 23.8 RWD) */
const REWARD_MULTIPLIER = 2;

/** Explicit gas limit for reward() → skips eth_estimateGas RPC round-trip. */
const REWARD_GAS_LIMIT = 250_000n;

/**
 * Cyprus grid carbon intensity — EEA 2023 (gCO₂eq/kWh).
 * TODO Stage 3: replace with live Electricity Maps API call (zone: CY).
 */
const CARBON_INTENSITY_G_PER_KWH = 752;

const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
const wallet = new ethers.Wallet(process.env.MINTER_PK!, provider);
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function reward(address,uint256,bytes32,uint8)",
    "event RewardMinted(bytes32 indexed eventHash,address indexed recipient,uint256 amount,uint8 shareType)"
  ],
  wallet,
);

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface ImpactData {
  energyDelta: number;
  percentChange: number;
  observedValue: number;
  baselineValue: number;
  unit: string;
}

interface RewardSplit {
  totalAmount: string;
  operatorAmount: string;
  modelOwnerAmount: string;
  operatorPercent: string;
  modelOwnerPercent: string;
  totalTokens: number;
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  console.log("event: ",event)
  console.log("proof: ",event.proof)
  // ── Step 1: Verify edge payload (hash + ED25519 signature) ──────────────
  const verifyResult: VerifyResult = await verifyEdgePayload(event);
  if (!verifyResult.ok) {
    console.warn("WARN Payload verification failed:", verifyResult.reason);
    return verifyResult;
  }

  // ── Extract fields ───────────────────────────────────────────────────────
  const edgeId: string = event.edgeId;
  const sourceRecordId: string = event?.proof?.sourceRecord?.sk;
  const operatorWallet: string = event.proof?.wallets?.operatorWallet;
  const modelOwnerWallet: string = event.proof?.wallets?.modelOwnerWallet;
  const impact: ImpactData = event?.proof?.impact ?? ({} as ImpactData);
  const pk = `REWARD_${CUSTOMER_ID}_${edgeId}`;
  const sk = sourceRecordId;

  // ── Step 2: Validate wallet addresses ───────────────────────────────────
  if (!ethers.isAddress(operatorWallet)) {
    console.warn("WARN Invalid operator wallet:", operatorWallet);
    return { ok: false, reason: "INVALID_OPERATOR_WALLET" };
  }
  if (!ethers.isAddress(modelOwnerWallet)) {
    console.warn("WARN Invalid model owner wallet:", modelOwnerWallet);
    return { ok: false, reason: "INVALID_MODEL_OWNER_WALLET" };
  }

  // ── Step 3: Calculate reward split ──────────────────────────────────────
  let rewardSplit: RewardSplit;
  try {
    rewardSplit = calculateRewardSplit(event.proof, impact);
  } catch (err: any) {
    console.error("ERROR [STEP 3] calculateRewardSplit failed:", err.message);
    return { ok: false, reason: err.message };
  }
  const rewardEvent = createRewardEvent({
    edgeId,
    sourceRecordId,
    proofHash: event.hash,
    operatorWallet,
    modelOwnerWallet,
    impact,
    rewardSplit,
    verifiedAt: event.proof.verification.verifiedAt
  });

  const eventHash = createRewardEventHash(rewardEvent);
  // ── Step 4: Idempotency — write PROCESSING record to DynamoDB ───────────
  const now = Date.now();

  const payloadToStore = {
    status: "PROCESSING",
    eventHash,
    eventVersion: 1,
    proofHash: event.hash,
    edgeId,
    sourceRecordId,
    totalAmount: rewardSplit.totalAmount,
    totalTokens: rewardSplit.totalTokens,
    operator: {
      wallet: operatorWallet,
      amount: rewardSplit.operatorAmount,
      percent: rewardSplit.operatorPercent,
    },
    modelOwner: {
      wallet: modelOwnerWallet,
      amount: rewardSplit.modelOwnerAmount,
      percent: rewardSplit.modelOwnerPercent,
    },
    impact: {
      energyDelta: impact.energyDelta ?? null,
      percentChange: impact.percentChange ?? null,
      observedValue: impact.observedValue ?? null,
      baselineValue: impact.baselineValue ?? null,
      unit: impact.unit ?? "kWh",
    },
    verifiedAt: event.proof?.verification?.verifiedAt,
    blockchain: {
      network: "polygon-amoy",
      contractAddress: CONTRACT_ADDRESS,
      tokenSymbol: "RWD",
      eventHash
    }
  };

  try {
    await put({
      TableName: getTableName(),
      Item: {
        pk,
        sk,
        fields: payloadToStore,
        lsi: now.toString(),
        lsi_timestamp: now,
      },
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    });
  } catch (err: any) {
    if (err.code === "ConditionalCheckFailedException") {
      console.warn("WARN [STEP 4] Reward already claimed for sk:", sk);
      return { ok: false, reason: "REWARD_ALREADY_CLAIMED", statusCode: 409 };
    }
    console.error("ERROR [STEP 4] DynamoDB put failed:", err);
    throw err;
  }

  // ── Step 5: Mint ERC-20 tokens ───────────────────────────────────────────
  let operatorTxHash: string;
  let modelOwnerTxHash: string;

  try {
    console.time("Minting both rewards");
    ({ operatorTxHash, modelOwnerTxHash } = await broadcastBothRewards(
      operatorWallet,
      rewardSplit.operatorAmount,
      modelOwnerWallet,
      rewardSplit.modelOwnerAmount,
      eventHash
    ));
    console.timeEnd("Minting both rewards");
  } catch (err: any) {
    console.error("ERROR [STEP 5] Minting failed:", err.message);
    // Mark record as FAILED so it can be investigated / retried
    try {
      await update({
        TableName: getTableName(),
        Key: { pk, sk },
        UpdateExpression:
          "SET #fields.#status = :status, #fields.mintFailedAt = :now, lsi_timestamp = :now",
        ExpressionAttributeNames: { "#fields": "fields", "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "MINT_FAILED",
          ":now": Date.now(),
        },
      });
      console.warn("WARN [STEP 5] Record marked as MINT_FAILED.");
    } catch (updateErr) {
      console.error(
        "ERROR [STEP 5] Failed to mark record MINT_FAILED:",
        updateErr,
      );
    }
    return { ok: false, reason: "MINT_FAILED", detail: err.message };
  }

  const mintedAt = Date.now();

  // ── Step 6: Update DynamoDB record to MINTED ────────────────────────────
  try {
    await update({
      TableName: getTableName(),
      Key: { pk, sk },
      UpdateExpression: `
        SET
          #fields.#status              = :status,
          #fields.#operator.txHash     = :operatorTxHash,
          #fields.#modelOwner.txHash   = :modelOwnerTxHash,
          #fields.mintedAt             = :mintedAt,
          lsi_timestamp                = :mintedAt
      `,
      ExpressionAttributeNames: {
        "#fields": "fields",
        "#status": "status",
        "#operator": "operator",
        "#modelOwner": "modelOwner",
      },
      ExpressionAttributeValues: {
        ":status": "MINTED",
        ":operatorTxHash": operatorTxHash,
        ":modelOwnerTxHash": modelOwnerTxHash,
        ":mintedAt": mintedAt
      },
    });
  } catch (error) {
    // Non-fatal: tokens are confirmed on-chain, DB update can be retried
    console.error(
      "ERROR [STEP 6] Failed to update DynamoDB record to MINTED:",
      error,
    );
  }

  // ── Step 7: Create DPP record ────────────────────────────────────────────
  try {
    await createDpp(sourceRecordId, impact);
  } catch (error) {
    // Non-fatal: reward is complete, DPP failure should not block response
    console.error("ERROR [STEP 7] Failed to create DPP record:", error);
  }

  // ── Step 8: Map to SAREF/JSON-LD ────────────────────────────────────────
  try {
    const sarefRecord = mapRewardToSaref({
      edgeId,
      recommendationId: sourceRecordId,
      operatorWallet,
      modelOwnerWallet,
      operatorTxHash,
      modelOwnerTxHash,
      operatorAmount: rewardSplit.operatorAmount,
      modelOwnerAmount: rewardSplit.modelOwnerAmount,
      operatorPercent: rewardSplit.operatorPercent,
      modelOwnerPercent: rewardSplit.modelOwnerPercent,
      totalAmount: rewardSplit.totalAmount,
      energyDelta: impact.energyDelta ?? 0,
      percentChange: impact.percentChange ?? 0,
      observedValue: impact.observedValue ?? 0,
      mintedAt,
      contractAddress: CONTRACT_ADDRESS,
    });
    console.log('sarefRecord: ', sarefRecord);
  } catch (error) {
    console.error("ERROR [STEP 8] Failed to map SAREF record:", error);
  }
  return {
    ok: true,
    message: "Verified + rewarded",
    operatorTxHash,
    modelOwnerTxHash,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// REWARD SPLIT
// ─────────────────────────────────────────────────────────────────────────────

function calculateRewardSplit(proof: any, impact: ImpactData): RewardSplit {
  const percentChange = Number(impact?.percentChange ?? 0);

  if (!percentChange || percentChange <= 0) {
    throw new Error("NO_REWARDABLE_IMPROVEMENT");
  }

  const operatorPercent = BigInt(proof.reward?.operatorPercentage ?? 70);
  const modelOwnerPercent = BigInt(proof.reward?.modelOwnerPercentage ?? 30);

  if (operatorPercent + modelOwnerPercent !== 100n) {
    throw new Error("INVALID_REWARD_SPLIT");
  }

  // e.g. 11.9% improvement × 2 multiplier = 23.8 RWD total
  const totalTokens = percentChange * REWARD_MULTIPLIER;
  const totalAmount = ethers.parseUnits(totalTokens.toFixed(6), 18);
  const operatorAmount = (totalAmount * operatorPercent) / 100n;
  const modelOwnerAmount = (totalAmount * modelOwnerPercent) / 100n;

  return {
    totalAmount: totalAmount.toString(),
    operatorAmount: operatorAmount.toString(),
    modelOwnerAmount: modelOwnerAmount.toString(),
    operatorPercent: operatorPercent.toString(),
    modelOwnerPercent: modelOwnerPercent.toString(),
    totalTokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MINT
// ─────────────────────────────────────────────────────────────────────────────

async function broadcastBothRewards(
  operatorWallet: string,
  operatorAmount: string,
  modelOwnerWallet: string,
  modelOwnerAmount: string,
  eventHash: string
): Promise<{ operatorTxHash: string; modelOwnerTxHash: string }> {
  const [nonce, feeData] = await Promise.all([
    wallet.getNonce("pending"),
    provider.getFeeData(),
  ]);

  const overrides = {
    gasLimit: REWARD_GAS_LIMIT,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };

  const [operatorReceipt, modelOwnerReceipt] =
    await Promise.all([
      broadcastReward(operatorWallet, operatorAmount, nonce, overrides, eventHash, 0),
      broadcastReward(modelOwnerWallet, modelOwnerAmount, nonce + 1, overrides, eventHash, 1),
    ]);

  return {
    operatorTxHash: operatorReceipt.txHash,
    modelOwnerTxHash: modelOwnerReceipt.txHash
  };
}

async function broadcastReward(
  to: string,
  amount: string,
  nonce: number,
  overrides: Record<string, unknown>,
  eventHash: string,
  shareType: number
): Promise<any> {
  const hashHex = eventHash.startsWith("0x") ? eventHash : `0x${eventHash}`;
  const tx = await contract.reward(to, amount, hashHex, shareType, { ...overrides, nonce });

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("TRANSACTION_NOT_MINED");
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE PAYLOAD VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

async function verifyEdgePayload(payload: any): Promise<VerifyResult> {
  const { proof, hash, signature, edgeId } = payload;

  if (!proof || !hash || !signature || !edgeId) {
    return { ok: false, reason: "INVALID_FORMAT" };
  }

  const recalculatedHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(proof))
    .digest("hex");

  if (recalculatedHash !== hash) {
    return { ok: false, reason: "HASH_MISMATCH" };
  }

  const publicKeyPem = await getPublicKeyForEdge(edgeId);

  if (!publicKeyPem) {
    return { ok: false, reason: "UNKNOWN_EDGE" };
  }

  const isValid = crypto.verify(
    null,
    hash,
    publicKeyPem,
    Buffer.from(signature, "base64"),
  );

  if (!isValid) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC KEY LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

async function getPublicKeyForEdge(edgeId: string): Promise<string | null> {
  const pk = `${edgeId}_${CUSTOMER_ID}`;

  const item: any = await get({
    TableName: getTableName(),
    Key: { pk, sk: edgeId },
  });

  return item?.publicKey ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DPP CREATION
// ─────────────────────────────────────────────────────────────────────────────

async function createDpp(
  sourceRecordId: string,
  impact: ImpactData,
): Promise<void> {
  const dppAssetId = `DPP_${CUSTOMER_ID}`;
  const barcodeAssetId = `Barcode_Dpp_${sourceRecordId}`;
  const timestamp = Date.now();
  const TABLE_NAME = getTableNameAssetsData();

  await Promise.all([
    createDppRecord(dppAssetId, sourceRecordId, timestamp, TABLE_NAME),
    createBarcodeDpp(
      barcodeAssetId,
      sourceRecordId,
      timestamp,
      TABLE_NAME,
      impact,
    ),
  ]);
}

async function createDppRecord(
  asset_id: string,
  main_dpp_id: string,
  timestamp: number,
  TABLE_NAME: string,
): Promise<void> {
  try {
    await put({
      TableName: TABLE_NAME,
      Item: {
        asset_id,
        customer_id: CUSTOMER_ID,
        timestamp,
        val: { main_dpp_id },
      },
    });
  } catch (error) {
    console.error("ERROR createDppRecord:", error);
    throw error;
  }
}

async function createBarcodeDpp(
  barcodeAssetId: string,
  sourceRecordId: string,
  timestamp: number,
  TABLE_NAME: string,
  impact: ImpactData,
): Promise<void> {
  const energyDeltaKwh = impact?.energyDelta ?? 0;

  // gCO₂eq/kWh → kgCO₂ (divide by 1000)
  const co2EmissionKg = Number(
    ((energyDeltaKwh * CARBON_INTENSITY_G_PER_KWH) / 1000).toFixed(4),
  );
  try {
    await put({
      TableName: TABLE_NAME,
      Item: {
        asset_id: barcodeAssetId,
        timestamp,
        customer_id: CUSTOMER_ID,
        val: {
          barcode_type: "1",
          components: [],
          cycle_time: "",
          dpp_check: "1",
          end_time: null,
          graphs: [{ assets: [], isView: true }],
          labels: [],
          main_dpp_id: sourceRecordId,
          product_name: "Halloumi Cheese",
          route: [
            {
              "Milk Production": {
                co2_emission_kg: co2EmissionKg,
                co2_intensity_source: "EEA 2023 — Cyprus grid (752 gCO₂eq/kWh)",
                energy_delta_kwh: energyDeltaKwh,
                date: timestamp,
              },
            },
          ],
          start_time: null,
          telemetries: [],
        },
      },
    });
  } catch (error) {
    console.error("ERROR createBarcodeDpp:", error);
    throw error;
  }
}