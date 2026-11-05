# Compact proof format

This reference describes the encoding used by Lodestar's existing proof endpoints.
It does not define a consensus protocol requirement for other beacon clients.
For a validator example and historical-state selection, see [Validator proofs](./using-the-api.md).

## Requests and responses

| Method | Route                                   | Root being proved                                   |
| ------ | --------------------------------------- | --------------------------------------------------- |
| `GET`  | `/eth/v0/beacon/proof/state/{state_id}` | `hash_tree_root(BeaconState)`                       |
| `GET`  | `/eth/v0/beacon/proof/block/{block_id}` | `hash_tree_root(BeaconBlock)` without the signature |

Both routes require `format=0x...`, containing the descriptor bytes in hexadecimal.
Despite its name, `format` selects the proof tree, not JSON versus SSZ. Use the
`Accept` header to select `application/json` or `application/octet-stream`.
Omitting `Accept` selects JSON. Responses echo the descriptor bytes.

Use `0x` followed by an even number of hex digits. Lodestar's current request
parser also accepts hex without the prefix; portable clients should emit the
prefixed form. There is no request body or list of generalized indices on the wire.

JSON success responses contain `data.leaves`, `data.descriptor`, and `version`.
Each leaf is exactly 32 bytes, represented by 64 hex digits after `0x`.
The descriptor is a variable-length byte string in the same hex notation.
Both encodings include an `Eth-Consensus-Version` response header. JSON also
includes the version in its body; the SSZ body contains only the proof container.
The version identifies the selected state or block's fork, not the current head's
fork or the proof format version.

There is no serialized `type`, target list, expected root, `execution_optimistic`,
or `finalized` field in this response. The TypeScript client adds
`type: "compactMulti"` after decoding. That property is not part of the protocol.

## Descriptor grammar

Read bytes in order and read each byte from its most significant bit to its least
significant bit. Starting at generalized index `1`, use this grammar:

```text
node = 1              # consume the next supplied 32-byte root
     | 0 node node    # visit left child, then right child
```

A `0` at index `g` expands children `2*g` and `2*g+1`. A `1` stops traversal at
that node. It may represent an entire subtree, not just a basic SSZ value.
Descriptor traversal is preorder; supplied roots follow the terminal nodes from
left to right. Generalized indices must use arbitrary-precision integers.

A complete tree has one more `1` than `0`. Before completion, the number of `1`
bits must not exceed the number of `0` bits. Equivalently, start with one pending
node: consuming a `0` adds one pending node, and consuming a `1` removes one.
The tree ends when the pending count first reaches zero.

After completion, append zero bits only until the next byte boundary. The
descriptor must use the minimum number of bytes: no extra bytes are permitted,
even if they are zero. There is no separate bit-length field or SSZ bitlist
termination bit. An empty descriptor and a descriptor that never completes are
invalid.

If there are `L` supplied roots, there must be exactly `L` terminal bits and
`L - 1` branch bits, for `2*L - 1` meaningful bits. Reject missing roots, extra
roots, non-32-byte roots, nonzero padding, and extra descriptor bytes.

| Expanded tree        | Meaningful bits | Descriptor | Terminal generalized indices |
| -------------------- | --------------- | ---------- | ---------------------------- |
| Root only            | `1`             | `0x80`     | `1`                          |
| Both children        | `011`           | `0x60`     | `2, 3`                       |
| Left child expanded  | `00111`         | `0x38`     | `4, 5, 3`                    |
| Right child expanded | `01011`         | `0x58`     | `2, 6, 7`                    |
| Four grandchildren   | `0011011`       | `0x36`     | `4, 5, 6, 7`                 |

`0x80` is a valid proof containing only the requested object's root. It does not
expose a validator field. `computeDescriptor([])` produces empty bytes and cannot
be used as a root-only proof; use `computeDescriptor([1n])` instead.

### Targets and witnesses

To build a minimal descriptor from requested indices, expand every proper
ancestor of each target. Stop everywhere else. A duplicate target adds nothing.
If both an ancestor and its descendant are requested, expand toward the
descendant and reconstruct the ancestor from its children. Input target ordering
does not affect the descriptor.

The response does not distinguish a target from a witness. For example, requesting
index `4` requires terminal roots at `4`, `5`, and `3`; requesting both `4` and `5`
produces the same tree. The verifier must retain the intended indices separately.

