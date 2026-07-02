# BYOM-EDGE — Edge-Verified Data-Driven Green Emissions Tokens

**O-CEI Programme | Challenge P5C3 | The Data Cooks B.V.**

> ⚠️ **This repository is provided for code review and verification purposes only, as part of the O-CEI Stage 2 Technical Report submission. The codebase is not intended to be deployed directly from this repository — it requires private infrastructure credentials, certificates, and environment configuration that are not included here for security reasons.**

---

## Overview

BYOM-EDGE implements a **Measure → Verify → Reward** pipeline that connects AI-driven sustainability recommendations to cryptographically verified, blockchain-recorded token rewards. The system is deployed across a Cloud-Edge-IoT (CEI) architecture consisting of:

- An **edge gateway** running Node-RED (VE-01)
- A **cloud Lambda function** handling verification and ERC-20 token minting (VE-02)
- An **AWS IoT Core MQTT broker** connecting edge and cloud layers

This repository contains the core source code artefacts delivered during Stage 2 (Development of CEI Utilities, April–June 2026) as referenced in TPI2 of the Stage 2 Technical Report.

---

## Repository Structure

```
byom-edge/
│
├── nodered-flows/
│   ├── asset_data_pipeline.json        # Tab c9a2b2a2 — Hourly energy REST API ingestion,
│   │                                   # normalisation, 7-day rolling cache, MQTT publish
│   └── vre_verification_only.json      # Tab 618d7734 — ED25519 init, recommendation routing,
│                                       # rule execution, proof assembly, signing, offline queue
│
├── lambda/
│   └── checkProofAndCreateToken.ts     # AWS Lambda handler — SHA256 + ED25519 verification,
│                                       # reward split calculation, idempotent ERC-20 minting,
│                                       # DPP record creation
│
├── docker/
│   └── docker-compose.yml             # Docker Compose configuration for the edge runtime
│
└── README.md
```

---

## Component Descriptions

### 1. Node-RED Flows (`nodered-flows/`)

The edge layer is implemented as two Node-RED tabs running on an edge gateway.

#### `asset_data_pipeline.json` — Asset Data Pipeline
- Polls the Pilot 5 hourly energy REST API every 3,600 seconds
- Normalises raw sensor rows (`energy_kwh`, ISO 8601 timestamps) into a standardised sample format
- Writes normalised samples to a 7-day rolling in-memory cache (`assetSamples:{assetId}`)
- Publishes DynamoDB-compatible backend records to AWS IoT Core MQTT topic `ocei_data/demo`
- **Note:** The REST endpoint, API key, and asset mapping are configured per deployment environment

#### `vre_verification_only.json` — VRE Verification Only
- Manages ED25519 key pair generation/loading at startup and registers the public key with the cloud backend
- Subscribes to AI recommendations via MQTT topic `vre/71/recommendations`
- Holds future-dated recommendations in a local pending queue (`/data/pending/pending_recommendations.json`)
- Executes configurable aggregation pipelines (REMOVE_NULLS, AVG, FILTER, etc.) against cached sensor samples
- Evaluates success criteria rules (PERCENT_DECREASE_FROM_BASELINE, ABSOLUTE, RANGE, etc.)
- Assembles a structured proof object, computes SHA-256 hash, and signs with ED25519 private key
- Publishes signed payload to MQTT topic `ocei/demo` with offline queue and 30-second retry fallback

#### Running the flows locally
To inspect the flows in Node-RED:
1. Install Node-RED: `npm install -g --unsafe-perm node-red`
2. Start Node-RED: `node-red`
3. Open `http://localhost:1880`
4. Go to **Menu → Import** and import either JSON file
5. The flows will render visually but **will not execute** without the required MQTT broker certificates and environment configuration

---

### 2. Lambda Handler (`lambda/checkProofAndCreateToken.ts`)

AWS Lambda function (Node.js/TypeScript) deployed in `eu-central-1`.

**Responsibilities:**
1. **Payload verification** — Recomputes SHA-256 hash of received proof, retrieves registered ED25519 public key from DynamoDB, verifies signature via `crypto.verify()`
2. **Reward split calculation** — Filters passed  rules, sums `comparisonActualValue` to determine total reward, applies according to operator/model-owner split using BigInt arithmetic
3. **Idempotency** — DynamoDB conditional write (`attribute_not_exists`) prevents duplicate minting on retry
4. **ERC-20 minting** — Issues two sequential `reward(address, amount)` transactions to the deployed smart contract on Polygon Amoy testnet via Ethers.js v6
5. **DPP creation** — Creates a Digital Product Passport record with the verified energy reduction (`absoluteReduction`) and CO₂ emission calculation

**Smart contract:** `0x0E00f258f573a17452A52c6C5AFAa22c2D121BB3` (Polygon Amoy testnet)

**Required environment variables (not included):**
```
MINTER_PK          # Polygon wallet private key for the minting wallet
AWS_REGION         # eu-central-1
DYNAMODB_TABLE     # DynamoDB table name
```

---

### 3. Docker Compose (`docker/docker-compose.yml`)

Defines the containerised edge runtime environment. The edge gateway runs Node-RED inside Docker with:
- Persistent volume mounts for ED25519 keys (`/data/keys/`), pending queues (`/data/pending/`, `/data/queue/`)
- AWS IoT Core TLS certificates (mounted at runtime, not included in this repository)
- Network configuration for MQTT connectivity

---

## Infrastructure Not Included in This Repository

The following are required for deployment but are intentionally excluded:

| Component | Reason excluded |
|---|---|
| AWS IoT Core TLS certificates (`.pem` files) | Security — device credentials |
| MQTT broker endpoint credentials | Security — infrastructure access |
| DynamoDB table names and ARNs | Environment-specific configuration |
| Polygon wallet private key (`MINTER_PK`) | Security — blockchain credentials |
| Serverless Framework deployment config (`serverless.yml`) | Contains environment-specific endpoints |

---

## Architecture Overview

```
IoT Layer          Edge Layer (VE-01)              Cloud Layer (VE-02)
─────────          ──────────────────              ───────────────────
Pilot 5       →   Asset Data Pipeline   →(cache)→  VRE Verification
REST API           (normalise + cache)              (rule execution)
                                                        ↓
BYOM AI       →   VRE Verification     →(MQTT)→   Lambda Handler
Model              (verify + sign)      ocei/demo   (verify + mint)
                                                        ↓
                                                   Polygon Amoy
                                                   ERC-20 Token
```

---

## Stage 2 TPI Coverage

This codebase directly evidences the following Stage 2 Technical Performance Indicators:

| TPI | Evidence in this repository |
|---|---|
| TPI1 — Edge latency < 100 ms | `vre_verification_only.json` — ⏱ Start Timer / End Timer nodes measure in-memory pipeline latency (observed: 3 ms) |
| TPI2 — 100% edge features implemented | Both Node-RED flows covering T3.1–T3.5: ingestion, validation, signing, queuing, key provisioning |
| TPI3 — Pilot 5 mock data integration | `asset_data_pipeline.json` — normalisation pipeline validated against mock hourly energy dataset |
| TPI4 — Cloud DLT minting < 850 ms | `checkProofAndCreateToken.ts` — three-step verification + BigInt reward split + idempotent Polygon minting |
| TPI5 — AI infrastructure integration | `vre_verification_only.json` — MQTT subscription, schema-driven rule execution, multi-rule fan-out |

---

## Contact

**The Data Cooks B.V.**
O-CEI Programme | Challenge P5C3 — Ledger Tokenization for Incentivization & Added Value

Access credentials for this private repository are available upon request to the O-CEI project coordination team.

