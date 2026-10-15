import assert from "node:assert/strict";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {pubkeyCache} from "@chainsafe/lodestar-z/pubkeys";
import {
  CompactMultiProof,
  ProofType,
  SingleProof,
  Tree,
  computeDescriptor,
  concatGindices,
} from "@chainsafe/persistent-merkle-tree";
import {ContainerType} from "@chainsafe/ssz";
import {routes} from "@lodestar/api";
import {createBeaconConfig} from "@lodestar/config";
import {getConfig} from "@lodestar/config/test-utils";
import {ForkName, SLOTS_PER_EPOCH} from "@lodestar/params";
import {BeaconStateView, createCachedBeaconState} from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {hash, toHex} from "@lodestar/utils";
import {getProofApi} from "../../../../../src/api/impl/proof/index.js";
import {defaultApiOptions} from "../../../../../src/api/options.js";
import {SyncState} from "../../../../../src/sync/index.js";
import {ApiTestModules, getApiTestModules} from "../../../../utils/api.js";
import {generateState} from "../../../../utils/state.js";
import {generateProtoBlock} from "../../../../utils/typeGenerator.js";

const config = getConfig(ForkName.gloas, 2);
const forkSlot = 2 * SLOTS_PER_EPOCH;
const validatorIndices = [0, 1, 3, 4, 5, 15];
const validatorType = new ContainerType(ssz.phase0.Validator.fields);

describe("proof API across Gloas", () => {
  let modules: ApiTestModules;
  let api: ReturnType<typeof getProofApi>;
  let headState: BeaconStateView;

  beforeAll(() => {
    headState = createState(forkSlot + SLOTS_PER_EPOCH);
    modules = getApiTestModules({config});
  });

  beforeEach(() => {
    modules.chain.getBlockByRoot.mockReset();
    modules.chain.getHeadState.mockReturnValue(headState);
    modules.forkChoice.getFinalizedBlock.mockReturnValue(generateProtoBlock({slot: headState.slot}));
    Object.defineProperty(modules.chain.clock, "currentSlot", {value: headState.slot});
    Object.defineProperty(modules.sync, "state", {value: SyncState.Synced});
    api = getProofApi(defaultApiOptions, modules);
  });

  for (const [fork, slot] of [
    [ForkName.fulu, forkSlot - 1],
    [ForkName.gloas, forkSlot],
  ] as const) {
    describe(fork, () => {
      let state: BeaconStateView;
      let stateRoot: Uint8Array;
      const stateType = config.getForkTypes(slot).BeaconState;

      beforeAll(() => {
        state = createState(slot);
        stateRoot = stateType.hashTreeRoot(state.toValue());
      });

      for (const source of ["cached", "historical bytes"] as const) {
        describe(source, () => {
          let stateId: string;

          beforeEach(() => {
            stateId = source === "cached" ? toHex(stateRoot) : String(slot);
            modules.chain.getStateByStateRoot = vi.fn().mockResolvedValue({state, executionOptimistic: false});
            modules.chain.getHistoricalStateBySlot = vi.fn().mockResolvedValue({
              state: state.serialize(),
              executionOptimistic: false,
            });
          });

          afterEach(() => {
            if (source === "cached") {
              expect(modules.chain.getStateByStateRoot, `${fork} state root lookup`).toHaveBeenCalledWith(stateId, {
                allowRegen: true,
              });
              expect(modules.chain.getHistoricalStateBySlot, `${fork} cached state`).not.toHaveBeenCalled();
            } else {
              expect(modules.chain.getHistoricalStateBySlot, `${fork} historical slot lookup`).toHaveBeenCalledWith(
                slot
              );
              expect(modules.chain.getStateByStateRoot, `${fork} historical state`).not.toHaveBeenCalled();
            }
          });

          it.each(validatorIndices)("proves validator %i and its withdrawal credentials", async (index) => {
            const validator = state.getValidator(index);
            const validatorGindex = stateType.getPathInfo(["validators", index]).gindex;
            // The optimized Validator type stops path resolution at the record root.
            const credentialsGindex = concatGindices([
              validatorGindex,
              validatorType.getPathInfo(["withdrawalCredentials"]).gindex,
            ]);
            for (const [gindex, expectedLeaf] of [
              [validatorGindex, validatorType.hashTreeRoot(validator)],
              [credentialsGindex, validator.withdrawalCredentials],
            ] as const) {
              const {data, meta} = await api.getStateProof({stateId, descriptor: computeDescriptor([gindex])});
              assert(!(data instanceof Uint8Array));

              expect(meta.version, `proof at ${gindex}`).toBe(fork);
              expectProof(data, stateRoot, [[gindex, expectedLeaf]]);
            }
          });

          it("proves multiple balances across a packed chunk boundary", async () => {
            const indices = [0, 3, 4, 15];
            const gindices = indices.map((index) => stateType.getPathInfo(["balances", index]).gindex);
            expect(gindices[0]).toBe(gindices[1]);
            expect(gindices[1]).not.toBe(gindices[2]);

            const {data, meta} = await api.getStateProof({
              stateId,
              descriptor: computeDescriptor([...new Set(gindices)]),
            });
            expect(meta.version).toBe(fork);
            assert(!(data instanceof Uint8Array));
            const tree = Tree.createFromProof(data);
            expect(tree.root).toEqual(stateRoot);

            for (const [position, index] of indices.entries()) {
              const chunk = new Uint8Array(32);
              const firstIndex = index - (index % 4);
              for (let offset = 0; offset < 4; offset++) {
                new DataView(chunk.buffer).setBigUint64(
                  offset * 8,
                  BigInt(state.getBalance(firstIndex + offset)),
                  true
                );
              }
              expectProof(data, stateRoot, [[gindices[position], chunk]]);
              const leaf = tree.getNode(gindices[position]).root;
              const balance = new DataView(leaf.buffer, leaf.byteOffset, leaf.byteLength).getBigUint64(
                (index % 4) * 8,
                true
              );
              expect(balance, `balance ${index}`).toBe(BigInt(state.getBalance(index)));
            }
          });

          it("proves several validators and the registry length in one request", async () => {
            const targets = validatorIndices.map((index): [bigint, Uint8Array] => [
              stateType.getPathInfo(["validators", index]).gindex,
              validatorType.hashTreeRoot(state.getValidator(index)),
            ]);
            targets.push([
              concatGindices([stateType.getPathInfo(["validators"]).gindex, 3n]),
              ssz.UintNum64.hashTreeRoot(state.validatorCount),
            ]);
            const {data} = await api.getStateProof({
              stateId,
              descriptor: computeDescriptor(targets.map(([gindex]) => gindex)),
            });
            assert(!(data instanceof Uint8Array));
            expectProof(data, stateRoot, targets);
          });

          it("detects tampering and a different expected root", async () => {
            const gindex = stateType.getPathInfo(["validators", 3]).gindex;
            const {data} = await api.getStateProof({stateId, descriptor: computeDescriptor([gindex])});
            assert(!(data instanceof Uint8Array));
            const tampered = {...data, leaves: data.leaves.map((leaf) => Uint8Array.from(leaf))};
            tampered.leaves[0][0] ^= 1;

            expect(Tree.createFromProof(data).root).toEqual(stateRoot);
            expect(Tree.createFromProof(tampered).root).not.toEqual(stateRoot);
            expect(Tree.createFromProof(data).root).not.toEqual(headState.hashTreeRoot());
          });
        });
      }

      it("proves the block state root and fork-specific body fields", async () => {
        const blockType = config.getForkTypes(slot).BeaconBlock;
        const block =
          fork === ForkName.fulu
            ? ssz.fulu.SignedBeaconBlock.defaultValue()
            : ssz.gloas.SignedBeaconBlock.defaultValue();
        block.message.slot = slot;
        block.message.stateRoot = stateRoot;
        block.message.body.graffiti = new Uint8Array(32).fill(0x42);
        const executionBlockHash = new Uint8Array(32).fill(0x83);
        if ("executionPayload" in block.message.body) {
          block.message.body.executionPayload.blockHash = executionBlockHash;
        } else {
          block.message.body.signedExecutionPayloadBid.message.blockHash = executionBlockHash;
        }
        const executionPath =
          fork === ForkName.fulu
            ? ["body", "executionPayload", "blockHash"]
            : ["body", "signedExecutionPayloadBid", "message", "blockHash"];
        const targets: [bigint, Uint8Array][] = [
          [blockType.getPathInfo(["stateRoot"]).gindex, stateRoot],
          [blockType.getPathInfo(["body", "graffiti"]).gindex, block.message.body.graffiti],
          [blockType.getPathInfo(executionPath).gindex, executionBlockHash],
        ];
        const blockRoot = blockType.hashTreeRoot(block.message);
        modules.chain.getBlockByRoot.mockResolvedValue({block, executionOptimistic: false, finalized: true});

        for (const requested of [targets.slice(0, 1), targets]) {
          const {data, meta} = await api.getBlockProof({
            blockId: toHex(blockRoot),
            descriptor: computeDescriptor(requested.map(([gindex]) => gindex)),
          });
          assert(!(data instanceof Uint8Array));
          expect(meta.version, `block proof with ${requested.length} targets`).toBe(fork);
          expectProof(data, blockRoot, requested);
        }
      });
    });
  }
});