The [SSZ Merkle proof definitions](https://github.com/ethereum/consensus-specs/blob/master/ssz/merkle-proofs.md)
describe generalized indices and proof verification. Their separate index and
witness lists are not the descriptor encoding defined here. In particular, do
not reorder this format's roots into descending generalized-index order.

## Reconstructing and verifying

For a terminal node, use its supplied 32-byte root directly. For a branch, compute
`SHA256(left_root || right_root)` over exactly 64 bytes. Do not hash a terminal
root again, hash hex text, add prefixes, or sort the child roots.

After reconstruction:

1. Compare the reconstructed root with a root authenticated independently by the
   application. A root obtained from the same untrusted proof server is not a
   trust anchor.
2. Check the expected fork and derive the intended generalized indices from that
   fork's SSZ types. A proof contains no SSZ type information.
3. Require each intended node to be supplied or reconstructed from exposed
   children. A proof may contain its ancestor while hiding the requested node.
4. Compare the proven node with the expected value's SSZ root, or decode the
   proven chunk using the correct basic-type packing. Check committed list
   lengths before interpreting an index as an existing element.

These checks are separate from validating the descriptor grammar. A well-formed
tree can prove the wrong object or hide the field the caller intended to verify.
Gloas changes SSZ layouts and generalized indices; it does not add a discriminator
or change this proof encoding.

## SSZ response container

The fields, in order, are:

```text
CompactMultiProof:
  leaves: List[Bytes32, 10000]
  descriptor: ByteList[2048]
```

Both fields have variable length. The first eight bytes contain two unsigned
32-bit little-endian offsets. For `L` roots and `D` descriptor bytes:

| Byte range          | Contents                                       |
| ------------------- | ---------------------------------------------- |
| `0..3`              | `8`, the start of `leaves`                     |
| `4..7`              | `8 + 32*L`, the start of `descriptor`          |
| `8..(8 + 32*L - 1)` | Supplied roots concatenated in traversal order |
| Remaining `D` bytes | Descriptor                                     |

The complete body is `8 + 32*L + D` bytes. There are no count prefixes, proof-type
bytes, fork bytes, or extra tree-root fields. Check offsets, root alignment, and
list bounds before using the descriptor to reconstruct the tree. Decoding the
SSZ container alone does not establish that the descriptor and root count agree.

For a synthetic root consisting of 32 zero bytes, the root-only proof is:

```json
{
  "leaves": ["0x0000000000000000000000000000000000000000000000000000000000000000"],
  "descriptor": "0x80"
}
```

Its SSZ bytes are `08000000 28000000`, then 32 zero bytes, then `80`: 41 bytes
in total. This is an encoding example, not an Ethereum state root.

## Bounds and current errors

The response schema allows at most 10,000 roots and 2,048 descriptor bytes. A
canonical descriptor of at most 2,048 bytes can describe at most 8,192 terminal
nodes. These are proof-tree nodes, not necessarily requested application fields.

The current handlers additionally reject requests when
`descriptor.length / 2 > maxGindicesInProof`. The default is `512`, so the default
descriptor limit is 1,024 bytes. Despite the option's name, this is a byte-based
approximation, not a count of targets. Increasing it does not change the response
schema's bounds or make an otherwise invalid descriptor valid.

The following table records existing v0 behavior, not a standardized error policy:

| Condition                                                    | Current status |
| ------------------------------------------------------------ | -------------- |
| Missing `format`, odd hex length, or invalid hex characters  | `400`          |
| Unsupported `Accept` media type                              | `406`          |
| State or block lookup returns no result                      | `404`          |
| Empty/incomplete descriptor, extra bytes, or nonzero padding | `500`          |
| Handler descriptor-size guard exceeded                       | `500`          |

Historical reconstruction can also throw an error when disabled or when retained
states or blocks are missing. These cases are not all mapped to `404`. Clients
must not retry against a different state such as `head` merely to obtain a proof.
The existing `500` responses for invalid descriptors are an implementation
limitation; consumers should not depend on those classifications remaining fixed.

## Independent reference and vectors

The [fixed vectors](/proofs/compact-proof-vectors.json) contain descriptors, terminal
indices, roots, intended targets, and exact SSZ bytes. The small binary-tree
examples use repeated-byte leaves; the depth-60 example exercises indices above
JavaScript's safe integer range. Fulu/Gloas state and block vectors use the
deterministic fixtures in the proof API tests. They are format conformance data,
not consensus transition vectors or live network roots.

The [reference decoder](https://github.com/ChainSafe/lodestar/blob/unstable/packages/api/test/utils/compactProofReference.ts)
uses Node's SHA-256 implementation without importing an SSZ or Merkle-tree
library. From the repository root with its pinned Node version, run:

```javascript
// Save as check-proof.mjs in the repository root, then run node check-proof.mjs.
import {readFile} from "node:fs/promises";
import {decodeCompactProofSsz, decodeHex, verifyCompactProof} from "./packages/api/test/utils/compactProofReference.ts";

const {vectors} = JSON.parse(await readFile("docs/static/proofs/compact-proof-vectors.json", "utf8"));
const vector = vectors.find(({name}) => name === "left-leaf");
const proof = decodeCompactProofSsz(decodeHex(vector.ssz));
const targets = new Map(vector.expectedTargets.map(({gindex, root}) => [BigInt(gindex), decodeHex(root)]));
verifyCompactProof(proof, decodeHex(vector.expectedRoot), targets);
console.log("Proof root and intended target verified");
```

The expected root in this example comes from a test vector. A real application
must supply its own authenticated root. The reference is an independent test
implementation, not a new public `@lodestar/api` export.

## Standardization

These v0 endpoints remain Lodestar extensions. General SSZ proof verification does
not by itself specify their HTTP paths or compact response encoding. Changes to
the encoding would require explicit versioning and consumer migration.

The proposed [state-leaves endpoint](https://github.com/ethereum/beacon-APIs/pull/664)
is related work: it exposes top-level state field roots. Nested validator and
balance proofs and block proofs require additional proof data. Documenting this
format supports that discussion without claiming beacon-APIs adoption.
