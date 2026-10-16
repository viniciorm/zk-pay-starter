pragma circom 2.1.6;
include "circomlib/circuits/poseidon.circom";

template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;
    component h[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        h[i] = Poseidon(2);
        h[i].inputs[0] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        h[i].inputs[1] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        cur[i + 1] <== h[i].out;
    }
    root <== cur[levels];
}

template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component c = Poseidon(2);
    c.inputs[0] <== nullifier;
    c.inputs[1] <== secret;

    component n = Poseidon(1);
    n.inputs[0] <== nullifier;
    nullifierHash === n.out;

    component m = MerkleProof(levels);
    m.leaf <== c.out;
    for (var i = 0; i < levels; i++) {
        m.pathElements[i] <== pathElements[i];
        m.pathIndices[i] <== pathIndices[i];
    }
    root === m.root;

    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [root, nullifierHash, recipient]} = Withdraw(16);