function createState(slot: number): BeaconStateView {
  const state = generateState({slot}, config, true);
  state.genesisTime = 0;
  for (let index = 0; index < state.validators.length; index++) {
    state.validators.get(index).withdrawalCredentials = new Uint8Array(32).fill(index + 1);
    state.balances.set(index, 32_000_000_000 + index);
  }
  state.commit();
  return new BeaconStateView(
    createCachedBeaconState(state, {config: createBeaconConfig(config, state.genesisValidatorsRoot), pubkeyCache})
  );
}

function expectProof(proof: CompactMultiProof, expectedRoot: Uint8Array, targets: [bigint, Uint8Array][]): void {
  const proofType = routes.proof.CompactMultiProofType;
  for (const [format, decoded] of [
    ["json", proofType.fromJson(proofType.toJson(proof))],
    ["ssz", proofType.deserialize(proofType.serialize(proof))],
  ] as const) {
    expect(Tree.createFromProof({...decoded, type: ProofType.compactMulti}).root, `${format} proof root`).toEqual(
      expectedRoot
    );
  }
  const tree = Tree.createFromProof(proof);
  expect(tree.root, "reconstructed root").toEqual(expectedRoot);
  for (const [gindex, expectedLeaf] of targets) {
    const single = tree.getProof({type: ProofType.single, gindex}) as SingleProof;
    expect(single.leaf, `leaf at ${gindex}`).toEqual(expectedLeaf);
    let index = gindex;
    let root = expectedLeaf;
    for (const witness of single.witnesses) {
      root = index % 2n === 0n ? hash(root, witness) : hash(witness, root);
      index >>= 1n;
    }
    expect(index, `branch depth at ${gindex}`).toBe(1n);
    expect(root, `single proof at ${gindex}`).toEqual(expectedRoot);
  }
}
